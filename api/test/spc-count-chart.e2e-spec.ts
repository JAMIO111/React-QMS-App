/**
 * PC8 through the API: a defect-count characteristic (C or U chart by the data), the NP chart as a view of a pass/fail
 * characteristic (subgroup size fixed or calculated), saved baselines, what is left out, and the plan rules.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('3');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const DEFECTS = [8, 12, 10, 9, 11, 30]; // defects over the 10 units of each inspection
const FAILS = [1, 2, 1, 0, 2, 9]; // failed checks of 12 in each inspection

/** Spreads `total` defects over `units` units as evenly as possible. */
const spread = (total: number, units: number) => Array.from({ length: units }, (_, i) => Math.floor(total / units) + (i < total % units ? 1 : 0));

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-counts');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  const fam = (await api().post('/api/v1/part-families').set(h).send({ code: 'HCR', name: 'Rods' }).expect(201)).body;
  const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'HCR-100', name: 'Rod 100', partFamilyId: fam.id, initialRevision: { revision: 'A' } }).expect(201)).body;
  ctx.part = part.id;
  await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/release`).set(h).expect(200);
  const plan = (await api().post('/api/v1/control-plans').set(h).send({ planCode: 'CP-1', title: 'Rods', partFamilyId: fam.id }).expect(201)).body;
  ctx.planRev = plan.revisions[0].id;
  const rev1 = (await api().post(`/api/v1/control-plan-revisions/${ctx.planRev}/operations`).set(h).send({ operationCode: 'OP-020', name: 'Turning' }).expect(201)).body;
  ctx.op20 = rev1.operations[0].id;
  const rev2 = (await api().post(`/api/v1/control-plan-revisions/${ctx.planRev}/operations`).set(h).send({ operationCode: 'OP-030', name: 'Finishing' }).expect(201)).body;
  ctx.op30 = rev2.operations.find((o: { operationCode: string }) => o.operationCode === 'OP-030').id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

type Char = { characteristicKey: string; id: string; [k: string]: unknown };
const findChar = (rev: { operations: { characteristics: Char[] }[] }, key: string) => rev.operations.flatMap((o) => o.characteristics).find((c) => c.characteristicKey === key);

describe('the defect-count check type', () => {
  it('has no unit or lower limit; marked for SPC it becomes a defects-per-unit chart with no subgroup size', async () => {
    const h = await as(ids.ownerA);
    const add = (body: object) => api().post(`/api/v1/control-plan-revisions/${ctx.planRev}/characteristics`).set(h).send(body);
    const created = (
      await add({ operationId: ctx.op20, characteristicKey: 'SCRATCH', name: 'Scratches', dataType: 'count', upperLimit: 3, unitCode: 'mm', nominal: 5, lowerLimit: 1, spcEligible: true, chartType: 'imr', subgroupSize: 5, criticality: 'minor', sampling: [{ triggerType: 'first_off', sampleSize: 10 }] }).expect(201)
    ).body;
    expect(findChar(created, 'SCRATCH')).toMatchObject({ dataType: 'count', upperLimit: 3, lowerLimit: null, nominal: null, unitCode: null, spcEligible: true, chartType: 'defects', subgroupSize: null });
    const negative = await add({ operationId: ctx.op20, characteristicKey: 'BAD', name: 'Bad', dataType: 'count', upperLimit: -1, criticality: 'minor' });
    expect(negative.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(negative.body)).toMatch(/cannot be negative/);
    const measured = await add({ operationId: ctx.op20, characteristicKey: 'OD', name: 'OD', nominal: 25, lowerLimit: 24.95, upperLimit: 25.05, unitCode: 'mm', spcEligible: true, chartType: 'defects' });
    expect(measured.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(measured.body)).toMatch(/defects-per-unit chart is for defect counts/);
    await add({ operationId: ctx.op30, characteristicKey: 'VISUAL', name: 'No chatter marks', dataType: 'attribute', spcEligible: true, criticality: 'minor', sampling: [{ triggerType: 'first_off', sampleSize: 12 }] }).expect(201);
    await api().patch(`/api/v1/control-plan-revisions/${ctx.planRev}`).set(h).send({ changeReason: 'First' }).expect(200);
    await api().post(`/api/v1/control-plan-revisions/${ctx.planRev}/transitions`).set(h).send({ action: 'submit' }).expect(200);
    await api().post(`/api/v1/control-plan-revisions/${ctx.planRev}/transitions`).set(h).send({ action: 'approve' }).expect(200);
  });
});

describe('recording defect counts', () => {
  it('stores a count per unit and judges it against the most allowed; refuses a count for a measured check or a negative count', async () => {
    const h = await as(ids.ownerA);
    const rec = (await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: ctx.part, operationCode: 'OP-020', lot: 'LOT-A', workOrder: 'WO-X', triggerType: 'first_off' }).expect(201)).body;
    const req = rec.requirements.find((q: { characteristicKey: string }) => q.characteristicKey === 'SCRATCH');
    expect(req).toMatchObject({ dataType: 'count', chartType: 'defects', upperLimit: 3 });
    const bad = await api().post(`/api/v1/inspections/${rec.id}/samples`).set(h).send({ readings: [{ requirementId: req.id, valueCount: -1 }] });
    expect(bad.status).toBe(400);
    const both = await api().post(`/api/v1/inspections/${rec.id}/samples`).set(h).send({ readings: [{ requirementId: req.id, valueCount: 1, valuePass: true }] });
    expect(both.status).toBe(400);
    const counts = [1, 2, 1, 2, 1, 2, 1, 2, 1]; // nine units, none above the limit of 3; the tenth is over it
    for (const c of counts) await api().post(`/api/v1/inspections/${rec.id}/samples`).set(h).send({ readings: [{ requirementId: req.id, valueCount: c }] }).expect(201);
    const over = (await api().post(`/api/v1/inspections/${rec.id}/samples`).set(h).send({ readings: [{ requirementId: req.id, valueCount: 4 }] })).body;
    const last = over.measurements.find((m: { valueCount: number }) => m.valueCount === 4);
    expect(last).toMatchObject({ valueCount: 4, valueNumeric: null, valuePass: null, result: 'fail', unitCode: null });
    expect(over.measurements.filter((m: { result: string }) => m.result === 'pass')).toHaveLength(9);
    const fixed = (await api().post(`/api/v1/inspection-measurements/${last.id}/correction`).set(h).send({ valueCount: 3, reason: 'Recounted' })).body;
    const replaced = fixed.measurements.find((m: { valueCount: number; result: string }) => m.valueCount === 3);
    expect(replaced?.result).toBe('pass');
    await api().post(`/api/v1/inspections/${rec.id}/abandon`).set(h).send({ reason: 'Practice run' }).expect(200);
  });
});

describe('defects charts (C or U by the data)', () => {
  const record = async (units: number, total: number, i: number) => {
    const h = await as(ids.ownerA);
    const rec = (await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: ctx.part, operationCode: 'OP-020', lot: i < 3 ? 'LOT-A' : i < 5 ? 'LOT-B' : undefined, workOrder: `WO-${i}`, triggerType: 'first_off' }).expect(201)).body;
    const req = rec.requirements.find((q: { characteristicKey: string }) => q.characteristicKey === 'SCRATCH').id;
    for (const c of spread(total, units)) await api().post(`/api/v1/inspections/${rec.id}/samples`).set(h).send({ readings: [{ requirementId: req, valueCount: c }] }).expect(201);
  };
  const chart = async (query = '') => (await api().get(`/api/v1/spc/chart?partId=${ctx.part}&characteristicKey=SCRATCH&operationCode=OP-020${query}`).set(await as(ids.ownerA)).expect(200)).body;

  it('lists the characteristic as a defects chart', async () => {
    for (let i = 0; i < DEFECTS.length; i++) await record(10, DEFECTS[i], i);
    const list = (await api().get(`/api/v1/spc/characteristics?partId=${ctx.part}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(list.find((c: { key: string }) => c.key === 'SCRATCH')).toMatchObject({ chartType: 'defects', subgroupSize: null, unitCode: null, readings: 70, hasBaseline: false });
  });

  it('with the same number of units in every subgroup it is a C chart: defects per subgroup, c̄ ± 3√c̄', async () => {
    const c = await chart();
    expect(c.variant).toBe('c');
    expect(c.characteristic).toMatchObject({ chartType: 'defects', subgroupSize: null, unitCode: null });
    expect(c.points.map((p: { n: number; failed: number; value: number }) => [p.n, p.failed, p.value])).toEqual(DEFECTS.map((d) => [10, d, d]));
    expect(c.limitsSource).toBe('trial');
    const centre = 80 / 6; // c̄: defects per subgroup of 10 units
    expect(c.limits.centre).toBeCloseTo(centre, 8);
    expect(c.points[0].ucl).toBeCloseTo(centre + 3 * Math.sqrt(centre), 8);
    expect(c.signals.some((s: { rule: string; index: number }) => s.rule === 'we1' && s.index === 5)).toBe(true);
    expect(c.subgroup).toMatchObject({ basis: 'inspection', size: 10 });
    expect(c.excluded).toEqual([expect.objectContaining({ reason: 'abandoned', count: 10 })]); // the practice inspection
    expect(c.dispersionSignals).toEqual([]);
  });

  it('by lot: inspections pooled, no-lot checks counted as left out', async () => {
    const c = await chart('&subgroup=lot');
    expect(c.points.map((p: { lot: string; n: number; failed: number }) => [p.lot, p.n, p.failed])).toEqual([['LOT-A', 30, 30], ['LOT-B', 20, 20]]);
    expect(c.excluded).toEqual([expect.objectContaining({ reason: 'abandoned', count: 10 }), expect.objectContaining({ reason: 'no_lot', count: 10 })]);
  });

  it('saves ū from the first five subgroups; the baseline is then used (and its rules)', async () => {
    const owner = await as(ids.ownerA);
    const body = { partId: ctx.part, characteristicKey: 'SCRATCH', operationCode: 'OP-020' };
    await api().post('/api/v1/spc/baselines').set(await as(ids.inspectorA)).send({ ...body, firstN: 5 }).expect(403);
    const saved = (await api().post('/api/v1/spc/baselines').set(owner).send({ ...body, firstN: 5, rules: ['we1'] }).expect(201)).body;
    expect(saved).toMatchObject({ chartType: 'defects', subgroupSize: null, subgroupBasis: 'inspection', meanSubgroupSize: 10, points: 5, rules: ['we1'] });
    expect(saved.limits.centre).toBeCloseTo(1, 10); // 50 defects over 50 units
    expect(saved.limits.dispersionUcl).toBeNull();
    const c = await chart();
    expect(c.limitsSource).toBe('baseline');
    expect(c.limits.centre).toBeCloseTo(10, 10); // ū × 10 units
    expect(c.signals.map((s: { index: number }) => s.index)).toEqual([5]);
    expect((await chart('&subgroup=day')).baselineIssue).toMatch(/subgroups of one inspection/);
  });

  it('when subgroups differ in size it becomes a U chart: defects per unit, each point with its own limits', async () => {
    await record(5, 6, 6);
    const c = await chart();
    expect(c.variant).toBe('u');
    expect(c.points).toHaveLength(7);
    expect(c.points[6]).toMatchObject({ n: 5, failed: 6 });
    expect(c.points[6].value).toBeCloseTo(1.2, 10);
    expect(c.limits.centre).toBeCloseTo(1, 10); // the saved ū
    // The smaller subgroup has wider limits.
    expect(c.points[6].ucl).toBeCloseTo(1 + 3 * Math.sqrt(1 / 5), 8);
    expect(c.points[0].ucl).toBeCloseTo(1 + 3 * Math.sqrt(1 / 10), 8);
    expect(c.points[6].ucl).toBeGreaterThan(c.points[0].ucl);
  });

  it('is tenant-scoped', async () => {
    const other = await as(ids.ownerB, ids.orgB);
    await api().get(`/api/v1/spc/chart?partId=${ctx.part}&characteristicKey=SCRATCH&operationCode=OP-020`).set(other).expect(404);
  });
});

