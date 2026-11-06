/**
 * PC11 through the API: recording a sample that puts a point beyond the control limits raises an alert (once), the
 * alert is listed, notifies others, and is acknowledged with a note by someone with spc.manage.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a5');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const OD = ['25.000', '25.004', '24.996', '25.002', '24.998', '25.003', '24.997', '25.001', '25.000', '24.999', '25.002', '24.998'];

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-alerts');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  const fam = (await api().post('/api/v1/part-families').set(h).send({ code: 'HCR', name: 'Rods' }).expect(201)).body;
  const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'HCR-100', name: 'Rod 100', partFamilyId: fam.id, initialRevision: { revision: 'A' } }).expect(201)).body;
  ctx.part = part.id;
  await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/release`).set(h).expect(200);
  const plan = (await api().post('/api/v1/control-plans').set(h).send({ planCode: 'CP-1', title: 'Rods', partFamilyId: fam.id }).expect(201)).body;
  const planRev = plan.revisions[0].id;
  const rev = (await api().post(`/api/v1/control-plan-revisions/${planRev}/operations`).set(h).send({ operationCode: 'OP-020', name: 'Turning' }).expect(201)).body;
  const sampling = [{ triggerType: 'first_off', sampleSize: 20 }];
  await api().post(`/api/v1/control-plan-revisions/${planRev}/characteristics`).set(h).send({
    operationId: rev.operations[0].id, characteristicKey: 'OD', name: 'Outer diameter', nominal: 25, lowerLimit: 24.95, upperLimit: 25.05, unitCode: 'mm',
    criticality: 'major', spcEligible: true, chartType: 'imr', subgroupSize: 1, sampling,
  }).expect(201);
  await api().patch(`/api/v1/control-plan-revisions/${planRev}`).set(h).send({ changeReason: 'First' }).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${planRev}/transitions`).set(h).send({ action: 'submit' }).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${planRev}/transitions`).set(h).send({ action: 'approve' }).expect(200);
  // A baseline from the first twelve readings so the limits are fixed (otherwise a trial limit would absorb the spike).
  const rec = (await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: ctx.part, triggerType: 'first_off' }).expect(201)).body;
  ctx.rec = rec.id;
  ctx.od = rec.requirements[0].id;
  for (const v of OD) await api().post(`/api/v1/inspections/${rec.id}/samples`).set(h).send({ readings: [{ requirementId: ctx.od, valueNumeric: v }] }).expect(201);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const alerts = async (query = '', user = ids.ownerA) => (await api().get(`/api/v1/spc/alerts${query}`).set(await as(user)).expect(200)).body;
const sample = async (value: string, user = ids.inspectorA) =>
  api().post(`/api/v1/inspections/${ctx.rec}/samples`).set(await as(user)).send({ readings: [{ requirementId: ctx.od, valueNumeric: value }] });

describe('raising alerts', () => {
  it('raises none while the process is quiet (no baseline yet: trial limits absorb nothing unusual)', async () => {
    expect((await alerts()).data).toEqual([]);
  });

  it('a point beyond 3σ raises an alert when it is recorded, by an inspector without spc.manage', async () => {
    await api().post('/api/v1/spc/baselines').set(await as(ids.ownerA)).send({ partId: ctx.part, characteristicKey: 'OD', operationCode: 'OP-020', rules: ['we1'] }).expect(201);
    const res = await sample('25.040');
    expect(res.status).toBe(201);
    // The spike is a point beyond 3σ and, on the moving-range chart, a range above its limit: two alerts for one point.
    const list = await alerts();
    expect(list.data.map((a: { rule: string }) => a.rule).sort()).toEqual(['range', 'we1']);
    const we1 = list.data.find((a: { rule: string }) => a.rule === 'we1');
    expect(we1).toMatchObject({
      part: { id: ctx.part, partNumber: 'HCR-100' },
      characteristicKey: 'OD',
      characteristicName: 'Outer diameter',
      operationCode: 'OP-020',
      variant: 'imr',
      side: 'above',
      status: 'open',
      inspection: { id: ctx.rec },
      note: null,
    });
    expect(we1.summary).toMatch(/^Rule 1: One point beyond 3σ/);
    expect(list.data.find((a: { rule: string }) => a.rule === 'range').summary).toMatch(/Moving range above its upper limit/);
    ctx.alert = we1.id;
  });

  it('never raises the same point twice; the next point, back in control, has a large range from the spike and says so once', async () => {
    expect((await sample('25.001')).status).toBe(201);
    const list = await alerts();
    expect(list.openCount).toBe(3);
    expect(list.data.filter((a: { rule: string }) => a.rule === 'we1')).toHaveLength(1);
  });

  it('a second spike below raises a rule 1 alert on the low side', async () => {
    expect((await sample('24.960')).status).toBe(201);
    const list = await alerts();
    expect(list.openCount).toBe(5);
    expect(list.data.filter((a: { rule: string; side: string }) => a.rule === 'we1').map((a: { side: string }) => a.side).sort()).toEqual(['above', 'below']);
  });

  it('notifies those who manage SPC, but not whoever recorded the reading', async () => {
    const owner = (await api().get('/api/v1/notifications').set(await as(ids.ownerA)).expect(200)).body;
    const list = (owner.data ?? owner.items ?? owner) as { title: string; body: string | null }[];
    expect(list.some((n) => n.title === 'SPC alert raised' && /HCR-100 — Outer diameter — Rule 1/.test(n.body ?? ''))).toBe(true);
    const inspector = (await api().get('/api/v1/notifications').set(await as(ids.inspectorA)).expect(200)).body;
    const theirs = (inspector.data ?? inspector.items ?? inspector) as { title: string }[];
    expect(theirs.some((n) => n.title === 'SPC alert raised')).toBe(false);
  });
});

describe('acknowledging', () => {
  it('needs spc.manage and a note, works once, and keeps who and why', async () => {
    const url = `/api/v1/spc/alerts/${ctx.alert}/acknowledge`;
    await api().post(url).set(await as(ids.inspectorA)).send({ note: 'Looked' }).expect(403);
    await api().post(url).set(await as(ids.ownerA)).send({ note: '   ' }).expect(400);
    const done = (await api().post(url).set(await as(ids.ownerA)).send({ note: 'Tool changed; rechecked the next part' }).expect(200)).body;
    expect(done).toMatchObject({ status: 'acknowledged', note: 'Tool changed; rechecked the next part', acknowledgedBy: { id: ids.ownerA } });
    expect((await api().post(url).set(await as(ids.ownerA)).send({ note: 'Again' })).status).toBe(409);
    expect((await alerts()).openCount).toBe(4);
    expect((await alerts('?status=acknowledged')).data.map((a: { id: string }) => a.id)).toEqual([ctx.alert]);
    expect((await alerts('?status=all')).data).toHaveLength(5);
    expect((await alerts(`?partId=${ctx.part}&status=acknowledged`)).data).toHaveLength(1);
  });

  it('is tenant-scoped', async () => {
    const other = await as(ids.ownerB, ids.orgB);
    expect((await api().get('/api/v1/spc/alerts?status=all').set(other).expect(200)).body).toEqual({ data: [], openCount: 0 });
    await api().post(`/api/v1/spc/alerts/${ctx.alert}/acknowledge`).set(other).send({ note: 'Hijacked' }).expect(404);
  });
});
