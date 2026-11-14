/**
 * CMM ingestion CM2 through the API: format profiles (templates, versions, rights), trying a file, uploading a report onto a running inspection as
 * a preview (header checks, balloon and saved-map matching, results and mismatches worked out by the database, inches converted), matching by hand
 * and remembering it, confirming mismatches, discarding, and who may see or do what. Applying is CM3. The rules are in
 * supabase/tests/measurement_imports.test.sql and measurement_import_units.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { InspectionFileStore } from '../src/measurement-imports/file-store';
import { makeIds, requireDb, seed, testEnv, token } from './helpers';
import { SAMPLE_QIF } from './qif-sample';

const ids = makeIds('c2a');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};

class MemoryStore extends InspectionFileStore {
  files = new Map<string, Uint8Array>();
  get enabled() {
    return true;
  }
  async download(path: string) {
    return this.files.get(path) ?? null;
  }
}
const store = new MemoryStore();
const put = (name: string, text: string) => {
  const path = `${ids.orgA}/inspection/${ctx.inspection}/${Math.random().toString(16).slice(2)}-${name}`;
  store.files.set(path, new TextEncoder().encode(text));
  return path;
};

const REPORT = [
  'Part: HSG-1',
  'Serial: SN-77',
  '',
  'Feature,Balloon,Actual,Lower limit,Upper limit',
  'Bore,1,25.02,24.95,25.05',
  'Length,2,40.15,39.9,40.2',
  'Visual,,OK,,',
  'Datum A,,0.001,,',
].join('\n');

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-cmm');
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).overrideProvider(InspectionFileStore).useValue(store).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true });
  app = configureApp(nest, env);
  await app.init();

  const h = await as(ids.ownerA);
  ctx.cmm = (await api().post('/api/v1/gauges').set(h).send({ assetNumber: 'CMM-1', description: 'Bridge CMM', siteId: ids.siteA }).expect(201)).body.id;
  const fam = (await api().post('/api/v1/part-families').set(h).send({ code: 'HSG', name: 'Housings' }).expect(201)).body;
  const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'HSG-1', name: 'Housing', partFamilyId: fam.id, initialRevision: { revision: 'A' } }).expect(201)).body;
  ctx.part = part.id;
  const plan = (await api().post('/api/v1/control-plans').set(h).send({ planCode: 'CP-HSG', title: 'Housings', partFamilyId: fam.id }).expect(201)).body;
  const rev = plan.revisions[0].id;
  const op = (await api().post(`/api/v1/control-plan-revisions/${rev}/operations`).set(h).send({ operationCode: 'OP-10', name: 'Machining' }).expect(201)).body.operations[0].id;
  const add = (body: object) => api().post(`/api/v1/control-plan-revisions/${rev}/characteristics`).set(h).send({ operationId: op, ...body }).expect(201);
  await add({ characteristicKey: 'OD', charNumber: '1', name: 'Bore', nominal: 25, lowerLimit: 24.95, upperLimit: 25.05, unitCode: 'mm' });
  await add({ characteristicKey: 'LEN', charNumber: '2', name: 'Length', nominal: 40, lowerLimit: 39.9, upperLimit: 40.1, unitCode: 'mm' });
  await add({ characteristicKey: 'VIS', name: 'Visual', dataType: 'attribute' });
  await api().patch(`/api/v1/control-plan-revisions/${rev}`).set(h).send({ changeReason: 'First' }).expect(200);
  await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/release`).set(h).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${rev}/transitions`).set(h).send({ action: 'submit' }).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${rev}/transitions`).set(h).send({ action: 'approve' }).expect(200);
  ctx.inspection = (await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: part.id }).expect(201)).body.id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('profiles', () => {
  it('offers templates and lets a manager save one as a profile; an inspector cannot', async () => {
    const t = await api().get('/api/v1/measurement-profiles/templates').set(await as(ids.inspectorA)).expect(200);
    const generic = t.body.data.find((x: { key: string }) => x.key === 'generic_limits');
    expect(t.body.data.map((x: { key: string }) => x.key)).toEqual(['calypso_table', 'pcdmis_csv', 'generic_limits']);
    const settings = { ...generic.settings, header: { partNumber: 'Part', serial: 'Serial' } };
    await api().post('/api/v1/measurement-profiles').set(await as(ids.inspectorA)).send({ name: 'Bench table', settings }).expect(403);
    const created = await api().post('/api/v1/measurement-profiles').set(await as(ids.ownerA)).send({ name: 'Bench table', settings, defaultGaugeId: ctx.cmm }).expect(201);
    expect(created.body).toMatchObject({ name: 'Bench table', currentVersion: 1, defaultGauge: { assetNumber: 'CMM-1' }, active: true });
    ctx.profile = created.body.id;
    const list = await api().get('/api/v1/measurement-profiles').set(await as(ids.inspectorA)).expect(200);
    expect(list.body).toMatchObject({ canManage: false, data: [{ name: 'Bench table' }] });
  });

  it('changing how files are read needs a reason and makes a new version; a rename does not', async () => {
    const h = await as(ids.ownerA);
    const p = (await api().get(`/api/v1/measurement-profiles/${ctx.profile}`).set(h).expect(200)).body;
    const res = await api().patch(`/api/v1/measurement-profiles/${ctx.profile}`).set(h).send({ settings: { ...p.settings, decimal: '.', unit: 'mm' } }).expect(409);
    expect(res.body.error).toMatchObject({ code: 'inspection_rule' });
    expect(res.body.error.message).toMatch(/why/);
    const v2 = await api().patch(`/api/v1/measurement-profiles/${ctx.profile}`).set(h).send({ settings: { ...p.settings, unit: 'mm' }, reason: 'Values are in millimetres' }).expect(200);
    expect(v2.body).toMatchObject({ currentVersion: 2, versions: [{ version: 2, reason: 'Values are in millimetres' }, { version: 1 }] });
    const renamed = await api().patch(`/api/v1/measurement-profiles/${ctx.profile}`).set(h).send({ name: 'Bench table (room 2)' }).expect(200);
    expect(renamed.body).toMatchObject({ name: 'Bench table (room 2)', currentVersion: 2 });
  });

  it('tries a file without saving anything, and says why one cannot be read', async () => {
    const h = await as(ids.inspectorA);
    const p = (await api().get(`/api/v1/measurement-profiles/${ctx.profile}`).set(h).expect(200)).body;
    const ok = await api().post('/api/v1/measurement-profiles/try').set(h).send({ settings: p.settings, fileName: 'r.csv', contentBase64: Buffer.from(REPORT).toString('base64') }).expect(200);
    expect(ok.body).toMatchObject({ ok: true, header: { partNumber: 'HSG-1', serial: 'SN-77' }, headingRow: 4, featureCount: 4 });
    expect(ok.body.units[0].features[0]).toMatchObject({ featureName: 'Bore', balloon: '1', actual: 25.02, lower: 24.95, upper: 25.05, unit: 'mm' });
    const bad = await api().post('/api/v1/measurement-profiles/try').set(h).send({ settings: p.settings, fileName: 'r.csv', contentBase64: Buffer.from('nothing,here\n1,2').toString('base64') }).expect(200);
    expect(bad.body).toMatchObject({ ok: false, error: expect.stringMatching(/Could not find a line/) });
    await api().post('/api/v1/measurement-profiles/try').set(h).send({ settings: { columns: { feature: 'F' } }, fileName: 'r.csv', contentBase64: 'eA==' }).expect(400);
  });
});

describe('uploading a report onto an inspection', () => {
  it('keeps it as a preview: matched by balloon, judged on our limits, the different upper limit flagged, nothing recorded', async () => {
    const h = await as(ids.inspectorA);
    const res = await api().post(`/api/v1/inspections/${ctx.inspection}/imports`).set(h).send({ path: put('report.csv', REPORT), fileName: 'report.csv', profileId: ctx.profile }).expect(201);
    ctx.import = res.body.id;
    expect(res.body).toMatchObject({
      status: 'previewed', profile: { name: 'Bench table (room 2)', version: 2 }, gauge: { assetNumber: 'CMM-1' }, canRecord: true, expired: false,
      header: { partNumber: 'HSG-1', serial: 'SN-77' }, inspection: { partNumber: 'HSG-1' },
      counts: { parts: 1, features: 4, matched: 2, toRecord: 2, unmatched: 2, problems: 0, failures: 1, mismatches: 1 },
    });
    expect(res.body.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.units[0].unitReference).toBe('SN-77');
    expect(res.body.units[0].rows.map((r: { featureName: string; matchKind: string; expectedResult: string | null; mismatch: boolean }) => [r.featureName, r.matchKind, r.expectedResult, r.mismatch])).toEqual([
      ['Bore', 'balloon', 'pass', false], ['Length', 'balloon', 'fail', true], ['Visual', 'none', null, false], ['Datum A', 'none', null, false],
    ]);
    expect(res.body.checks.map((c: { characteristicKey: string }) => c.characteristicKey).sort()).toEqual(['LEN', 'OD', 'VIS']);
    const insp = await api().get(`/api/v1/inspections/${ctx.inspection}`).set(h).expect(200);
    expect(JSON.stringify(insp.body)).not.toMatch(/25\.02/);
  });

  it('matches a feature by hand and remembers it for the part', async () => {
    const h = await as(ids.inspectorA);
    const detail = (await api().get(`/api/v1/inspection-imports/${ctx.import}`).set(h).expect(200)).body;
    const visual = detail.units[0].rows.find((r: { featureName: string }) => r.featureName === 'Visual');
    const vis = detail.checks.find((c: { characteristicKey: string }) => c.characteristicKey === 'VIS');
    const res = await api().put(`/api/v1/inspection-import-rows/${visual.id}/match`).set(h).send({ requirementId: vis.id, remember: true }).expect(200);
    expect(res.body.units[0].rows.find((r: { id: string }) => r.id === visual.id)).toMatchObject({ matchKind: 'manual', valuePass: true, expectedResult: 'pass' });
    const maps = await api().get(`/api/v1/parts/${ctx.part}/feature-maps`).set(h).expect(200);
    expect(maps.body.data).toMatchObject([{ featureName: 'Visual', characteristicKey: 'VIS', profile: { name: 'Bench table (room 2)' } }]);
    const od = detail.checks.find((c: { characteristicKey: string }) => c.characteristicKey === 'OD');
    const datum = detail.units[0].rows.find((r: { featureName: string }) => r.featureName === 'Datum A');
    const clash = await api().put(`/api/v1/inspection-import-rows/${datum.id}/match`).set(h).send({ requirementId: od.id }).expect(409);
    expect(clash.body.error.message).toMatch(/already matched to feature Bore/);
  });

  it('a second file of the part uses the remembered match; a mismatch must be confirmed; a preview can be discarded', async () => {
    const h = await as(ids.inspectorA);
    const second = await api().post(`/api/v1/inspections/${ctx.inspection}/imports`).set(h).send({ path: put('again.csv', REPORT), fileName: 'again.csv', profileId: ctx.profile }).expect(201);
    expect(second.body.units[0].rows.find((r: { featureName: string }) => r.featureName === 'Visual')).toMatchObject({ matchKind: 'map', expectedResult: 'pass' });
    const confirmed = await api().post(`/api/v1/inspection-imports/${second.body.id}/confirm-mismatches`).set(h).expect(200);
    expect(confirmed.body.mismatchesConfirmedAt).not.toBeNull();
    const discarded = await api().post(`/api/v1/inspection-imports/${second.body.id}/discard`).set(h).send({ reason: 'Uploaded twice' }).expect(200);
    expect(discarded.body).toMatchObject({ status: 'discarded', discardReason: 'Uploaded twice' });
    await api().post(`/api/v1/inspection-imports/${second.body.id}/discard`).set(h).send({}).expect(409);
    const list = await api().get(`/api/v1/inspections/${ctx.inspection}/imports`).set(h).expect(200);
    expect(list.body.data.map((i: { status: string }) => i.status)).toEqual(['discarded', 'previewed']);
  });

  it('converts a report in inches to the check’s millimetres', async () => {
    const h = await as(ids.ownerA);
    const p = (await api().get(`/api/v1/measurement-profiles/${ctx.profile}`).set(h).expect(200)).body;
    const inch = await api().post('/api/v1/measurement-profiles').set(h).send({ name: 'Bench table (inches)', settings: { ...p.settings, unit: 'in' } }).expect(201);
    const res = await api().post(`/api/v1/inspections/${ctx.inspection}/imports`).set(h)
      .send({ path: put('inch.csv', 'Feature,Balloon,Actual\nBore,1,0.9850\n'), fileName: 'inch.csv', profileId: inch.body.id }).expect(201);
    expect(res.body.units[0].rows[0]).toMatchObject({ unitRead: 'in', readValue: 0.985, valueNumeric: 25.019, expectedResult: 'pass' });
    expect(res.body.gauge).toBeNull();
  });

  it('refuses a file for another part, a file outside the inspection’s folder, a missing file and an unreadable one', async () => {
    const h = await as(ids.inspectorA);
    const wrong = await api().post(`/api/v1/inspections/${ctx.inspection}/imports`).set(h).send({ path: put('w.csv', REPORT.replace('HSG-1', 'OTHER-2')), fileName: 'w.csv', profileId: ctx.profile }).expect(409);
    expect(wrong.body.error).toMatchObject({ code: 'inspection_rule', message: expect.stringMatching(/for part OTHER-2/) });
    await api().post(`/api/v1/inspections/${ctx.inspection}/imports`).set(h).send({ path: `${ids.orgA}/inspection/elsewhere/x.csv`, fileName: 'x.csv', profileId: ctx.profile }).expect(400);
    await api().post(`/api/v1/inspections/${ctx.inspection}/imports`).set(h).send({ path: `${ids.orgA}/inspection/${ctx.inspection}/missing.csv`, fileName: 'm.csv', profileId: ctx.profile }).expect(400);
    const unreadable = await api().post(`/api/v1/inspections/${ctx.inspection}/imports`).set(h).send({ path: put('u.csv', 'a,b\n1,2\n'), fileName: 'u.csv', profileId: ctx.profile }).expect(400);
    expect(unreadable.body.error).toMatchObject({ code: 'file_unreadable' });
  });

  it('a viewer reads the preview but cannot act; another organisation sees nothing', async () => {
    const viewer = await as(ids.dual);
    await api().get(`/api/v1/inspection-imports/${ctx.import}`).set(viewer).expect(200);
    await api().post(`/api/v1/inspection-imports/${ctx.import}/confirm-mismatches`).set(viewer).expect(403);
    await api().post(`/api/v1/inspections/${ctx.inspection}/imports`).set(viewer).send({ path: put('v.csv', REPORT), fileName: 'v.csv', profileId: ctx.profile }).expect(403);
    const b = await as(ids.ownerB, ids.orgB);
    await api().get(`/api/v1/inspection-imports/${ctx.import}`).set(b).expect(404);
    await api().get(`/api/v1/measurement-profiles/${ctx.profile}`).set(b).expect(404);
    await api().post(`/api/v1/inspections/${ctx.inspection}/imports`).set(b).send({ path: put('b.csv', REPORT), fileName: 'b.csv', profileId: ctx.profile }).expect(404);
  });

  it('a retired profile reads no more files', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/measurement-profiles/${ctx.profile}/retire`).set(h).send({ reason: 'New CMM' }).expect(200);
    const res = await api().post(`/api/v1/inspections/${ctx.inspection}/imports`).set(h).send({ path: put('r.csv', REPORT), fileName: 'r.csv', profileId: ctx.profile }).expect(409);
    expect(res.body.error.message).toMatch(/retired/);
    await api().post(`/api/v1/measurement-profiles/${ctx.profile}/reactivate`).set(h).expect(200);
  });
});

describe('applying a preview (CM3)', () => {
  const file = (rows: string[]) => ['Part: HSG-1', 'Serial: SN-77', '', 'Feature,Balloon,Actual,Lower limit,Upper limit', ...rows].join('\n');
  const upload = async (h: Record<string, string>, name: string, text: string) =>
    (await api().post(`/api/v1/inspections/${ctx.inspection}/imports`).set(h).send({ path: put(name, text), fileName: name, profileId: ctx.profile }).expect(201)).body;
  const readings = async (h: Record<string, string>) => {
    const insp = (await api().get(`/api/v1/inspections/${ctx.inspection}`).set(h).expect(200)).body;
    return insp.measurements as {
      id: string; requirementId: string; valueNumeric: string; result: string; importId: string | null; retestOfId: string | null; supersedesId: string | null; correctionReason: string | null;
      gauge: { assetNumber: string } | null;
    }[];
  };

  it('waits for the differences to be confirmed, then records each matched feature as a reading with the CMM, all at once', async () => {
    const h = await as(ids.inspectorA);
    const refused = await api().post(`/api/v1/inspection-imports/${ctx.import}/apply`).set(h).send({}).expect(409);
    expect(refused.body.error.message).toMatch(/confirm/);
    await api().post(`/api/v1/inspection-imports/${ctx.import}/confirm-mismatches`).set(h).expect(200);
    await api().post(`/api/v1/inspection-imports/${ctx.import}/apply`).set(await as(ids.dual)).send({}).expect(403);
    const applied = await api().post(`/api/v1/inspection-imports/${ctx.import}/apply`).set(h).send({}).expect(200);
    expect(applied.body).toMatchObject({ status: 'applied', applyMode: 'new' });
    expect(applied.body.units[0].sampleId).not.toBeNull();
    const rows = applied.body.units[0].rows.filter((r: { requirementId: string | null }) => r.requirementId);
    expect(rows.every((r: { measurementId: string | null }) => r.measurementId)).toBe(true);
    const fromFile = (await readings(h)).filter((r) => r.importId === ctx.import);
    expect(fromFile.map((r) => [r.valueNumeric, r.result, r.gauge?.assetNumber]).sort()).toEqual([['25.02', 'pass', 'CMM-1'], ['40.15', 'fail', 'CMM-1'], [null, 'pass', 'CMM-1']].sort());
    const insp = (await api().get(`/api/v1/inspections/${ctx.inspection}`).set(h).expect(200)).body;
    expect(insp.samples.at(-1)).toMatchObject({ unitReference: 'SN-77', notes: expect.stringMatching(/^From IMP-/) });
    // Frozen once applied.
    await api().post(`/api/v1/inspection-imports/${ctx.import}/discard`).set(h).send({}).expect(409);
    await api().post(`/api/v1/inspection-imports/${ctx.import}/apply`).set(h).send({}).expect(409);
  });

  it('the same file is applied to an inspection once', async () => {
    const h = await as(ids.inspectorA);
    const again = await upload(h, 'report.csv', REPORT);
    await api().post(`/api/v1/inspection-imports/${again.id}/confirm-mismatches`).set(h).expect(200);
    const res = await api().post(`/api/v1/inspection-imports/${again.id}/apply`).set(h).send({}).expect(409);
    expect(res.body.error.message).toMatch(/already imported on this inspection/);
    expect((await api().get(`/api/v1/inspection-imports/${again.id}`).set(h).expect(200)).body.status).toBe('previewed');
  });

  it('a re-measure applied as a retest re-measures the failed reading; a check whose latest reading passed cannot be retested', async () => {
    const h = await as(ids.inspectorA);
    const failed = (await readings(h)).find((r) => r.importId === ctx.import && r.result === 'fail')!;
    const retest = await upload(h, 'retest.csv', file(['Length,2,40.05,39.9,40.1']));
    const res = await api().post(`/api/v1/inspection-imports/${retest.id}/apply`).set(h).send({ mode: 'retest' }).expect(200);
    expect(res.body).toMatchObject({ status: 'applied', applyMode: 'retest' });
    const r = (await readings(h)).find((x) => x.importId === retest.id)!;
    expect(r).toMatchObject({ valueNumeric: '40.05', result: 'pass', retestOfId: failed.id });
    const again = await upload(h, 'retest2.csv', file(['Length,2,40.06,39.9,40.1']));
    const refused = await api().post(`/api/v1/inspection-imports/${again.id}/apply`).set(h).send({ mode: 'retest' }).expect(409);
    expect(refused.body.error.message).toMatch(/latest reading passed/);
  });

  it('a corrected file replaces the readings of that part, with a reason, keeping the originals', async () => {
    const owner = await as(ids.ownerA);
    const original = (await readings(owner)).find((r) => r.importId === ctx.import && r.valueNumeric === '25.02')!;
    const fix = await upload(owner, 'fix.csv', file(['Bore,1,25.01,24.95,25.05']));
    const noReason = await api().post(`/api/v1/inspection-imports/${fix.id}/apply`).set(owner).send({ mode: 'correct' }).expect(409);
    expect(noReason.body.error.message).toMatch(/why the readings are being corrected/);
    await api().post(`/api/v1/inspection-imports/${fix.id}/apply`).set(owner).send({ mode: 'correct', reason: 'Probe was not qualified' }).expect(200);
    const all = await readings(owner);
    const correction = all.find((x) => x.importId === fix.id)!;
    expect(correction).toMatchObject({ valueNumeric: '25.01', supersedesId: original.id, correctionReason: 'Probe was not qualified' });
    expect(all.some((x) => x.id === original.id)).toBe(true);
  });

  it('goes through the sampling plan like typed readings, and a CMM overdue for calibration needs an authorised override with a reason', async () => {
    const owner = await as(ids.ownerA);
    const overdue = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const old = (await api().post('/api/v1/gauges').set(owner).send({ assetNumber: 'CMM-OLD', description: 'Old CMM', siteId: ids.siteA, nextDueOn: overdue }).expect(201)).body.id;
    // A further part: the plan's samples are all taken, and it has no rule for a manual extra.
    const extra = await upload(owner, 'extra.csv', file(['Bore,1,25.0,24.95,25.05']).replace('SN-77', 'SN-80'));
    const done = await api().post(`/api/v1/inspection-imports/${extra.id}/apply`).set(owner).send({}).expect(409);
    expect(done.body.error.message).toMatch(/nothing more to sample/);
    const manual = await api().post(`/api/v1/inspection-imports/${extra.id}/apply`).set(owner).send({ triggerType: 'manual' }).expect(409);
    expect(manual.body.error.message).toMatch(/does not sample this on "manual"/);
    // A correction of SN-77 measured on the overdue CMM.
    const preview = await upload(owner, 'old.csv', file(['Bore,1,25.0,24.95,25.05']));
    const refused = await api().post(`/api/v1/inspection-imports/${preview.id}/apply`).set(owner).send({ mode: 'correct', reason: 'Re-measured', gaugeId: old }).expect(409);
    expect(refused.body.error.message).toMatch(/CMM-OLD is overdue for calibration/);
    const applied = await api().post(`/api/v1/inspection-imports/${preview.id}/apply`).set(owner)
      .send({ mode: 'correct', reason: 'Re-measured', gaugeId: old, gaugeOverrideReason: 'Calibrated yesterday, certificate on its way' }).expect(200);
    expect(applied.body).toMatchObject({ status: 'applied', gauge: { assetNumber: 'CMM-OLD' } });
    const r = (await readings(owner)).find((x) => x.importId === preview.id) as unknown as { gauge: { valid: boolean }; gaugeOverrideReason: string };
    expect(r).toMatchObject({ gauge: { valid: false }, gaugeOverrideReason: 'Calibrated yesterday, certificate on its way' });
  });

  it('a correction for a part that was never measured is refused, and nothing is recorded', async () => {
    const owner = await as(ids.ownerA);
    const before = (await readings(owner)).length;
    const other = await upload(owner, 'other.csv', file(['Bore,1,25.0,24.95,25.05']).replace('SN-77', 'SN-99'));
    const res = await api().post(`/api/v1/inspection-imports/${other.id}/apply`).set(owner).send({ mode: 'correct', reason: 'Wrong offset' }).expect(409);
    expect(res.body.error.message).toMatch(/No sample of this inspection is part SN-99/);
    expect((await readings(owner)).length).toBe(before);
    expect((await api().get(`/api/v1/inspection-imports/${other.id}`).set(owner).expect(200)).body.status).toBe('previewed');
  });
});

describe('QIF files (CM5)', () => {
  // The sample describes part BRK-100; here it is the inspection's part, with balloons 1 and 2 and serial SN-77.
  const qif = (part = 'HSG-1') =>
    SAMPLE_QIF.replace('BRK-100', part).replace('<Designator>12<', '<Designator>1<').replace('<Designator>13<', '<Designator>2<')
      .replace('<TargetValue>25<', '<TargetValue>25<').replace('<Value>0.031<', '<Value>40.05<')
      .replace('<FlatnessCharacteristicDefinition id="11"><ToleranceValue>0.02</ToleranceValue>', '<FlatnessCharacteristicDefinition id="11"><Tolerance><MaxValue>0.1</MaxValue><MinValue>-0.1</MinValue></Tolerance>')
      .replace('<CharacteristicDefinitionId>11</CharacteristicDefinitionId><Name>Face</Name>', '<CharacteristicDefinitionId>11</CharacteristicDefinitionId><Name>Face</Name><TargetValue>40</TargetValue>')
      .replace('SN-7<', 'SN-77<');

  it('needs no profile: the file names its own checks, limits and part, and applies like any other', async () => {
    const owner = await as(ids.ownerA);
    const res = await api().post(`/api/v1/inspections/${ctx.inspection}/imports`).set(owner).send({ path: put('run.qif', qif()), fileName: 'run.qif', gaugeId: ctx.cmm }).expect(201);
    expect(res.body).toMatchObject({
      format: 'qif', profile: null, header: { partNumber: 'HSG-1' },
      counts: { parts: 1, features: 2, matched: 2, toRecord: 2, unmatched: 0, problems: 0, failures: 0, mismatches: 0 },
    });
    expect(res.body.units[0].unitReference).toBe('SN-77');
    expect(res.body.units[0].rows.map((r: { charNumber: string; matchKind: string; expectedResult: string }) => [r.charNumber, r.matchKind, r.expectedResult])).toEqual([['1', 'balloon', 'pass'], ['2', 'balloon', 'pass']]);
    const applied = await api().post(`/api/v1/inspection-imports/${res.body.id}/apply`).set(owner).send({ mode: 'correct', reason: 'Re-run from the QIF export' }).expect(200);
    expect(applied.body.status).toBe('applied');
    const insp = (await api().get(`/api/v1/inspections/${ctx.inspection}`).set(owner).expect(200)).body;
    const fromFile = insp.measurements.filter((m: { importId: string | null }) => m.importId === res.body.id);
    expect(fromFile.map((m: { valueNumeric: string }) => m.valueNumeric).sort()).toEqual(['25.012', '40.05']);
  });

  it('refuses a QIF file for another part, broken XML or a DOCTYPE; a table file still needs a profile', async () => {
    const h = await as(ids.inspectorA);
    const wrong = await api().post(`/api/v1/inspections/${ctx.inspection}/imports`).set(h).send({ path: put('w.qif', qif('OTHER-2')), fileName: 'w.qif' }).expect(409);
    expect(wrong.body.error.message).toMatch(/OTHER-2/);
    const evil = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><QIFDocument>&e;</QIFDocument>';
    const doctype = await api().post(`/api/v1/inspections/${ctx.inspection}/imports`).set(h).send({ path: put('e.xml', evil), fileName: 'e.xml' }).expect(400);
    expect(doctype.body.error).toMatchObject({ code: 'file_unreadable', message: expect.stringMatching(/DOCTYPE/) });
    await api().post(`/api/v1/inspections/${ctx.inspection}/imports`).set(h).send({ path: put('b.qif', '<QIFDocument><a></QIFDocument>'), fileName: 'b.qif' }).expect(400);
    const noProfile = await api().post(`/api/v1/inspections/${ctx.inspection}/imports`).set(h).send({ path: put('t.csv', REPORT), fileName: 't.csv' }).expect(400);
    expect(noProfile.body.error.code).toBe('profile_required');
  });
});

describe('PC-DMIS generic exports', () => {
  it('need no profile: dimensions are read from their lines and matched by a balloon-number label', async () => {
    const h = await as(ids.inspectorA);
    const text = [
      'CIR1, 93.486348, 19.488589, -1.269350, 0.000000, 0.000000, 1.000000, 25.010000',
      '1 AX:D, 25.000000, 0.050000, 0.050000, 25.010000, 0.010000, 0.000000',
      '2 AX:X, 40.000000, 0.100000, 0.100000, 40.250000, 0.250000, 0.150000',
      'LOC1 AX:X, 93.485000, 0.010000, 0.010000, 93.486348, 0.001348, 0.000000',
      'LOC1 AX:Y, 19.500000, 0.010000, 0.010000, 19.488589, -0.011411, 0.001411',
    ].join('\r\n');
    const res = await api().post(`/api/v1/inspections/${ctx.inspection}/imports`).set(h).send({ path: put('generic.txt', text), fileName: 'generic.txt', gaugeId: ctx.cmm }).expect(201);
    expect(res.body).toMatchObject({ format: 'table', profile: null, counts: { parts: 1, features: 4, matched: 2, unmatched: 2, problems: 0, failures: 1, mismatches: 0 } });
    expect(res.body.units[0].rows.map((r: { featureName: string; matchKind: string; expectedResult: string | null }) => [r.featureName, r.matchKind, r.expectedResult])).toEqual([
      ['1 D', 'balloon', 'pass'], ['2 X', 'balloon', 'fail'], ['LOC1 X', 'none', null], ['LOC1 Y', 'none', null],
    ]);
    expect(res.body.warnings.map((w: { message: string }) => w.message).join(' ')).toMatch(/PC-DMIS generic export/);
  });
});
