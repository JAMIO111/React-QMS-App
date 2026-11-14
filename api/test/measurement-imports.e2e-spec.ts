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
