/**
 * PC6 through the API: subgroup numbers on samples, SPC charts read live from the measurements (only
 * compatible data, exclusions counted), trial limits vs saved baselines (supersession, history,
 * provisional), rule switches, the plan's signal reaction, and permissions.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('f');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};

const OD = [0, 0.01, -0.01, 0, 0.01, -0.01, 0, 0.01, -0.01, 0, 0.01, -0.01, 0, 0.01, -0.01, 0, 0.01, 0.049].map((d) => (25 + d).toFixed(3));
const BORE = [
  ['10.00', '10.02', '9.98'], ['10.01', '10.00', '9.99'], ['9.98', '10.00', '10.02'],
  ['10.02', '10.01', '10.03'], ['9.99', '10.00', '10.01'], ['10.00', '9.97', '10.03'],
].flat();

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-spc');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  const fam = (await api().post('/api/v1/part-families').set(h).send({ code: 'HCR', name: 'Rods' }).expect(201)).body;
  const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'HCR-100', name: 'Rod 100', partFamilyId: fam.id, initialRevision: { revision: 'A' } }).expect(201)).body;
  ctx.part = part.id;
  await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/release`).set(h).expect(200);
  const plan = (await api().post('/api/v1/control-plans').set(h).send({ planCode: 'CP-1', title: 'Rods', partFamilyId: fam.id }).expect(201)).body;
  const planRev = plan.revisions[0].id;
  const rev = (await api().post(`/api/v1/control-plan-revisions/${planRev}/operations`).set(h).send({ operationCode: 'OP-020', name: 'Turning' }).expect(201)).body;
  const op = rev.operations[0].id;
  await api().post(`/api/v1/control-plan-revisions/${planRev}/characteristics`).set(h).send({
    operationId: op, characteristicKey: 'OD', name: 'Outer diameter', nominal: 25, lowerLimit: 24.95, upperLimit: 25.05, unitCode: 'mm',
    criticality: 'major', spcEligible: true, chartType: 'imr', subgroupSize: 1, sampling: [{ triggerType: 'first_off', sampleSize: 18 }],
  }).expect(201);
  await api().post(`/api/v1/control-plan-revisions/${planRev}/characteristics`).set(h).send({
    operationId: op, characteristicKey: 'BORE', name: 'Bore', nominal: 10, lowerLimit: 9.9, upperLimit: 10.1, unitCode: 'mm',
    criticality: 'major', spcEligible: true, chartType: 'xbar_r', subgroupSize: 3, sampling: [{ triggerType: 'first_off', sampleSize: 18 }],
    reactions: [{ triggerType: 'spc_signal', action: 'notify', instruction: 'Tell the quality engineer; do not adjust the machine yet' }],
  }).expect(201);
  await api().patch(`/api/v1/control-plan-revisions/${planRev}`).set(h).send({ changeReason: 'First' }).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${planRev}/transitions`).set(h).send({ action: 'submit' }).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${planRev}/transitions`).set(h).send({ action: 'approve' }).expect(200);
  const rec = (await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: ctx.part, lot: 'LOT-1', triggerType: 'first_off' }).expect(201)).body;
  ctx.rec = rec.id;
  ctx.od = rec.requirements.find((q: { characteristicKey: string }) => q.characteristicKey === 'OD').id;
  ctx.bore = rec.requirements.find((q: { characteristicKey: string }) => q.characteristicKey === 'BORE').id;
  for (let i = 0; i < 18; i++) {
    await api().post(`/api/v1/inspections/${ctx.rec}/samples`).set(h).send({ readings: [{ requirementId: ctx.od, valueNumeric: OD[i] }, { requirementId: ctx.bore, valueNumeric: BORE[i] }] }).expect(201);
  }
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const chart = async (query: string, user = ids.ownerA) => api().get(`/api/v1/spc/chart?partId=${ctx.part}&${query}`).set(await as(user));

describe('subgroups', () => {
  it('groups three samples per subgroup and lets the operator start a new one', async () => {
    const h = await as(ids.ownerA);
    const detail = (await api().get(`/api/v1/inspections/${ctx.rec}`).set(h).expect(200)).body;
    expect(detail.samples.slice(0, 7).map((s: { subgroupNumber: number }) => s.subgroupNumber)).toEqual([1, 1, 1, 2, 2, 2, 3]);
    const rec2 = (await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: ctx.part, triggerType: 'first_off' }).expect(201)).body;
    ctx.rec2 = rec2.id;
    const idOf = (key: string) => rec2.requirements.find((q: { characteristicKey: string }) => q.characteristicKey === key).id;
    const reading = [{ requirementId: idOf('OD'), valueNumeric: '25.000' }, { requirementId: idOf('BORE'), valueNumeric: '10.000' }];
    await api().post(`/api/v1/inspections/${rec2.id}/samples`).set(h).send({ readings: reading }).expect(201);
    const second = (await api().post(`/api/v1/inspections/${rec2.id}/samples`).set(h).send({ newSubgroup: true, readings: reading }).expect(201)).body;
    expect(second.samples.map((s: { subgroupNumber: number }) => s.subgroupNumber)).toEqual([1, 2]);
  });
});

describe('characteristics and charts', () => {
  it('lists the characteristics of a part that can be charted', async () => {
    const res = await api().get(`/api/v1/spc/characteristics?partId=${ctx.part}`).set(await as(ids.ownerA)).expect(200);
    expect(res.body).toMatchObject([
      { key: 'BORE', operationCode: 'OP-020', chartType: 'xbar_r', subgroupSize: 3, unitCode: 'mm', readings: 20, hasBaseline: false },
      { key: 'OD', operationCode: 'OP-020', chartType: 'imr', subgroupSize: 1, unitCode: 'mm', readings: 20, hasBaseline: false },
    ]);
  });

  it('I-MR: trial limits from the points shown, provisional, spec kept apart, a point beyond 3σ flagged', async () => {
    const res = (await chart('characteristicKey=OD&operationCode=OP-020&rules=we1').then((r) => (expect(r.status).toBe(200), r))).body;
    expect(res.characteristic).toMatchObject({ key: 'OD', chartType: 'imr', unitCode: 'mm' });
    expect(res.spec).toEqual({ nominal: 25, lower: 24.95, upper: 25.05 });
    expect(res.limitsSource).toBe('trial');
    expect(res.provisional).toBe(true);
    expect(res.warnings.join(' ')).toMatch(/Trial limits/);
    // 18 points from inspection 1 + 2 from the second (in progress): all charted.
    expect(res.points).toHaveLength(20);
    expect(res.points[0]).toMatchObject({ value: 25, dispersion: null });
    expect(res.points[1].dispersion).toBeCloseTo(0.01, 6);
    expect(res.limits.ucl).toBeGreaterThan(res.limits.centre);
    // Control limits are not the specification: they come from the data.
    expect(res.limits.ucl).not.toBe(res.spec.upper);
    expect(res.signals.some((s: { rule: string; index: number }) => s.rule === 'we1' && s.index === 17)).toBe(true);
    expect(res.signals.every((s: { rule: string }) => s.rule === 'we1')).toBe(true);
    // No reaction is defined for OD; each rule can be turned off.
    expect(res.reactions).toEqual([]);
    const none = (await chart('characteristicKey=OD&operationCode=OP-020&rules=')).body;
    expect(none.signals).toEqual([]);
    expect(none.rules).toEqual([]);
  });

  it('X-bar/R: complete subgroups only, with the plan’s signal reaction shown', async () => {
    const res = (await chart('characteristicKey=BORE&operationCode=OP-020')).body;
    expect(res.characteristic).toMatchObject({ chartType: 'xbar_r', subgroupSize: 3 });
    expect(res.points).toHaveLength(6);
    expect(res.points[0]).toMatchObject({ value: 10, dispersion: expect.closeTo(0.04, 6) });
    expect(res.points[0].readings).toHaveLength(3);
    expect(res.reactions).toEqual([{ action: 'notify', instruction: 'Tell the quality engineer; do not adjust the machine yet' }]);
    // The second inspection's two samples are in different subgroups, so neither is complete.
    expect(res.excluded).toMatchObject([{ reason: 'incomplete_subgroup', count: 2 }]);
  });

  it('asks for an operation when it is ambiguous, and 404s for an unknown part or nothing charted', async () => {
    const h = await as(ids.ownerA);
    await api().get(`/api/v1/spc/chart?partId=${ctx.part}&characteristicKey=NOPE`).set(h).expect(404);
    await api().get(`/api/v1/spc/chart?partId=00000000-0000-0000-0000-000000000000&characteristicKey=OD`).set(h).expect(404);
    await api().get(`/api/v1/spc/chart?partId=${ctx.part}`).set(h).expect(400);
  });

  it('counts abandoned inspections as excluded, not charted', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/inspections/${ctx.rec2}/abandon`).set(h).send({ reason: 'Wrong part loaded' }).expect(200);
    const res = (await chart('characteristicKey=OD&operationCode=OP-020')).body;
    expect(res.points).toHaveLength(18);
    expect(res.excluded).toMatchObject([{ reason: 'abandoned', count: 2 }]);
  });

  it('filters by lot', async () => {
    expect((await chart('characteristicKey=OD&operationCode=OP-020&lot=LOT-1')).body.points).toHaveLength(18);
    expect((await chart('characteristicKey=OD&operationCode=OP-020&lot=NOPE')).body.points).toEqual([]);
  });
});

describe('baselines', () => {
  const body = (extra: Record<string, unknown> = {}) => ({ partId: ctx.part, characteristicKey: 'OD', operationCode: 'OP-020', ...extra });

  it('needs spc.manage and enough data; validates the window', async () => {
    const owner = await as(ids.ownerA);
    await api().post('/api/v1/spc/baselines').set(await as(ids.inspectorA)).send(body({ firstN: 10 })).expect(403);
    await api().post('/api/v1/spc/baselines').set(owner).send(body({ firstN: 3 })).expect(400);
    await api().post('/api/v1/spc/baselines').set(owner).send(body({ firstN: 10, from: '2020-01-01T00:00:00Z' })).expect(400);
    const empty = await api().post('/api/v1/spc/baselines').set(owner).send(body({ from: '2099-01-01T00:00:00Z' })).expect(409);
    expect(empty.body.error.code).toBe('spc_rule');
    expect(empty.body.error.message).toMatch(/at least 5 readings/);
    await api().post('/api/v1/spc/baselines').set(owner).send(body({ rules: ['we9'] })).expect(400);
    await api().post('/api/v1/spc/baselines').set(owner).send({ ...body(), partId: '00000000-0000-0000-0000-000000000000' }).expect(404);
  });

  it('saves limits from the first points, which then replace trial limits on the chart', async () => {
    const owner = await as(ids.ownerA);
    const saved = (await api().post('/api/v1/spc/baselines').set(owner).send(body({ firstN: 12, rules: ['we1', 'we4'], notes: 'Stable run' })).expect(201)).body;
    expect(saved).toMatchObject({ chartType: 'imr', subgroupSize: 1, unitCode: 'mm', points: 12, provisional: true, rules: ['we1', 'we4'], notes: 'Stable run', supersededBy: null, createdBy: { id: ids.ownerA } });
    expect(saved.spec).toEqual({ nominal: 25, lower: 24.95, upper: 25.05 });
    expect(saved.limits.ucl).toBeGreaterThan(saved.limits.centre);
    ctx.b1 = saved.id;
    const res = (await chart('characteristicKey=OD&operationCode=OP-020&rules=we1')).body;
    expect(res.limitsSource).toBe('baseline');
    // Without a rules parameter the chart uses the rules saved with the baseline.
    expect((await chart('characteristicKey=OD&operationCode=OP-020')).body.rules).toEqual(['we1', 'we4']);
    expect(res.baseline.id).toBe(saved.id);
    expect(res.limits).toEqual(saved.limits);
    expect(res.signals.some((s: { index: number }) => s.index === 17)).toBe(true);
    expect((await api().get(`/api/v1/spc/characteristics?partId=${ctx.part}`).set(owner).expect(200)).body.find((c: { key: string }) => c.key === 'OD').hasBaseline).toBe(true);
  });

  it('a new baseline supersedes the old one, which stays in the history', async () => {
    const owner = await as(ids.ownerA);
    const second = (await api().post('/api/v1/spc/baselines').set(owner).send(body({})).expect(201)).body;
    expect(second.points).toBe(18);
    const history = (await api().get(`/api/v1/spc/baselines?partId=${ctx.part}&characteristicKey=OD`).set(await as(ids.inspectorA)).expect(200)).body;
    expect(history.map((b: { id: string }) => b.id)).toEqual([second.id, ctx.b1]);
    expect(history[1]).toMatchObject({ supersededBy: second.id, supersededAt: expect.any(String) });
    expect(history[0].supersededAt).toBeNull();
    expect((await chart('characteristicKey=OD&operationCode=OP-020')).body.baseline.id).toBe(second.id);
  });

  it('X-bar/R baselines count subgroups and are provisional below 20', async () => {
    const saved = (await api().post('/api/v1/spc/baselines').set(await as(ids.ownerA)).send({ partId: ctx.part, characteristicKey: 'BORE', operationCode: 'OP-020' }).expect(201)).body;
    expect(saved).toMatchObject({ chartType: 'xbar_r', subgroupSize: 3, points: 6, provisional: true });
    expect(saved.limits.dispersionLcl).toBe(0);
  });

  it('is tenant-scoped: another organisation cannot see the part, charts or baselines', async () => {
    const other = await as(ids.ownerB, ids.orgB);
    await api().get(`/api/v1/spc/chart?partId=${ctx.part}&characteristicKey=OD`).set(other).expect(404);
    await api().get(`/api/v1/spc/baselines?partId=${ctx.part}&characteristicKey=OD`).set(other).expect(404);
    await api().post('/api/v1/spc/baselines').set(other).send(body()).expect(404);
  });
});
