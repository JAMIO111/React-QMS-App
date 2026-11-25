/**
 * Record filters on import templates (docs/import-filters-plan.md, F1): what a filter does to an uploaded file (every row counted, per rule), a template that keeps a
 * filter (checked against the file's columns, tidied, frozen with the version), an import that reads only the records the filter keeps and lists the others as filtered,
 * a formula filter that cannot be worked out for a record (rejected, not dropped), the mapping preview saying which rows the filter leaves out, and who may ask.
 */
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { strToU8 } from 'fflate';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { IntegrationFileStore } from '../src/integrations/core/file-store';
import { giveControllerSeats, makeIds, requireDb, seed, testEnv, token } from './helpers';

const ids = makeIds('fa');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const owner = () => as(ids.ownerA);
const inspector = () => as(ids.inspectorA);
const other = () => as(ids.ownerB, ids.orgB);
const base = '/api/v1/integrations';

const files = new Map<string, Uint8Array>();
class MemoryStore extends IntegrationFileStore {
  get enabled() {
    return true;
  }
  async download(path: string) {
    return files.get(path) ?? null;
  }
}

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-fl');
  await giveControllerSeats(admin, ids.orgA, [ids.ownerA]);
  await giveControllerSeats(admin, ids.orgB, [ids.ownerB]);
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).overrideProvider(IntegrationFileStore).useValue(new MemoryStore()).compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true }), env);
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('record filters', () => {
  let site: string;
  let connId: string;
  let fileId: string;
  let templateId: string;
  const keepActive = { mode: 'keep', match: 'all', rules: [{ column: 'Status', test: 'equals', value: 'Active' }, { column: 'Type', test: 'not_equals', value: 'Test rig' }] };
  const fields = () => [{ target: 'code', source: 'Ref' }, { target: 'name', source: 'Name' }, { target: 'site', source: 'Site', match: 'code' }];

  beforeAll(async () => {
    site = (await admin.query(`select code from public.sites where organisation_id = $1 order by created_at limit 1`, [ids.orgA])).rows[0].code;
    connId = (await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'csv', name: 'File imports', externalSystem: 'files' }).expect(201)).body.id;
    const text = ['Ref,Name,Site,Status,Type,Qty',
      `F1,One,${site},Active,CNC,5`, `F2,Two,${site},Retired,CNC,7`, `F3,Three,${site},active,Mill,x`, `F4,Four,${site},Active,Test rig,3`, `F5,Five,${site},,CNC,12`].join('\n');
    const path = `${ids.orgA}/integration/${connId}/x-filters.csv`;
    files.set(path, strToU8(text));
    fileId = (await api().post(`${base}/connections/${connId}/files`).set(await owner()).send({ path, fileName: 'machines.csv', size: text.length }).expect(201)).body.id;
  });

  it('says what a filter does to every row of the file, rule by rule, with a few of each', async () => {
    const r = (await api().post(`${base}/templates/filter-preview`).set(await owner()).send({ entityType: 'machine', fileId, filter: keepActive }).expect(200)).body;
    expect(r).toMatchObject({
      scanned: 5, complete: true, kept: 2, leftOut: 3, problems: [], errors: { count: 0, first: null },
      words: 'Keep records where Status is "Active" and Type is not "Test rig"',
    });
    // Status is Active (any case) for F1, F3, F4; Type is not Test rig for F1, F2, F3, F5
    expect(r.rules).toEqual([{ column: 'Status', words: 'Status is "Active"', matched: 3 }, { column: 'Type', words: 'Type is not "Test rig"', matched: 4 }]);
    expect(r.samples.kept.map((s: { row: number }) => s.row)).toEqual([2, 4]);
    expect(r.samples.leftOut.map((s: { row: number }) => s.row)).toEqual([3, 5, 6]);
    expect(Object.keys(r.samples.kept[0].values).slice(0, 2)).toEqual(['Status', 'Type']);
  });

  it('works from "leave out", "any", numbers and a formula', async () => {
    const run = async (filter: unknown) => (await api().post(`${base}/templates/filter-preview`).set(await owner()).send({ entityType: 'machine', fileId, filter }).expect(200)).body;
    expect((await run({ mode: 'leave_out', match: 'any', rules: [{ column: 'Status', test: 'equals', value: 'Retired' }, { column: 'Status', test: 'is_empty' }] }))).toMatchObject({ kept: 3, leftOut: 2 });
    expect((await run({ mode: 'keep', match: 'all', rules: [{ column: 'Qty', test: 'gte', value: '5', as: 'number' }] }))).toMatchObject({ kept: 3, leftOut: 2 });
    const formula = await run({ mode: 'leave_out', match: 'all', rules: [], formula: 'IN([Type], "Test rig", "Mill")' });
    expect(formula).toMatchObject({ kept: 3, leftOut: 2, rules: [] });
    // a formula that cannot be worked out for a record: it is not read, and the answer says why
    const failing = await run({ mode: 'keep', match: 'all', rules: [], formula: '[Qty] / 0 = 1' });
    expect(failing.errors.count).toBeGreaterThan(0);
    expect(failing.errors.first).toMatch(/^Filter formula: /);
  });

  it('says what is wrong with a filter, in words, and counts nothing for it', async () => {
    const r = (await api().post(`${base}/templates/filter-preview`).set(await owner()).send({ entityType: 'machine', fileId, filter: { mode: 'keep', match: 'all', rules: [{ column: 'Stauts', test: 'equals', value: 'Active' }] } }).expect(200)).body;
    expect(r.problems).toEqual(['Rule 1: the column Stauts is not in the source — did you mean Status?']);
    expect(r).toMatchObject({ kept: 0, leftOut: 0 });
    // no rules and no formula is no filter
    expect((await api().post(`${base}/templates/filter-preview`).set(await owner()).send({ entityType: 'machine', fileId, filter: { mode: 'keep', match: 'all', rules: [] } }).expect(200)).body)
      .toMatchObject({ kept: 5, leftOut: 0, words: 'No filter: every record is read', rules: [] });
  });

  it('is for people who may run imports, and only for their own files', async () => {
    const body = { entityType: 'machine', fileId, filter: keepActive };
    await api().post(`${base}/templates/filter-preview`).set(await inspector()).send(body).expect(403);
    await api().post(`${base}/templates/filter-preview`).set(await other()).send(body).expect(404);
    await api().post(`${base}/templates/filter-preview`).set(await owner()).send({ ...body, fileId: undefined }).expect(400);
    await api().post(`${base}/templates/filter-preview`).set(await owner()).send({ ...body, filter: { ...keepActive, rules: [{ column: 'A', test: 'equals', value: 'x', sql: '1=1' }] } }).expect(400);
    await api().post(`${base}/templates/filter-preview`).set(await owner()).send({ ...body, filter: { ...keepActive, mode: 'drop' } }).expect(400);
    await api().post(`${base}/templates/filter-preview`).set(await owner()).send({ ...body, fileId: '00000000-0000-4000-8000-000000000000' }).expect(404);
  });

  it('keeps a filter on the template version, tidied and checked against the file\'s columns', async () => {
    const body = { entityType: 'machine', name: 'Active machines', keyField: 'Ref', expectedColumns: ['Ref', 'Name', 'Site', 'Status', 'Type', 'Qty'], fields: fields(), settings: { writeMode: 'add_only' } };
    const bad = await api().post(`${base}/templates`).set(await owner()).send({ ...body, settings: { filters: { ...keepActive, rules: [{ column: 'Stauts', test: 'equals', value: 'Active' }] } } }).expect(409);
    expect(bad.body.error.message).toMatch(/Stauts is not in the source — did you mean Status/);
    // an empty rule is dropped; a filter left with nothing is no filter at all
    const none = (await api().post(`${base}/templates`).set(await owner()).send({ ...body, name: 'Nothing', settings: { filters: { mode: 'keep', match: 'all', rules: [{ column: '  ', test: 'equals', value: 'x' }] } } }).expect(201)).body;
    expect(none.current.settings.filters).toBeUndefined();
    const t = (await api().post(`${base}/templates`).set(await owner()).send({ ...body, settings: { filters: { ...keepActive, rules: [{ column: ' Status ', test: 'equals', value: ' Active ' }, ...keepActive.rules.slice(1)] } } }).expect(201)).body;
    templateId = t.id;
    expect(t.current.settings.filters).toEqual(keepActive);
    // another version with a different filter needs a reason, and the old version keeps its own
    const { entityType: _e, name: _n, ...vbody } = body;
    const v2 = (await api().post(`${base}/templates/${templateId}/versions`).set(await owner()).send({ ...vbody, settings: { filters: { ...keepActive, match: 'any' } }, reason: 'Either will do' }).expect(201)).body;
    expect(v2.current.settings.filters.match).toBe('any');
    const v1 = (await api().get(`${base}/templates/${templateId}/versions/1`).set(await owner()).expect(200)).body;
    expect(v1.settings.filters).toEqual(keepActive);
    await api().post(`${base}/templates/${templateId}/versions`).set(await owner()).send({ ...vbody, settings: { filters: { ...keepActive, match: 'any' } }, reason: 'Same again' }).expect(409);
    // bring the first version back
    const back = (await api().post(`${base}/templates/${templateId}/restore-version`).set(await owner()).send({ version: 1, reason: 'Back to both' }).expect(200)).body;
    expect(back.current.settings.filters).toEqual(keepActive);
  });

  it('shows the mapping preview which rows the filter leaves out, and why', async () => {
    const r = (await api().post(`${base}/templates/preview`).set(await owner()).send({ entityType: 'machine', fileId, keyField: 'Ref', fields: fields(), settings: { filters: keepActive } }).expect(200)).body;
    expect(r.rows.map((x: { filteredOut: string | null }) => x.filteredOut)).toEqual([
      null,
      'Filtered out: does not meet Status is "Active" and Type is not "Test rig"',
      null,
      'Filtered out: does not meet Status is "Active" and Type is not "Test rig"',
      'Filtered out: does not meet Status is "Active" and Type is not "Test rig"',
    ]);
    expect(r.rows[1].errors).toEqual([]);
    const none = (await api().post(`${base}/templates/preview`).set(await owner()).send({ entityType: 'machine', fileId, keyField: 'Ref', fields: fields() }).expect(200)).body;
    expect(none.rows.every((x: { filteredOut: string | null }) => x.filteredOut === null)).toBe(true);
  });

  it('imports only the records the filter keeps, and lists the others as filtered', async () => {
    const preview = (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'machine', kind: 'preview', fileId, templateId }).expect(201)).body;
    expect(preview.counts).toMatchObject({ total: 5, created: 2, skipped: 3, filtered: 3 });
    const real = (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'machine', kind: 'full', fileId, templateId }).expect(201)).body;
    expect(real).toMatchObject({ status: 'succeeded', counts: { total: 5, created: 2, skipped: 3, filtered: 3, rejected: 0 }, settings: { filters: keepActive } });
    expect((await admin.query(`select code from public.machines where organisation_id = $1 and code like 'F%' order by code`, [ids.orgA])).rows.map((r) => r.code)).toEqual(['F1', 'F3']);
    const skipped = (await api().get(`${base}/runs/${real.id}/rows?status=skipped`).set(await owner()).expect(200)).body;
    expect(skipped.total).toBe(3);
    expect(JSON.stringify(skipped.data.map((r: { errors: unknown }) => r.errors))).toMatch(/Filtered out: does not meet Status is \\"Active\\"/);
    // the filtered records are in the inbox marked as filtered, with the source's own identifier kept apart
    const marked = (await admin.query(`select filtered, source_external_id from public.integration_inbox where run_id = $1 and status = 'skipped' order by source_external_id`, [real.id])).rows;
    expect(marked).toEqual([{ filtered: true, source_external_id: 'F2' }, { filtered: true, source_external_id: 'F4' }, { filtered: true, source_external_id: 'F5' }]);
    // the run page asks for them directly: only the filtered rows, each saying why, paged, with a true total
    const listed = (await api().get(`${base}/runs/${real.id}/rows?filtered=true`).set(await owner()).expect(200)).body;
    expect(listed.total).toBe(3);
    expect(listed.data.every((r: { filtered: boolean; status: string }) => r.filtered && r.status === 'skipped')).toBe(true);
    for (const r of listed.data as { errors: { message: string }[] }[]) expect(r.errors[0].message).toMatch(/^Filtered out: does not meet Status is "Active"/);
    const paged = (await api().get(`${base}/runs/${real.id}/rows?filtered=true&pageSize=2&page=2`).set(await owner()).expect(200)).body;
    expect(paged).toMatchObject({ total: 3, page: 2 });
    expect(paged.data).toHaveLength(1);
    // kept rows are marked as not filtered
    const applied = (await api().get(`${base}/runs/${real.id}/rows?status=applied`).set(await owner()).expect(200)).body;
    expect(applied.data.every((r: { filtered: boolean }) => r.filtered === false)).toBe(true);
    // somebody who cannot read integrations sees none of it
    await api().get(`${base}/runs/${real.id}/rows?filtered=true`).set(await inspector()).expect(403);
    await api().get(`${base}/runs/${real.id}/rows?filtered=true`).set(await other()).expect(404);
  });

  it('flags in the health card an import whose filter left out everything, or nearly everything, that was read', async () => {
    // the run just made by the previous test keeps F1 only (4 of 5 left out): not yet a flag (fewer than 10 records)
    const health = async () => (await api().get(`${base}/health`).set(await owner()).expect(200)).body.data.find((h: { connectionId: string; entityType: string }) => h.connectionId === connId && h.entityType === 'machine');
    const before = await health();
    expect(before.lastRun).toMatchObject({ recordsTotal: 5 });
    expect(before.filterLeftOut).toBeNull();
    // a read that leaves out every record it read is flagged, whatever its size
    await admin.query(`update public.integration_sync_runs set filtered = records_total, requested_at = now() + interval '1 day' where id = (select id from public.integration_sync_runs where connection_id = $1 and kind <> 'preview' order by requested_at desc limit 1)`, [connId]);
    const all = await health();
    expect(all.filterLeftOut).toBe('all');
    expect(all.state).not.toBe('ok');
    // 9 of 10 is "most"
    await admin.query(`update public.integration_sync_runs set records_total = 10, filtered = 9 where id = (select id from public.integration_sync_runs where connection_id = $1 and kind <> 'preview' order by requested_at desc limit 1)`, [connId]);
    expect((await health()).filterLeftOut).toBe('most');
    await admin.query(`update public.integration_sync_runs set filtered = 8 where id = (select id from public.integration_sync_runs where connection_id = $1 and kind <> 'preview' order by requested_at desc limit 1)`, [connId]);
    expect((await health()).filterLeftOut).toBeNull();
  });

  it('never calls a record the filter leaves out "no longer in the source"', async () => {
    // F1 and F3 are imported; a new read with the filter now keeping only F1 leaves F3 filtered, which is not missing
    await api().put(`${base}/connections/${connId}/settings`).set(await owner()).send({ entityType: 'machine', onMissing: 'list' }).expect(200);
    const narrower = (await api().post(`${base}/templates/${templateId}/versions`).set(await owner()).send({
      keyField: 'Ref', fields: fields(), expectedColumns: ['Ref', 'Name', 'Site', 'Status', 'Type', 'Qty'], settings: { filters: { mode: 'keep', match: 'all', rules: [{ column: 'Ref', test: 'equals', value: 'F1' }] } }, reason: 'Only the first',
    }).expect(201)).body;
    expect(narrower.currentVersion).toBeGreaterThan(1);
    const run = (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'machine', kind: 'full', fileId, templateId }).expect(201)).body;
    expect(run.counts).toMatchObject({ total: 5, filtered: 4 });
    expect((await admin.query(`select count(*)::int as n from public.integration_missing_records where connection_id = $1`, [connId])).rows[0].n).toBe(0);
  });

  it('rejects a record whose filter formula cannot be worked out, rather than quietly dropping it', async () => {
    const t = (await api().post(`${base}/templates`).set(await owner()).send({
      entityType: 'machine', name: 'Odd formula', keyField: 'Ref', fields: fields(), settings: { filters: { mode: 'keep', match: 'all', rules: [], formula: '[Qty] / 0 = 1' } },
    }).expect(201)).body;
    const run = (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'machine', kind: 'preview', fileId, templateId: t.id }).expect(201)).body;
    expect(run.counts).toMatchObject({ total: 5, rejected: 5, filtered: 0 });
    const rows = (await api().get(`${base}/runs/${run.id}/rows?status=rejected`).set(await owner()).expect(200)).body.data;
    expect(JSON.stringify(rows[0].errors)).toMatch(/Filter formula: /);
  });
});