describe('NP chart (a view of a pass/fail characteristic)', () => {
  const chart = async (query = '') => (await api().get(`/api/v1/spc/chart?partId=${ctx.part}&characteristicKey=VISUAL&operationCode=OP-030${query}`).set(await as(ids.ownerA)).expect(200)).body;
  const record = async (checks: number, failed: number, i: number) => {
    const h = await as(ids.ownerA);
    const rec = (await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: ctx.part, operationCode: 'OP-030', workOrder: `WO-N${i}`, triggerType: 'first_off' }).expect(201)).body;
    for (let s = 0; s < checks; s++) await api().post(`/api/v1/inspections/${rec.id}/samples`).set(h).send({ readings: [{ requirementId: rec.requirements[0].id, valuePass: s >= failed }] }).expect(201);
  };

  it('records the pass/fail inspections (six of 12 checks and one of 5)', async () => {
    for (let i = 0; i < FAILS.length; i++) await record(12, FAILS[i], i);
    await record(5, 1, 9);
  });

  it('the P chart is the default; NP with the size left to calculate uses the most common size and counts the rest as left out', async () => {
    const p = await chart();
    expect(p.variant).toBe('p');
    expect(p.characteristic.chartType).toBe('p');
    expect(p.points).toHaveLength(7);
    const np = await chart('&display=np');
    expect(np.variant).toBe('np');
    expect(np.subgroup).toMatchObject({ size: 12, basis: 'inspection' });
    expect(np.points.map((x: { n: number; failed: number; value: number }) => [x.n, x.failed, x.value])).toEqual(FAILS.map((d) => [12, d, d]));
    expect(np.excluded).toEqual([expect.objectContaining({ reason: 'size', count: 1 })]);
    const centre = 12 * (15 / 72); // n·p̄ from the six subgroups of 12 checks
    expect(np.limits.centre).toBeCloseTo(centre, 8);
    expect(np.points[0].ucl).toBeCloseTo(centre + 3 * Math.sqrt(12 * (15 / 72) * (1 - 15 / 72)), 8);
    expect(np.signals.some((s: { rule: string; index: number }) => s.rule === 'we1' && s.index === 5)).toBe(true);
  });

  it('a fixed size keeps only the subgroups of that size', async () => {
    const five = await chart('&display=np&size=5');
    expect(five.points.map((x: { n: number }) => x.n)).toEqual([5]);
    expect(five.limitsSource).toBe('none');
    expect(five.excluded).toEqual([expect.objectContaining({ reason: 'size', count: 6 })]);
    const bad = await api().get(`/api/v1/spc/chart?partId=${ctx.part}&characteristicKey=VISUAL&operationCode=OP-030&display=np&size=abc`).set(await as(ids.ownerA));
    expect(bad.status).toBe(400);
  });

  it('shares the P chart’s saved baseline (p̄, the subgroup basis), made from subgroups of the NP size', async () => {
    const owner = await as(ids.ownerA);
    const saved = (await api().post('/api/v1/spc/baselines').set(owner).send({ partId: ctx.part, characteristicKey: 'VISUAL', operationCode: 'OP-030', size: 'auto', firstN: 5 }).expect(201)).body;
    expect(saved).toMatchObject({ chartType: 'p', subgroupBasis: 'inspection', points: 5 });
    expect(saved.limits.centre).toBeCloseTo(6 / 60, 10);
    const np = await chart('&display=np');
    expect(np.limitsSource).toBe('baseline');
    expect(np.limits.centre).toBeCloseTo(12 * 0.1, 10);
    expect((await chart()).limitsSource).toBe('baseline');
  });
});
