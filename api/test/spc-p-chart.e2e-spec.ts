/**
 * PC7 through the API: a pass/fail characteristic marked for a P chart; the chart by inspection, day or lot;
 * trial limits per subgroup size, a saved baseline (p̄, its subgroup basis), what is left out, and the plan rules.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a2');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const FAILS = [1, 2, 1, 0, 2, 9]; // failures per inspection of 20 checks
const LOTS = ['LOT-A', 'LOT-A', 'LOT-A', 'LOT-B', 'LOT-B', undefined];

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pchart');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  const fam = (await api().post('/api/v1/part-families').set(h).send({ code: 'HCR', name: 'Rods' }).expect(201)).body;
  const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'HCR-100', name: 'Rod 100', partFamilyId: fam.id, initialRevision: { revision: 'A' } }).expect(201)).body;
  ctx.part = part.id;
  await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/release`).set(h).expect(200);
  const plan = (await api().post('/api/v1/control-plans').set(h).send({ planCode: 'CP-1', title: 'Rods', partFamilyId: fam.id }).expect(201)).body;
  ctx.planRev = plan.revisions[0].id;
  const rev = (await api().post(`/api/v1/control-plan-revisions/${ctx.planRev}/operations`).set(h).send({ operationCode: 'OP-020', name: 'Turning' }).expect(201)).body;
  ctx.op = rev.operations[0].id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('marking a pass/fail check for a P chart', () => {
  it('turns SPC on for an attribute check with chart type P and no subgroup size; refuses it for a measured one', async () => {
    const h = await as(ids.ownerA);
    const add = (body: object) => api().post(`/api/v1/control-plan-revisions/${ctx.planRev}/characteristics`).set(h).send({ operationId: ctx.op, ...body });
    // Whatever chart type or size is sent, an attribute check can only be a P chart and has no fixed subgroup size.
    const created = (await add({ characteristicKey: 'VISUAL', name: 'No chatter marks', dataType: 'attribute', spcEligible: true, chartType: 'imr', subgroupSize: 5, criticality: 'minor', sampling: [{ triggerType: 'first_off', sampleSize: 20 }] }).expect(201)).body;
    const visual = created.operations.flatMap((o: { characteristics: { characteristicKey: string }[] }) => o.characteristics).find((c: { characteristicKey: string }) => c.characteristicKey === 'VISUAL');
    expect(visual).toMatchObject({ dataType: 'attribute', spcEligible: true, chartType: 'p', subgroupSize: null });
    const bad = await add({ characteristicKey: 'OD', name: 'Outer diameter', nominal: 25, lowerLimit: 24.95, upperLimit: 25.05, unitCode: 'mm', spcEligible: true, chartType: 'p' });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(bad.body)).toMatch(/P chart is for pass\/fail checks/);
    await api().patch(`/api/v1/control-plan-revisions/${ctx.planRev}`).set(h).send({ changeReason: 'First' }).expect(200);
    await api().post(`/api/v1/control-plan-revisions/${ctx.planRev}/transitions`).set(h).send({ action: 'submit' }).expect(200);
    await api().post(`/api/v1/control-plan-revisions/${ctx.planRev}/transitions`).set(h).send({ action: 'approve' }).expect(200);
  });
});

describe('P chart data', () => {
  it('records pass/fail inspections', async () => {
    const h = await as(ids.ownerA);
    for (let i = 0; i < FAILS.length; i++) {
      const rec = (await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: ctx.part, lot: LOTS[i], workOrder: `WO-${i}`, triggerType: 'first_off' }).expect(201)).body;
      const req = rec.requirements[0].id;
      for (let s = 0; s < 20; s++) {
        await api().post(`/api/v1/inspections/${rec.id}/samples`).set(h).send({ readings: [{ requirementId: req, valuePass: s >= FAILS[i] }] }).expect(201);
      }
    }
    const list = (await api().get(`/api/v1/spc/characteristics?partId=${ctx.part}`).set(h).expect(200)).body;
    expect(list).toMatchObject([{ key: 'VISUAL', chartType: 'p', subgroupSize: null, unitCode: null, readings: 120, hasBaseline: false }]);
  });

  const chart = async (query = '') => (await api().get(`/api/v1/spc/chart?partId=${ctx.part}&characteristicKey=VISUAL&operationCode=OP-020${query}`).set(await as(ids.ownerA)).expect(200)).body;

  it('by inspection (the default): n and failures per subgroup, trial limits for each size, a spike flagged', async () => {
    const c = await chart();
    expect(c.characteristic).toMatchObject({ chartType: 'p', subgroupSize: null });
    expect(c.points.map((p: { n: number; failed: number }) => [p.n, p.failed])).toEqual(FAILS.map((d) => [20, d]));
    expect(c.points[5]).toMatchObject({ value: 0.45, dispersion: null });
    expect(c.limitsSource).toBe('trial');
    expect(c.provisional).toBe(true);
    expect(c.limits.centre).toBeCloseTo(15 / 120, 10);
    expect(c.limits.dispersionUcl).toBeNull();
    // Each point has its own limits: UCL = p̄ + 3·√(p̄(1−p̄)/20), LCL clipped at 0.
    const centre = 15 / 120;
    expect(c.points[0].ucl).toBeCloseTo(centre + 3 * Math.sqrt((centre * (1 - centre)) / 20), 8);
    expect(c.points[0].lcl).toBe(0);
    expect(c.signals.some((s: { rule: string; index: number }) => s.rule === 'we1' && s.index === 5)).toBe(true);
    expect(c.subgroup).toMatchObject({ basis: 'inspection', meanSize: 20, reliable: false }); // 2.5 failures expected per 20 checks
    expect(c.warnings.join(' ')).toMatch(/too few for the limits to be reliable/);
    expect(c.spec).toEqual({ nominal: null, lower: null, upper: null });
    expect(c.excluded).toEqual([]);
  });

  it('by day: every check was recorded today, so one subgroup and no limits yet', async () => {
    const c = await chart('&subgroup=day');
    expect(c.points).toHaveLength(1);
    expect(c.points[0]).toMatchObject({ n: 120, failed: 15 });
    expect(c.limitsSource).toBe('none');
    expect(c.warnings.join(' ')).toMatch(/At least 5 subgroups/);
  });

  it('by lot: pools inspections of a lot and counts the checks without a lot as left out', async () => {
    const c = await chart('&subgroup=lot');
    expect(c.points.map((p: { n: number; failed: number; lot: string }) => [p.lot, p.n, p.failed])).toEqual([['LOT-A', 60, 4], ['LOT-B', 40, 2]]);
    expect(c.excluded).toEqual([expect.objectContaining({ reason: 'no_lot', count: 20 })]);
  });

  it('refuses a baseline with too few subgroups, then saves one from the first five inspections', async () => {
    const owner = await as(ids.ownerA);
    const body = { partId: ctx.part, characteristicKey: 'VISUAL', operationCode: 'OP-020' };
    const few = await api().post('/api/v1/spc/baselines').set(owner).send({ ...body, subgroup: 'lot' }).expect(409);
    expect(few.body.error.code).toBe('spc_rule');
    expect(few.body.error.message).toMatch(/at least 5 subgroups \(one lot each\); the chosen window has 2/);
    await api().post('/api/v1/spc/baselines').set(await as(ids.inspectorA)).send({ ...body, firstN: 5 }).expect(403);
    const saved = (await api().post('/api/v1/spc/baselines').set(owner).send({ ...body, firstN: 5, rules: ['we1'], notes: 'First five inspections' }).expect(201)).body;
    expect(saved).toMatchObject({ chartType: 'p', subgroupSize: null, subgroupBasis: 'inspection', meanSubgroupSize: 20, points: 5, provisional: true, rules: ['we1'], spec: { nominal: null, lower: null, upper: null } });
    expect(saved.limits.centre).toBeCloseTo(6 / 100, 10);
    expect(saved.limits.dispersionCentre).toBeNull();
    ctx.baseline = saved.id;
  });

  it('uses the baseline’s p̄, its saved rules, and says when the subgroup basis differs', async () => {
    const c = await chart();
    expect(c.limitsSource).toBe('baseline');
    expect(c.baseline.id).toBe(ctx.baseline);
    expect(c.limits.centre).toBeCloseTo(0.06, 10);
    expect(c.rules).toEqual(['we1']);
    expect(c.signals.map((s: { index: number }) => s.index)).toEqual([5]);
    const day = await chart('&subgroup=day');
    expect(day.baseline).toBeNull();
    expect(day.baselineIssue).toMatch(/subgroups of one inspection/);
  });

  it('is tenant-scoped', async () => {
    const other = await as(ids.ownerB, ids.orgB);
    await api().get(`/api/v1/spc/chart?partId=${ctx.part}&characteristicKey=VISUAL&subgroup=day`).set(other).expect(404);
    await api().post('/api/v1/spc/baselines').set(other).send({ partId: ctx.part, characteristicKey: 'VISUAL', operationCode: 'OP-020' }).expect(404);
  });
});
