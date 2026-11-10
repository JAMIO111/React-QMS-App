/**
 * Import templates (UI2a) through the API: organisation-wide templates with frozen versions (create, a new version needs a reason and must change something,
 * bring back an earlier version, duplicate, rename, archive and restore), the mapping checked against the catalogue before saving, writes only for people who
 * manage integrations, and an import run with a template: pinned to the version it used, its steps applied to every row, its import settings frozen.
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

const ids = makeIds('4e');
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
  await seed(admin, ids, '-tp');
  await giveControllerSeats(admin, ids.orgA, [ids.ownerA]);
  await giveControllerSeats(admin, ids.orgB, [ids.ownerB]);
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).overrideProvider(IntegrationFileStore).useValue(new MemoryStore()).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true });
  app = configureApp(nest, env);
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('import templates', () => {
  let site: string;
  let templateId: string;
  let connId: string;
  const fields = () => [
    { target: 'code', source: 'Ref', steps: [{ kind: 'trim' }, { kind: 'upper' }, { kind: 'prefix', text: 'M-' }] },
    { target: 'name', source: 'Description', steps: [{ kind: 'title' }] },
    { target: 'site', source: 'Site', match: 'code' },
  ];

  beforeAll(async () => {
    site = (await admin.query(`select code from public.sites where organisation_id = $1 order by created_at limit 1`, [ids.orgA])).rows[0].code;
  });

  it('creates a template with its first version, checked against the catalogue', async () => {
    const bad = await api().post(`${base}/templates`).set(await owner()).send({ entityType: 'machine', name: 'Old MES machines', keyField: 'Ref', fields: [{ target: 'name', source: 'Description', steps: [{ kind: 'replace' }] }] }).expect(409);
    expect(bad.body.error.details.problems).toEqual(expect.arrayContaining([expect.stringMatching(/^Code/), 'Name, step 1 (replace): say what to find']));
    await api().post(`${base}/templates`).set(await owner()).send({ entityType: 'machine', name: 'X', keyField: 'Ref', fields: [{ target: 'code', source: 'Ref', steps: [{ kind: 'shout' }] }] }).expect(400);
    const cols = await api().post(`${base}/templates`).set(await owner()).send({ entityType: 'machine', name: 'X', keyField: 'Ref', expectedColumns: ['Ref'], fields: fields() }).expect(409);
    expect(cols.body.error.message).toMatch(/Description/);

    const t = (await api().post(`${base}/templates`).set(await owner()).send({
      entityType: 'machine', name: 'Old MES machines', description: 'The weekly export', keyField: 'Ref', fields: fields(),
      expectedColumns: ['Ref', 'Description', 'Site'], sourceSettings: { delimiter: ';' }, settings: { writeMode: 'add_update', matchExisting: true },
    }).expect(201)).body;
    templateId = t.id;
    expect(t).toMatchObject({ name: 'Old MES machines', description: 'The weekly export', currentVersion: 1, archived: null, canManage: true, runCount: 0 });
    expect(t.current).toMatchObject({ version: 1, keyField: 'Ref', expectedColumns: ['Ref', 'Description', 'Site'], sourceSettings: { delimiter: ';' }, settings: { writeMode: 'add_update', matchExisting: true }, reason: null, current: true });
    expect(t.current.fields[0].steps).toHaveLength(3);
    const dup = await api().post(`${base}/templates`).set(await owner()).send({ entityType: 'machine', name: 'old mes MACHINES', keyField: 'Ref', fields: fields() });
    expect(dup.status).toBe(409);
  });

  it('only people who manage integrations write templates, and another organisation sees nothing', async () => {
    await api().post(`${base}/templates`).set(await inspector()).send({ entityType: 'machine', name: 'Mine', keyField: 'Ref', fields: fields() }).expect(403);
    await api().get(`${base}/templates/${templateId}`).set(await other()).expect(404);
    await api().post(`${base}/templates/${templateId}/versions`).set(await other()).send({ keyField: 'Ref', fields: fields(), reason: 'Mine now' }).expect(404);
    expect((await api().get(`${base}/templates`).set(await other()).expect(200)).body.data).toEqual([]);
  });

  it('a new version needs a reason and a change; an earlier one can be brought back', async () => {
    await api().post(`${base}/templates/${templateId}/versions`).set(await owner()).send({ keyField: 'Ref', fields: fields() }).expect(400);
    const same = await api().post(`${base}/templates/${templateId}/versions`).set(await owner()).send({
      keyField: 'Ref', fields: fields(), expectedColumns: ['Ref', 'Description', 'Site'], sourceSettings: { delimiter: ';' }, settings: { writeMode: 'add_update', matchExisting: true }, reason: 'No change',
    }).expect(409);
    expect(same.body.error.code).toBe('integration_rule');
    const changed = fields();
    changed[1].steps = [{ kind: 'upper' }];
    const v2 = (await api().post(`${base}/templates/${templateId}/versions`).set(await owner()).send({ keyField: 'Ref', fields: changed, settings: { writeMode: 'add_update', matchExisting: true }, reason: 'Names in capitals' }).expect(201)).body;
    expect(v2).toMatchObject({ currentVersion: 2, current: { version: 2, reason: 'Names in capitals' } });
    const list = (await api().get(`${base}/templates/${templateId}/versions`).set(await owner()).expect(200)).body.data;
    expect(list.map((v: { version: number; current: boolean; fieldCount: number }) => [v.version, v.current, v.fieldCount])).toEqual([[2, true, 3], [1, false, 3]]);
    const v1 = (await api().get(`${base}/templates/${templateId}/versions/1`).set(await owner()).expect(200)).body;
    expect(v1.fields[1].steps).toEqual([{ kind: 'title' }]);
    await api().get(`${base}/templates/${templateId}/versions/9`).set(await owner()).expect(404);
    const v3 = (await api().post(`${base}/templates/${templateId}/restore-version`).set(await owner()).send({ version: 1, reason: 'Capitals were a mistake' }).expect(200)).body;
    expect(v3).toMatchObject({ currentVersion: 3, current: { reason: 'Capitals were a mistake' } });
    expect(v3.current.fields[1].steps).toEqual([{ kind: 'title' }]);
  });

  it('renames, duplicates, archives and restores', async () => {
    const renamed = (await api().patch(`${base}/templates/${templateId}`).set(await owner()).send({ name: 'MES machines' }).expect(200)).body;
    expect(renamed).toMatchObject({ name: 'MES machines', description: 'The weekly export', currentVersion: 3 });
    const copy = (await api().post(`${base}/templates/${templateId}/duplicate`).set(await owner()).send({}).expect(201)).body;
    expect(copy).toMatchObject({ name: 'Copy of MES machines', currentVersion: 1 });
    expect(copy.current.fields).toEqual(renamed.current.fields);
    await api().post(`${base}/templates/${copy.id}/archive`).set(await owner()).send({}).expect(400);
    const archived = (await api().post(`${base}/templates/${copy.id}/archive`).set(await owner()).send({ reason: 'Not needed' }).expect(200)).body;
    expect(archived.archived).toMatchObject({ reason: 'Not needed', by: { id: ids.ownerA } });
    const shown = (await api().get(`${base}/templates?entityType=machine`).set(await owner()).expect(200)).body.data.map((t: { id: string }) => t.id);
    expect(shown).toEqual([templateId]);
    const all = (await api().get(`${base}/templates?archived=include`).set(await owner()).expect(200)).body.data;
    expect(all).toHaveLength(2);
    await api().post(`${base}/templates/${copy.id}/versions`).set(await owner()).send({ keyField: 'Ref', fields: fields().slice(0, 1).concat(fields()[2]), reason: 'Fewer fields' }).expect(409);
    await api().post(`${base}/templates/${copy.id}/restore`).set(await owner()).expect(200);
    await api().post(`${base}/templates/${copy.id}/archive`).set(await owner()).send({ reason: 'Archived again' }).expect(200);
  });

  it('an import with a template applies its steps, is pinned to its version and freezes its settings', async () => {
    connId = (await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'csv', name: 'File imports', externalSystem: 'files' }).expect(201)).body.id;
    const text = ['Ref;Description;Site', ` cnc7 ;big LATHE;${site}`, `mill9;small mill;${site}`].join('\n');
    const path = `${ids.orgA}/integration/${connId}/x-machines.csv`;
    files.set(path, strToU8(text));
    const fileId = (await api().post(`${base}/connections/${connId}/files`).set(await owner()).send({ path, fileName: 'machines.csv', size: text.length, options: { delimiter: ';' } }).expect(201)).body.id;

    const wrongKind = await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'part', kind: 'preview', fileId, templateId }).expect(409);
    expect(wrongKind.body.error.message).toMatch(/another kind of record/);
    const archived = (await api().get(`${base}/templates?archived=only`).set(await owner()).expect(200)).body.data[0].id;
    await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'machine', kind: 'preview', fileId, templateId: archived }).expect(409);

    const run = (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'machine', kind: 'full', fileId, templateId }).expect(201)).body;
    expect(run).toMatchObject({ status: 'succeeded', counts: { total: 2, created: 2 }, template: { id: templateId, name: 'MES machines', version: 3 }, mappingVersion: null, settings: { writeMode: 'add_update', matchExisting: true } });
    const rows = (await admin.query(`select code, name from public.machines where organisation_id = $1 and code like 'M-%' order by code`, [ids.orgA])).rows;
    expect(rows).toEqual([{ code: 'M-CNC7', name: 'Big Lathe' }, { code: 'M-MILL9', name: 'Small Mill' }]);
    const got = (await api().get(`${base}/runs/${run.id}`).set(await owner()).expect(200)).body;
    expect(got.template).toEqual({ id: templateId, name: 'MES machines', version: 3 });

    // A later version does not change what the earlier run used.
    const changed = fields();
    changed[1].steps = [{ kind: 'lower' }];
    await api().post(`${base}/templates/${templateId}/versions`).set(await owner()).send({ keyField: 'Ref', fields: changed, settings: { writeMode: 'add_update', matchExisting: true }, reason: 'Lower case names' }).expect(201);
    expect((await api().get(`${base}/runs/${run.id}`).set(await owner()).expect(200)).body.template.version).toBe(3);
    const t = (await api().get(`${base}/templates/${templateId}`).set(await owner()).expect(200)).body;
    expect(t).toMatchObject({ runCount: 1, currentVersion: 4 });
    expect(t.lastUsedAt).not.toBeNull();
    const versions = (await api().get(`${base}/templates/${templateId}/versions`).set(await owner()).expect(200)).body.data;
    expect(versions.find((v: { version: number }) => v.version === 3).runCount).toBe(1);

    const second = (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'machine', kind: 'full', fileId, templateId }).expect(201)).body;
    expect(second).toMatchObject({ counts: { updated: 2 }, template: { version: 4 } });
    expect((await admin.query(`select name from public.machines where organisation_id = $1 and code = 'M-CNC7'`, [ids.orgA])).rows[0].name).toBe('big lathe');
  });

  it('a step that fails rejects only its row, with the field name', async () => {
    const t = (await api().post(`${base}/templates`).set(await owner()).send({
      entityType: 'machine', name: 'Strict codes', keyField: 'Ref',
      fields: [{ target: 'code', source: 'Ref', steps: [{ kind: 'map', values: { cnc7: 'CNC-7' }, unmatched: 'error' }] }, { target: 'name', source: 'Description' }, { target: 'site', source: 'Site', match: 'code' }],
    }).expect(201)).body;
    const fileId = (await api().get(`${base}/connections/${connId}/files`).set(await owner()).expect(200)).body.data[0].id;
    const run = (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'machine', kind: 'preview', fileId, templateId: t.id }).expect(201)).body;
    expect(run.counts).toMatchObject({ total: 2, skipped: 1, rejected: 1 }); // cnc7 was imported before and this template only adds new records
    const rejected = (await api().get(`${base}/runs/${run.id}/rows?status=rejected`).set(await owner()).expect(200)).body.data;
    expect(rejected[0].errors[0]).toMatchObject({ field: 'code', message: 'Code: "mill9" is not in the translation list' });
  });
});

describe('formulas and the preview (UI2b)', () => {
  let connId: string;
  let fileId: string;
  let site: string;
  beforeAll(async () => {
    site = (await admin.query(`select code from public.sites where organisation_id = $1 order by created_at limit 1`, [ids.orgA])).rows[0].code;
    connId = (await api().get(`${base}/connections`).set(await owner()).expect(200)).body.data.find((c: { name: string }) => c.name === 'File imports').id;
    const text = ['Ref;Description;Site;Qty;Status', ` p1 ;big LATHE;${site};3;In use`, `p2;small mill;${site};x;Scrapped`, `p3;;${site};4;In use`].join('\n');
    const path = `${ids.orgA}/integration/${connId}/x-preview.csv`;
    files.set(path, strToU8(text));
    fileId = (await api().post(`${base}/connections/${connId}/files`).set(await owner()).send({ path, fileName: 'preview.csv', size: text.length, options: { delimiter: ';' } }).expect(201)).body.id;
  });

  it('lists the functions and checks a formula: position, columns, did-you-mean, sample result', async () => {
    const fns = (await api().get(`${base}/formulas/functions`).set(await owner()).expect(200)).body.data;
    expect(fns.find((f: { name: string }) => f.name === 'IF')).toMatchObject({ usage: 'IF(test, then, else)', minArgs: 2, maxArgs: 3 });
    const ok = (await api().post(`${base}/formulas/check`).set(await owner()).send({ formula: 'IF([Status] = "Scrapped", "no", "yes")', columns: ['Status'], sample: { Status: 'Scrapped' } }).expect(200)).body;
    expect(ok).toEqual({ ok: true, error: null, columns: ['Status'], functions: ['IF'], result: { value: 'no', error: null } });
    const typo = (await api().post(`${base}/formulas/check`).set(await owner()).send({ formula: '[Stauts]', columns: ['Status'] }).expect(200)).body;
    expect(typo.error).toEqual({ message: 'Column [Stauts] is not in the file — did you mean [Status]?', position: null });
    const syntax = (await api().post(`${base}/formulas/check`).set(await owner()).send({ formula: 'IF(1, 2', sample: {} }).expect(200)).body;
    expect(syntax).toMatchObject({ ok: false, error: { position: 8 }, result: null });
    const failing = (await api().post(`${base}/formulas/check`).set(await owner()).send({ formula: '[Qty] * 2', sample: { Qty: 'x' } }).expect(200)).body;
    expect(failing.result).toEqual({ value: null, error: '* needs a number, got "x"' });
    await api().post(`${base}/formulas/check`).set(await owner()).send({ formula: 'x'.repeat(2001) }).expect(400);
    await api().post(`${base}/formulas/check`).set(await inspector()).send({ formula: '1' }).expect(403);
  });

  it('previews an unsaved template row by row: value taken, after each step, imported value and errors', async () => {
    const res = (await api().post(`${base}/templates/preview`).set(await owner()).send({
      entityType: 'machine', fileId, keyField: 'Ref',
      fields: [
        { target: 'code', formula: 'CONCAT("P-", [Ref])', steps: [{ kind: 'trim' }, { kind: 'upper' }] },
        { target: 'name', source: 'Description', steps: [{ kind: 'title' }] },
        { target: 'site', source: 'Site', match: 'code' },
        { target: 'active', formula: '[Status] <> "Scrapped"' },
        { target: 'description', formula: 'IF(ISEMPTY([Qty]), "", "Qty " & ([Qty] * 2))' },
      ],
    }).expect(200)).body;
    expect(res.columns).toEqual(['Ref', 'Description', 'Site', 'Qty', 'Status']);
    expect(res.columnCheck).toEqual({ missing: [], unused: [] });
    expect(res.problems).toEqual([]);
    expect(res.rows).toHaveLength(3);
    const [r1, r2, r3] = res.rows;
    expect(r1.externalId).toBe('p1');
    expect(r1.fields[0]).toEqual({ target: 'code', label: 'Code', taken: 'P-p1', steps: ['P-p1', 'P-P1'], value: 'P-P1', error: null });
    expect(r1.fields[1]).toMatchObject({ taken: 'big LATHE', steps: ['Big Lathe'], value: 'Big Lathe' });
    expect(r1.fields[3]).toMatchObject({ value: true });
    expect(r1.errors).toEqual([]);
    expect(r2.fields[3]).toMatchObject({ value: false });
    expect(r2.fields[4]).toMatchObject({ taken: null, value: null, error: '* needs a number, got "x"' });
    expect(r2.errors).toEqual([expect.objectContaining({ field: 'description' })]);
    expect(r3.fields[1]).toMatchObject({ taken: '', value: null, error: 'Name is required' });

    const one = (await api().post(`${base}/templates/preview`).set(await owner()).send({ entityType: 'machine', fileId, keyField: 'Ref', fields: [{ target: 'code', source: 'Ref' }], rows: [3] }).expect(200)).body;
    expect(one.rows.map((r: { row: number }) => r.row)).toEqual([3]);
  });

  it('reports the column check: missing columns (blocking for required fields) and unused ones, and the template problems', async () => {
    const res = (await api().post(`${base}/templates/preview`).set(await owner()).send({
      entityType: 'machine', fileId, keyField: 'Ref',
      fields: [{ target: 'code', formula: '[Reference] & [Ref]' }, { target: 'name', source: 'Descr' }, { target: 'site', source: 'Site', match: 'code' }],
    }).expect(200)).body;
    expect(res.columnCheck.missing).toEqual([{ column: 'Reference', fields: ['Code'], blocking: true }, { column: 'Descr', fields: ['Name'], blocking: true }]);
    expect(res.columnCheck.unused).toEqual(['Description', 'Qty', 'Status']);
    expect(res.problems).toEqual(expect.arrayContaining(['Code: Column [Reference] is not in the file', 'Name: the column "Descr" is not in the file']));
  });

  it('a template with a formula saves, imports and is refused when the formula is wrong; nothing for another organisation', async () => {
    const bad = await api().post(`${base}/templates`).set(await owner()).send({ entityType: 'machine', name: 'Formula machines', keyField: 'Ref', fields: [{ target: 'code', formula: 'UPPPER([Ref])' }, { target: 'name', source: 'Description' }, { target: 'site', source: 'Site', match: 'code' }] }).expect(409);
    expect(bad.body.error.message).toBe('Code: Position 1: there is no function UPPPER — did you mean UPPER?');
    const t = (await api().post(`${base}/templates`).set(await owner()).send({
      entityType: 'machine', name: 'Formula machines', keyField: 'Ref',
      fields: [{ target: 'code', formula: 'UPPER("F-" & [Ref])' }, { target: 'name', formula: 'COALESCE([Description], "Unnamed " & [Ref])' }, { target: 'site', source: 'Site', match: 'code' }],
    }).expect(201)).body;
    const run = (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'machine', kind: 'full', fileId, templateId: t.id }).expect(201)).body;
    expect(run.counts).toMatchObject({ total: 3, created: 3 });
    const rows = (await admin.query(`select code, name from public.machines where organisation_id = $1 and code like 'F-%' order by code`, [ids.orgA])).rows;
    expect(rows).toEqual([{ code: 'F-P1', name: 'big LATHE' }, { code: 'F-P2', name: 'small mill' }, { code: 'F-P3', name: 'Unnamed p3' }]);
    await api().post(`${base}/templates/preview`).set(await other()).send({ entityType: 'machine', fileId, keyField: 'Ref', fields: [] }).expect(404);
    await api().post(`${base}/templates/preview`).set(await inspector()).send({ entityType: 'machine', fileId, keyField: 'Ref', fields: [] }).expect(403);
  });
});
