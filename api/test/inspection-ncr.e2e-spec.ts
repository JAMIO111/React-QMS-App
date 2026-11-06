/**
 * PC5 through the API: the suggested NC for failed readings, acknowledging failures, the completion
 * rule, raising an NC (pre-filled from the inspection, readings linked permanently) and a manual NC,
 * what the NC page shows about its source (including later corrections), permissions, and the gauge
 * usage report for a calibration found out of tolerance.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('e');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const day = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ipn');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  const type = (await api().post('/api/v1/gauge-types').set(h).send({ name: 'Micrometer 0-25' }).expect(201)).body;
  ctx.mic = (await api().post('/api/v1/gauges').set(h).send({ assetNumber: 'MIC-1', description: 'Mic', gaugeTypeId: type.id, siteId: ids.siteA, nextDueOn: day(30) }).expect(201)).body.id;
  const fam = (await api().post('/api/v1/part-families').set(h).send({ code: 'HCR', name: 'Rods' }).expect(201)).body;
  const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'HCR-100', name: 'Rod 100', partFamilyId: fam.id, initialRevision: { revision: 'A' } }).expect(201)).body;
  ctx.part = part.id;
  await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/release`).set(h).expect(200);
  const plan = (await api().post('/api/v1/control-plans').set(h).send({ planCode: 'CP-1', title: 'Rods', partFamilyId: fam.id }).expect(201)).body;
  const planRev = plan.revisions[0].id;
  const rev = (await api().post(`/api/v1/control-plan-revisions/${planRev}/operations`).set(h).send({ operationCode: 'OP-020', name: 'Turning' }).expect(201)).body;
  await api().post(`/api/v1/control-plan-revisions/${planRev}/characteristics`).set(h).send({
    operationId: rev.operations[0].id, characteristicKey: 'OD', name: 'Outer diameter', nominal: 25, lowerLimit: 24.95, upperLimit: 25.05, unitCode: 'mm',
    gaugeTypeId: type.id, criticality: 'critical', sampling: [{ triggerType: 'first_off', sampleSize: 3 }], reactions: [{ triggerType: 'out_of_spec', action: 'hold', instruction: 'Quarantine since the last good check' }],
  }).expect(201);
  await api().patch(`/api/v1/control-plan-revisions/${planRev}`).set(h).send({ changeReason: 'First' }).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${planRev}/transitions`).set(h).send({ action: 'submit' }).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${planRev}/transitions`).set(h).send({ action: 'approve' }).expect(200);
  const rec = (await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: ctx.part, workOrder: 'WO-9', lot: 'LOT-3', serial: 'SN-77', triggerType: 'first_off' }).expect(201)).body;
  ctx.rec = rec.id;
  ctx.od = rec.requirements[0].id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const sample = (_value: string, _unit: string) =>
  api().post(`/api/v1/inspections/${ctx.rec}/samples`);

describe('failures, acknowledgement and the completion rule', () => {
  it('records a good and two failing samples', async () => {
    const h = await as(ids.ownerA);
    let last: { measurements: { id: string; valueNumeric: string }[]; failures: number } | undefined;
    for (const [value, unit] of [['25.0', 'S/N 1'], ['25.07', 'S/N 2'], ['25.08', 'S/N 3']]) {
      last = (await sample(value, unit).set(h).send({ unitReference: unit, readings: [{ requirementId: ctx.od, valueNumeric: value, gaugeId: ctx.mic }] }).expect(201)).body;
    }
    const byValue = Object.fromEntries(last!.measurements.map((m) => [m.valueNumeric, m]));
    ctx.good = byValue['25.0'].id;
    ctx.bad = byValue['25.07'].id;
    ctx.bad2 = byValue['25.08'].id;
    expect(last!.failures).toBe(2);
  });

  it('suggests an NC for the current failures, with the containment window', async () => {
    const h = await as(ids.ownerA);
    const draft = (await api().get(`/api/v1/inspections/${ctx.rec}/ncr-draft`).set(h).expect(200)).body;
    expect(draft).toMatchObject({
      title: 'Outer diameter out of limits: HCR-100 (IPI-26-0001)'.replace('26', draft.title.match(/IPI-(\d\d)/)[1]),
      severity: 'critical',
      quantityAffected: 2,
      requirement: 'Outer diameter: 24.95 to 25.05 mm',
    });
    expect(draft.readings.map((r: { value: string }) => r.value)).toEqual(['25.07 mm', '25.08 mm']);
    expect(draft.containment).toMatchObject([{ name: 'Outer diameter', lastGood: { sampleNumber: 1, value: '25.0 mm' }, firstFailure: { sampleNumber: 2, value: '25.07 mm' } }]);
    expect(draft.description).toContain('Work order WO-9, lot LOT-3, serial SN-77.');
    expect(draft.description).toContain('gauge MIC-1 (active, calibration due');
    expect(draft.description).toContain('Reaction plan:\n- hold: Quarantine since the last good check');
    // A passing reading cannot be chosen; a chosen subset narrows the suggestion.
    await api().get(`/api/v1/inspections/${ctx.rec}/ncr-draft?measurementIds=${ctx.good}`).set(h).expect(400);
    const one = (await api().get(`/api/v1/inspections/${ctx.rec}/ncr-draft?measurementIds=${ctx.bad2}`).set(h).expect(200)).body;
    expect(one).toMatchObject({ quantityAffected: 1, readings: [{ value: '25.08 mm' }] });
    // A manual NC is suggested when no reading is chosen.
    const manual = (await api().get(`/api/v1/inspections/${ctx.rec}/ncr-draft?measurementIds=`).set(h).expect(200)).body;
    expect(manual.title).toMatch(/^Defect found during inspection IPI-/);
  });

  it('will not complete while a current failure is neither acknowledged nor linked to an NC', async () => {
    const h = await as(ids.ownerA);
    const blocked = await api().post(`/api/v1/inspections/${ctx.rec}/complete`).set(h).expect(409);
    expect(blocked.body.error.message).toBe('Acknowledge or raise an NC for each failed reading before completing: Outer diameter (sample 2), Outer diameter (sample 3)');
    await api().post(`/api/v1/inspection-measurements/${ctx.good}/acknowledge`).set(h).send({ note: 'x' }).expect(409);
    await api().post(`/api/v1/inspection-measurements/${ctx.bad}/acknowledge`).set(h).send({}).expect(400);
    await api().post(`/api/v1/inspection-measurements/${ctx.bad}/acknowledge`).set(await as(ids.dual)).send({ note: 'viewer' }).expect(403);
    const rec = (await api().post(`/api/v1/inspection-measurements/${ctx.bad}/acknowledge`).set(h).send({ note: 'Tool wear; offset changed' }).expect(201)).body;
    expect(rec.measurements.find((m: { id: string }) => m.id === ctx.bad).acknowledgement).toMatchObject({ note: 'Tool wear; offset changed', by: { id: ids.ownerA, name: 'Ada Owner' } });
    await api().post(`/api/v1/inspection-measurements/${ctx.bad}/acknowledge`).set(h).send({ note: 'again' }).expect(409);
  });
});

describe('raising an NC', () => {
  it('creates a draft internal NC from the inspection and links the readings', async () => {
    const h = await as(ids.ownerA);
    const draft = (await api().get(`/api/v1/inspections/${ctx.rec}/ncr-draft?measurementIds=${ctx.bad2}`).set(h).expect(200)).body;
    await api().post(`/api/v1/inspections/${ctx.rec}/raise-ncr`).set(await as(ids.dual)).send({ title: 'viewer' }).expect(403);
    await api().post(`/api/v1/inspections/${ctx.rec}/raise-ncr`).set(h).send({ measurementIds: [ctx.good], title: 'A passing reading' }).expect(409);
    await api().post(`/api/v1/inspections/${ctx.rec}/raise-ncr`).set(h).send({ measurementIds: [] }).expect(400);
    const res = (
      await api()
        .post(`/api/v1/inspections/${ctx.rec}/raise-ncr`)
        .set(h)
        .send({ measurementIds: [ctx.bad2], title: draft.title, description: draft.description, severity: draft.severity, quantityAffected: draft.quantityAffected, requirement: draft.requirement, actualResult: draft.actualResult })
        .expect(201)
    ).body;
    ctx.ncr = res.ncr.id;
    expect(res.ncr).toMatchObject({ source: 'internal', stage: 'draft', reference: expect.stringMatching(/^NCM-\d\d-\d+$|^[A-Z]+-\d\d-\d+$/) });
    expect(res.inspection.ncrs).toMatchObject([{ id: ctx.ncr, stage: 'draft' }]);
    expect(res.inspection.measurements.find((m: { id: string }) => m.id === ctx.bad2).ncrs).toMatchObject([{ id: ctx.ncr }]);
    // Pre-filled from the inspection (not overridable), visible through the normal NC API.
    const ncr = (await api().get(`/api/v1/ncrs/${ctx.ncr}`).set(h).expect(200)).body;
    expect(ncr).toMatchObject({
      source: 'internal',
      severity: 'critical',
      workOrder: 'WO-9',
      lotNumber: 'LOT-3',
      serialNumber: 'SN-77',
      quantityAffected: 1,
      requirement: 'Outer diameter: 24.95 to 25.05 mm',
      part: { partNumber: 'HCR-100' },
      site: { id: ids.siteA },
      detectedBy: { id: ids.ownerA },
    });
    expect(ncr.actualResult).toContain('25.08 mm');
  });

  it('completes once every failure is handled; the result stays fail', async () => {
    const h = await as(ids.ownerA);
    const rec = (await api().post(`/api/v1/inspections/${ctx.rec}/complete`).set(h).expect(200)).body;
    expect(rec).toMatchObject({ status: 'completed', result: 'fail' });
  });

  it('raises a manual NC for the inspection as a whole, even after completion', async () => {
    const insp = await as(ids.inspectorA);
    const res = (await api().post(`/api/v1/inspections/${ctx.rec}/raise-ncr`).set(insp).send({ measurementIds: [], title: 'Burr found on the groove', description: 'Seen at final check' }).expect(201)).body;
    ctx.manual = res.ncr.id;
    const source = (await api().get(`/api/v1/ncrs/${ctx.manual}/inspection-source`).set(await as(ids.ownerA)).expect(200)).body;
    expect(source.inspections).toMatchObject([{ id: ctx.rec, wholeInspection: true, readings: [] }]);
  });

  it('shows the source on the NC page, keeping the reading when the NC changes or the reading is corrected', async () => {
    const h = await as(ids.ownerA);
    await api().patch(`/api/v1/ncrs/${ctx.ncr}`).set(h).send({ title: 'Renamed NC' }).expect(200);
    let source = (await api().get(`/api/v1/ncrs/${ctx.ncr}/inspection-source`).set(h).expect(200)).body;
    expect(source.inspections[0]).toMatchObject({ reference: expect.stringMatching(/^IPI-/), part: { partNumber: 'HCR-100' }, plan: { planCode: 'CP-1' }, wholeInspection: false });
    expect(source.inspections[0].readings).toMatchObject([{ id: ctx.bad2, requirementName: 'Outer diameter', sampleNumber: 3, valueNumeric: '25.08', limits: '24.95 to 25.05 mm', result: 'fail', gaugeAssetNumber: 'MIC-1', correctedTo: null }]);
    // The reading is corrected later (quality review): the NC still points at the original, and says so.
    await api().post(`/api/v1/inspection-measurements/${ctx.bad2}/correction`).set(h).send({ valueNumeric: '25.01', reason: 'Re-measured at the lab' }).expect(201);
    source = (await api().get(`/api/v1/ncrs/${ctx.ncr}/inspection-source`).set(h).expect(200)).body;
    expect(source.inspections[0].readings[0]).toMatchObject({ valueNumeric: '25.08', result: 'fail', correctedTo: { valueNumeric: '25.01', result: 'pass', reason: 'Re-measured at the lab' } });
    await api().get(`/api/v1/ncrs/${ids.orgB}/inspection-source`).set(h).expect(404);
  });
});

describe('gauge impact assessment', () => {
  it('lists the inspections that used the gauge since its previous calibration', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/gauges/${ctx.mic}/calibrations`).set(h).send({ outcome: 'pass', calibratedOn: day(-1) }).expect(201);
    const failing = (await api().post(`/api/v1/gauges/${ctx.mic}/calibrations`).set(h).send({ outcome: 'fail', calibratedOn: day(0) }).expect(201)).body;
    const usage = (await api().get(`/api/v1/calibrations/${failing.id}/gauge-usage`).set(h).expect(200)).body;
    expect(usage).toMatchObject({
      calibration: { id: failing.id, outcome: 'fail', calibratedOn: day(0) },
      gauge: { assetNumber: 'MIC-1' },
      previous: { calibratedOn: day(-1) },
      totals: { inspections: 1, readings: 4, failedReadings: 2 },
    });
    expect(usage.inspections).toMatchObject([{ id: ctx.rec, partNumber: 'HCR-100', readings: 4, failedReadings: 2, overrides: 0 }]);
    // The earlier (passing) calibration has nothing before it, so its period starts at the beginning.
    await api().get(`/api/v1/calibrations/${ids.orgB}/gauge-usage`).set(h).expect(404);
  });
});
