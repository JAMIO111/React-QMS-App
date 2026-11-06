/**
 * The process control dashboard through the API: plan pipeline (awaiting approval, no effective revision),
 * inspection activity and in-progress list, failures still needing an acknowledgement or NC, SPC signals
 * from the latest readings, access and tenancy.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a1');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const range = () => {
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 86_400_000);
  return `from=${from.toISOString().slice(0, 10)}&to=${to.toISOString().slice(0, 10)}`;
};
const OD = [0, 0.004, -0.004, 0.002, -0.002, 0.005, -0.005, 0.003, -0.003, 0.004, -0.004, 0.045, 0.06].map((d) => (25 + d).toFixed(3));

const planWith = async (h: Record<string, string>, code: string, famCode: string, key: string, name: string, spc: boolean) => {
  const fam = (await api().post('/api/v1/part-families').set(h).send({ code: famCode, name: famCode }).expect(201)).body;
  const plan = (await api().post('/api/v1/control-plans').set(h).send({ planCode: code, title: code, partFamilyId: fam.id }).expect(201)).body;
  const rev = plan.revisions[0].id;
  const op = (await api().post(`/api/v1/control-plan-revisions/${rev}/operations`).set(h).send({ operationCode: 'OP-020', name: 'Turning' }).expect(201)).body.operations[0].id;
  await api().post(`/api/v1/control-plan-revisions/${rev}/characteristics`).set(h).send({
    operationId: op, characteristicKey: key, name, nominal: 25, lowerLimit: 24.95, upperLimit: 25.05, unitCode: 'mm', criticality: 'major',
    ...(spc ? { spcEligible: true, chartType: 'imr', subgroupSize: 1, sampling: [{ triggerType: 'first_off', sampleSize: 13 }] } : {}),
  }).expect(201);
  await api().patch(`/api/v1/control-plan-revisions/${rev}`).set(h).send({ changeReason: 'First' }).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${rev}/transitions`).set(h).send({ action: 'submit' }).expect(200);
  return { fam, plan, rev };
};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pcd');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  const a = await planWith(h, 'CP-1', 'HCR', 'OD', 'Outer diameter', true);
  const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'HCR-100', name: 'Rod 100', partFamilyId: a.fam.id, initialRevision: { revision: 'A' } }).expect(201)).body;
  ctx.part = part.id;
  await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/release`).set(h).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${a.rev}/transitions`).set(h).send({ action: 'approve' }).expect(200);
  await planWith(h, 'CP-2', 'SHAFT', 'LEN', 'Length', false); // stays awaiting approval
  const rec = (await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: ctx.part, lot: 'LOT-1', triggerType: 'first_off' }).expect(201)).body;
  ctx.rec = rec.id;
  const od = rec.requirements[0].id;
  for (const v of OD) await api().post(`/api/v1/inspections/${rec.id}/samples`).set(h).send({ readings: [{ requirementId: od, valueNumeric: v }] }).expect(201);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const get = async (user = ids.ownerA, org = ids.orgA) => api().get(`/api/v1/process-control-dashboard?${range()}`).set(await as(user, org));

describe('process control dashboard', () => {
  it('summarises plans, inspections and open failures', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.kpis).toMatchObject({ awaitingApproval: 1, effectivePlans: 1, plansWithoutEffective: 1, inspections: 1, inProgress: 1, openFailures: 1 });
    expect(res.body.kpis.firstPassRate).toBeNull(); // nothing completed yet
    expect(res.body.revisionsByStatus).toEqual(expect.arrayContaining([{ key: 'pending_approval', label: 'Awaiting approval', count: 1 }, { key: 'effective', label: 'Effective', count: 1 }]));
    expect(res.body.planAttention).toMatchObject([{ kind: 'awaiting_approval', planCode: 'CP-2', revisionCode: 'A' }]);
    expect(res.body.openFailures).toMatchObject([{ reference: expect.stringMatching(/^IPI-/), partNumber: 'HCR-100', characteristic: 'Outer diameter', value: '25.060 mm', limits: '24.95 to 25.05 mm' }]);
    expect(res.body.failuresByCharacteristic).toEqual([{ key: 'OD', label: 'Outer diameter', count: 1 }]);
    expect(res.body.inspectionsByPeriod.reduce((t: number, b: { inProgress: number }) => t + b.inProgress, 0)).toBe(1);
    expect(res.body.inProgress).toMatchObject([{ reference: res.body.openFailures[0].reference, partNumber: 'HCR-100', samples: 13 }]);
  });

  it('lists SPC signals from the latest readings, newest first', async () => {
    const { spc } = (await get()).body;
    expect(spc).toMatchObject({ available: true, windowDays: 30, monitored: 1, withSignals: 1, withoutBaseline: 1 });
    expect(spc.signalCount).toBeGreaterThanOrEqual(2);
    expect(spc.recent[0]).toMatchObject({ partNumber: 'HCR-100', characteristicKey: 'OD', operationCode: 'OP-020' });
    expect(spc.recent.map((s: { rule: string }) => s.rule)).toEqual(expect.arrayContaining(['we1']));
    expect(spc.byRule.find((r: { rule: string }) => r.rule === 'we1').count).toBeGreaterThanOrEqual(2);
    const times = spc.recent.map((s: { at: string }) => s.at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('counts the failure as handled once it is acknowledged', async () => {
    const h = await as(ids.ownerA);
    const rec = (await api().get(`/api/v1/inspections/${ctx.rec}`).set(h).expect(200)).body;
    const failed = rec.measurements.find((m: { result: string }) => m.result === 'fail');
    await api().post(`/api/v1/inspection-measurements/${failed.id}/acknowledge`).set(h).send({ note: 'Tool changed' }).expect(201);
    const res = await get();
    expect(res.body.kpis.openFailures).toBe(0);
    expect(res.body.openFailures).toEqual([]);
    expect(res.body.failuresByCharacteristic).toHaveLength(1); // still a failure in the period
  });

  it('shows pass rate once an inspection is completed', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/inspections/${ctx.rec}/complete`).set(h).expect(200);
    const res = await get();
    expect(res.body.kpis).toMatchObject({ inProgress: 0, firstPassRate: 0 }); // completed with result fail
    expect(res.body.inspectionsByPeriod.reduce((t: number, b: { fail: number }) => t + b.fail, 0)).toBe(1);
  });

  it('validates the period and is tenant-scoped', async () => {
    const h = await as(ids.ownerA);
    await api().get('/api/v1/process-control-dashboard?from=2026-02-01&to=2026-01-01').set(h).expect(400);
    await api().get('/api/v1/process-control-dashboard').set(h).expect(400);
    const other = await get(ids.ownerB, ids.orgB);
    expect(other.status).toBe(200);
    expect(other.body.kpis).toMatchObject({ awaitingApproval: 0, effectivePlans: 0, inspections: 0, openFailures: 0 });
    expect(other.body.spc).toMatchObject({ monitored: 0, signalCount: 0 });
    expect(JSON.stringify(other.body)).not.toContain('HCR-100');
  });

  it('is readable by viewers', async () => {
    expect((await get(ids.dual)).status).toBe(200);
  });
});
