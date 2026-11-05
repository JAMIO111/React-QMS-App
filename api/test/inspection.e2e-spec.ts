/**
 * PC4 through the API: start an inspection (refused with the resolver's reasons, or started with a
 * frozen snapshot), add samples with readings (exact decimals, pass/fail from the database, gauges
 * checked), correct a reading (new row, reason, permission), retest, complete with a result, abandon,
 * list and filter, and inspectors' limits.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('d');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ipi');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  // Gauges.
  const type = (await api().post('/api/v1/gauge-types').set(h).send({ name: 'Micrometer 0-25' }).expect(201)).body;
  ctx.micType = type.id;
  const due = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
  ctx.mic = (await api().post('/api/v1/gauges').set(h).send({ assetNumber: 'MIC-1', description: 'Mic', gaugeTypeId: type.id, siteId: ids.siteA, nextDueOn: due(30) }).expect(201)).body.id;
  ctx.oldMic = (await api().post('/api/v1/gauges').set(h).send({ assetNumber: 'MIC-2', description: 'Old mic', gaugeTypeId: type.id, siteId: ids.siteA, nextDueOn: due(-2) }).expect(201)).body.id;
  // A family part with a released revision and LENGTH, and a plan with OD (micrometer), LENGTH and VISUAL.
  const fam = (await api().post('/api/v1/part-families').set(h).send({ code: 'HCR', name: 'Rods' }).expect(201)).body;
  const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'HCR-100', name: 'Rod 100', partFamilyId: fam.id, initialRevision: { revision: 'A' } }).expect(201)).body;
  ctx.part = part.id;
  await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/characteristics`).set(h).send({ characteristicKey: 'LENGTH', nominal: 100, lowerLimit: 99.9, upperLimit: 100.1, unitCode: 'mm' }).expect(201);
  ctx.partRevision = part.revisions[0].id;
  const plan = (await api().post('/api/v1/control-plans').set(h).send({ planCode: 'CP-1', title: 'Rods', partFamilyId: fam.id }).expect(201)).body;
  ctx.plan = plan.id;
  ctx.planRev = plan.revisions[0].id;
  const rev = (await api().post(`/api/v1/control-plan-revisions/${ctx.planRev}/operations`).set(h).send({ operationCode: 'OP-020', name: 'Turning' }).expect(201)).body;
  const op = rev.operations[0].id;
  const add = (body: object) => api().post(`/api/v1/control-plan-revisions/${ctx.planRev}/characteristics`).set(h).send({ operationId: op, ...body }).expect(201);
  await add({ characteristicKey: 'OD', name: 'Outer diameter', nominal: 25, lowerLimit: 24.95, upperLimit: 25.05, unitCode: 'mm', gaugeTypeId: type.id, sampling: [{ triggerType: 'first_off', sampleSize: 1 }, { triggerType: 'every_n_parts', intervalValue: 60, sampleSize: 1 }] });
  await add({ characteristicKey: 'LENGTH', name: 'Overall length', valueSource: 'part_spec', specKey: 'LENGTH', unitCode: 'mm' });
  await add({ characteristicKey: 'VISUAL', name: 'No chatter marks', dataType: 'attribute' });
  await api().patch(`/api/v1/control-plan-revisions/${ctx.planRev}`).set(h).send({ changeReason: 'First' }).expect(200);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('starting an inspection', () => {
  it('refuses with the reasons while the plan or part is not ready', async () => {
    const h = await as(ids.ownerA);
    const res = await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: ctx.part }).expect(409);
    expect(res.body.error.code).toBe('inspection_rule');
    expect(res.body.error.message).toMatch(/^The inspection cannot start: .*no released revision.*No effective revision of CP-1/);
    await api().post(`/api/v1/part-revisions/${ctx.partRevision}/release`).set(h).expect(200);
    await api().post(`/api/v1/control-plan-revisions/${ctx.planRev}/transitions`).set(h).send({ action: 'submit' }).expect(200);
    await api().post(`/api/v1/control-plan-revisions/${ctx.planRev}/transitions`).set(h).send({ action: 'approve' }).expect(200);
  });

  it('starts with a frozen snapshot of the requirements', async () => {
    const h = await as(ids.ownerA);
    const rec = (await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: ctx.part, workOrder: 'WO-77', lot: 'L-1', lotSize: 120, triggerType: 'first_off' }).expect(201)).body;
    ctx.rec = rec.id;
    expect(rec).toMatchObject({
      reference: expect.stringMatching(/^IPI-\d\d-0001$/),
      status: 'in_progress',
      result: null,
      part: { partNumber: 'HCR-100' },
      partRevision: 'A',
      plan: { planCode: 'CP-1', revisionCode: 'A' },
      workOrder: 'WO-77',
      triggerType: 'first_off',
      startedBy: { id: ids.ownerA, name: 'Ada Owner' },
      samples: [],
    });
    const byKey = Object.fromEntries(rec.requirements.map((q: { characteristicKey: string }) => [q.characteristicKey, q]));
    expect(byKey.LENGTH).toMatchObject({ valueSource: 'part_spec', nominal: 100, lowerLimit: 99.9, upperLimit: 100.1, unitCode: 'mm' });
    expect(byKey.OD.gaugeType).toEqual({ id: ctx.micType, name: 'Micrometer 0-25' });
    ctx.od = byKey.OD.id;
    ctx.len = byKey.LENGTH.id;
    ctx.vis = byKey.VISUAL.id;
    await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: ids.orgB }).expect(404);
  });
});

describe('recording', () => {
  it('saves a sample with exact values and works out pass/fail', async () => {
    const h = await as(ids.ownerA);
    const rest = [{ requirementId: ctx.len, valueNumeric: '100' }, { requirementId: ctx.vis, valuePass: true }];
    const rec0 = (await api().get(`/api/v1/inspections/${ctx.rec}`).set(h).expect(200)).body;
    expect(rec0.schedule.map((x: { number: number; position: number; trigger: string; requirementIds: string[] }) => [x.number, x.position, x.trigger, x.requirementIds.length])).toEqual([[1, 1, 'first_off', 3], [2, 61, 'every_n_parts', 1]]);
    const partial = await api().post(`/api/v1/inspections/${ctx.rec}/samples`).set(h).send({ readings: [{ requirementId: ctx.od, valueNumeric: '25.0', gaugeId: ctx.mic }] }).expect(409);
    expect(partial.body.error.message).toMatch(/^Sample 1 still needs: Overall length, No chatter marks/);
    const missingGauge = await api().post(`/api/v1/inspections/${ctx.rec}/samples`).set(h).send({ readings: [{ requirementId: ctx.od, valueNumeric: '25.0' }, ...rest] }).expect(409);
    expect(missingGauge.body.error.message).toBe('Outer diameter must be measured with a Micrometer 0-25 gauge; choose the gauge used');
    const overdue = await api().post(`/api/v1/inspections/${ctx.rec}/samples`).set(h).send({ readings: [{ requirementId: ctx.od, valueNumeric: '25.0', gaugeId: ctx.oldMic }, ...rest] }).expect(409);
    expect(overdue.body.error.message).toMatch(/^Gauge MIC-2 is overdue for calibration/);
    // Nothing was saved by the refused requests (all or nothing).
    expect((await api().get(`/api/v1/inspections/${ctx.rec}`).set(h).expect(200)).body.samples).toEqual([]);

    const rec = (
      await api()
        .post(`/api/v1/inspections/${ctx.rec}/samples`)
        .set(h)
        .send({
          unitReference: 'S/N 1',
          triggerType: 'first_off',
          readings: [
            { requirementId: ctx.od, valueNumeric: '25.0500', gaugeId: ctx.mic },
            { requirementId: ctx.len, valueNumeric: '100.10000001' },
            { requirementId: ctx.vis, valuePass: true },
          ],
        })
        .expect(201)
    ).body;
    expect(rec.samples).toMatchObject([{ sampleNumber: 1, unitReference: 'S/N 1', triggerType: 'first_off' }]);
    const byReq = Object.fromEntries(rec.measurements.map((m: { requirementId: string }) => [m.requirementId, m]));
    expect(byReq[ctx.od]).toMatchObject({ valueNumeric: '25.0500', result: 'pass', unitCode: 'mm', gauge: { assetNumber: 'MIC-1', valid: true, status: 'active' } });
    expect(byReq[ctx.len]).toMatchObject({ valueNumeric: '100.10000001', result: 'fail' });
    expect(byReq[ctx.vis]).toMatchObject({ valuePass: true, valueNumeric: null, result: 'pass' });
    ctx.lenReading = byReq[ctx.len].id;
    expect(rec.failures).toBe(1);
    await api().post(`/api/v1/inspections/${ctx.rec}/samples`).set(h).send({ readings: [{ requirementId: ctx.len, valueNumeric: 'abc' }] }).expect(400);
  });

  it('corrects a reading with a reason, keeping the original, and only with permission', async () => {
    await api().post(`/api/v1/inspection-measurements/${ctx.lenReading}/correction`).set(await as(ids.inspectorA)).send({ valueNumeric: '100.0', reason: 'Typo' }).expect(403);
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/inspection-measurements/${ctx.lenReading}/correction`).set(h).send({ valueNumeric: '100.0' }).expect(400);
    const rec = (await api().post(`/api/v1/inspection-measurements/${ctx.lenReading}/correction`).set(h).send({ valueNumeric: '100.0', reason: 'Typed an extra digit' }).expect(201)).body;
    const len = rec.measurements.filter((m: { requirementId: string }) => m.requirementId === ctx.len);
    expect(len.map((m: { valueNumeric: string; result: string }) => `${m.valueNumeric}:${m.result}`)).toEqual(['100.10000001:fail', '100.0:pass']);
    expect(len[0].supersededById).toBe(len[1].id);
    expect(len[1]).toMatchObject({ supersedesId: len[0].id, correctionReason: 'Typed an extra digit' });
    expect(rec.failures).toBe(0);
    const again = await api().post(`/api/v1/inspection-measurements/${ctx.lenReading}/correction`).set(h).send({ valueNumeric: '100.0', reason: 'x' }).expect(409);
    expect(again.body.error.message).toBe('This reading has already been corrected; correct the latest reading instead');
  });

  it('records a failure and its retest, then completes with result fail', async () => {
    const h = await as(ids.ownerA);
    let rec = (await api().post(`/api/v1/inspections/${ctx.rec}/samples`).set(h).send({ readings: [{ requirementId: ctx.od, valueNumeric: '25.06', gaugeId: ctx.mic }] }).expect(201)).body;
    const failed = rec.measurements.find((m: { valueNumeric: string }) => m.valueNumeric === '25.06');
    expect(failed.result).toBe('fail');
    rec = (
      await api()
        .post(`/api/v1/inspections/${ctx.rec}/samples`)
        .set(h)
        .send({ isRetest: true, readings: [{ requirementId: ctx.od, valueNumeric: '25.01', gaugeId: ctx.oldMic, gaugeOverrideReason: 'Only mic on shift', retestOfId: failed.id }] })
        .expect(201)
    ).body;
    const retest = rec.measurements.find((m: { retestOfId: string | null }) => m.retestOfId === failed.id);
    expect(retest).toMatchObject({ result: 'pass', gauge: { assetNumber: 'MIC-2', valid: false }, gaugeOverrideReason: 'Only mic on shift' });
    rec = (await api().post(`/api/v1/inspections/${ctx.rec}/complete`).set(h).expect(200)).body;
    expect(rec).toMatchObject({ status: 'completed', result: 'fail', completedBy: { id: ids.ownerA } });
    const late = await api().post(`/api/v1/inspections/${ctx.rec}/samples`).set(h).send({ readings: [{ requirementId: ctx.vis, valuePass: true }] }).expect(409);
    expect(late.body.error.message).toMatch(/is completed; no more samples or readings can be added/);
  });

  it('refuses to complete with unmeasured checks, abandons with a reason', async () => {
    const h = await as(ids.ownerA);
    const rec = (await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: ctx.part, operationCode: 'op-020' }).expect(201)).body;
    const incomplete = await api().post(`/api/v1/inspections/${rec.id}/complete`).set(h).expect(409);
    // In the plan's order (same sequence, so by key: LENGTH, OD, VISUAL).
    expect(incomplete.body.error.message).toBe('Measure every check before completing; missing: Overall length, Outer diameter, No chatter marks');
    await api().post(`/api/v1/inspections/${rec.id}/abandon`).set(h).send({}).expect(400);
    const abandoned = (await api().post(`/api/v1/inspections/${rec.id}/abandon`).set(h).send({ reason: 'Wrong lot' }).expect(200)).body;
    expect(abandoned).toMatchObject({ status: 'abandoned', result: null, abandonReason: 'Wrong lot' });
  });

  it('lists and filters inspections; inspectors record but cannot override gauges', async () => {
    const h = await as(ids.ownerA);
    const all = (await api().get('/api/v1/inspections').set(h).expect(200)).body.data;
    expect(all.map((r: { status: string }) => r.status)).toEqual(['abandoned', 'completed']);
    expect((await api().get('/api/v1/inspections?result=fail').set(h).expect(200)).body.data).toHaveLength(1);
    expect((await api().get('/api/v1/inspections?q=WO-77').set(h).expect(200)).body.data[0].reference).toMatch(/0001$/);

    const insp = await as(ids.inspectorA);
    const rec = (await api().post('/api/v1/inspections').set(insp).send({ siteId: ids.siteA, partId: ctx.part }).expect(201)).body;
    const od = rec.requirements.find((q: { characteristicKey: string }) => q.characteristicKey === 'OD').id;
    const rest = [{ requirementId: rec.requirements.find((q: { characteristicKey: string }) => q.characteristicKey === 'LENGTH').id, valueNumeric: '100' }, { requirementId: rec.requirements.find((q: { characteristicKey: string }) => q.characteristicKey === 'VISUAL').id, valuePass: true }];
    await api().post(`/api/v1/inspections/${rec.id}/samples`).set(insp).send({ readings: [{ requirementId: od, valueNumeric: '25', gaugeId: ctx.oldMic, gaugeOverrideReason: 'please' }, ...rest] }).expect(403);
    await api().post(`/api/v1/inspections/${rec.id}/samples`).set(insp).send({ readings: [{ requirementId: od, valueNumeric: '25', gaugeId: ctx.mic }, ...rest] }).expect(201);
    // Viewers read only.
    await api().get(`/api/v1/inspections/${rec.id}`).set(await as(ids.dual)).expect(200);
    await api().post('/api/v1/inspections').set(await as(ids.dual)).send({ siteId: ids.siteA, partId: ctx.part }).expect(403);
  });
});
