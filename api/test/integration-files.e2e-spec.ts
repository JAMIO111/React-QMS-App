/**
 * Integrations IN3 through the API with an in-memory file store: upload a CSV or Excel file, read it, map its columns (versions, reasons, problems listed),
 * preview an import of it with the right counts and row errors, and nothing is written; a real import is refused until an importer exists; tenancy.
 */
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { strToU8, zipSync } from 'fflate';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { IntegrationFileStore } from '../src/integrations/core/file-store';
import { giveControllerSeats, makeIds, requireDb, seed, testEnv, token } from './helpers';

const ids = makeIds('3f');
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

const CSV = ['Account;Supplier name;Type;Country;E-mail', 'S-1;Alpha Ltd;MFG;gb;q@alpha.example', 'S-2;Bravo;Sub-con;;', 'S-3;;MFG;FR;', 'S-4;Delta;Unknown;XX;not-an-email', ';No account;MFG;GB;'].join('\r\n');

function xlsx(): Uint8Array {
  return zipSync({
    'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="Parts" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/sharedStrings.xml': strToU8('<sst><si><t>Part no</t></si><si><t>Description</t></si><si><t>Bracket</t></si></sst>'),
    'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>1001</v></c><c r="B2" t="s"><v>2</v></c></row></sheetData></worksheet>'),
  });
}

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-if');
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

describe('file imports', () => {
  let connId: string;
  let fileId: string;
  const folder = () => `${ids.orgA}/integration/${connId}/`;

  it('lists the kinds of record and their fields', async () => {
    const res = (await api().get(`${base}/entities`).set(await owner()).expect(200)).body.data;
    expect(res.map((e: { entityType: string }) => e.entityType)).toEqual(['supplier', 'customer', 'part']);
    const code = res[0].fields.find((f: { key: string }) => f.key === 'code');
    expect(code).toMatchObject({ required: true, type: 'text', maxLength: 40 });
  });

  it('reads an uploaded CSV with the connection settings and keeps its rows', async () => {
    connId = (await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'csv', name: 'ERP export', externalSystem: 'erp', config: { delimiter: ';' } }).expect(201)).body.id;
    files.set(`${folder()}u1-suppliers.csv`, strToU8(CSV));
    await api().post(`${base}/connections/${connId}/files`).set(await inspector()).send({ path: `${folder()}u1-suppliers.csv`, fileName: 'suppliers.csv', size: CSV.length }).expect(403);
    await api().post(`${base}/connections/${connId}/files`).set(await owner()).send({ path: `${ids.orgB}/integration/${connId}/x.csv`, fileName: 'x.csv', size: 1 }).expect(409);
    const file = (await api().post(`${base}/connections/${connId}/files`).set(await owner()).send({ path: `${folder()}u1-suppliers.csv`, fileName: 'suppliers.csv', size: CSV.length }).expect(201)).body;
    fileId = file.id;
    expect(file).toMatchObject({ status: 'parsed', rowCount: 5, headers: ['Account', 'Supplier name', 'Type', 'Country', 'E-mail'], error: null });
    expect(file.sample[0]).toEqual({ row: 2, values: { Account: 'S-1', 'Supplier name': 'Alpha Ltd', Type: 'MFG', Country: 'gb', 'E-mail': 'q@alpha.example' } });
    expect((await api().get(`${base}/connections/${connId}/files`).set(await owner()).expect(200)).body.data).toHaveLength(1);
  });

  it('reads the first sheet of a workbook, and keeps a file it cannot read as failed with the reason', async () => {
    files.set(`${folder()}u2-parts.xlsx`, xlsx());
    const parts = (await api().post(`${base}/connections/${connId}/files`).set(await owner()).send({ path: `${folder()}u2-parts.xlsx`, fileName: 'parts.xlsx', size: 900 }).expect(201)).body;
    expect(parts).toMatchObject({ status: 'parsed', sheet: 'Parts', headers: ['Part no', 'Description'], rowCount: 1 });
    expect(parts.sample[0].values).toEqual({ 'Part no': '1001', Description: 'Bracket' });
    files.set(`${folder()}u3-bad.xlsx`, strToU8('this is not a workbook'));
    const bad = (await api().post(`${base}/connections/${connId}/files`).set(await owner()).send({ path: `${folder()}u3-bad.xlsx`, fileName: 'bad.xlsx', size: 22 }).expect(201)).body;
    expect(bad).toMatchObject({ status: 'failed', rowCount: 0, error: 'The file is not a valid Excel workbook (.xlsx)' });
    const missing = (await api().post(`${base}/connections/${connId}/files`).set(await owner()).send({ path: `${folder()}u4-gone.csv`, fileName: 'gone.csv', size: 1 }).expect(201)).body;
    expect(missing.status).toBe('failed');
  });

  it('checks a mapping against the fields and the file before saving it as a version', async () => {
    const bad = await api().put(`${base}/connections/${connId}/mapping`).set(await owner()).send({ entityType: 'supplier', keyField: 'Account', fileId, fields: [{ target: 'name', source: 'Nom' }] }).expect(409);
    expect(bad.body.error.details.problems).toEqual(expect.arrayContaining(['Name: the column "Nom" is not in the file', 'Code is required: map a column to it']));
    const fields = [
      { target: 'code', source: 'Account' },
      { target: 'name', source: 'Supplier name' },
      { target: 'supplierType', source: 'Type', transform: 'map', values: { MFG: 'manufacturer', 'Sub-con': 'subcontractor' } },
      { target: 'country', source: 'Country', default: 'GB' },
      { target: 'email', source: 'E-mail' },
    ];
    const v1 = (await api().put(`${base}/connections/${connId}/mapping`).set(await owner()).send({ entityType: 'supplier', keyField: 'Account', fileId, fields }).expect(200)).body.data;
    expect(v1).toHaveLength(1);
    expect(v1[0]).toMatchObject({ version: 1, current: true, keyField: 'Account' });
    await api().put(`${base}/connections/${connId}/mapping`).set(await owner()).send({ entityType: 'supplier', keyField: 'Account', fields }).expect(409); // unchanged
    await api().put(`${base}/connections/${connId}/mapping`).set(await owner()).send({ entityType: 'supplier', keyField: 'Account', fields: fields.slice(0, 4) }).expect(409); // no reason
    await api().put(`${base}/connections/${connId}/mapping`).set(await inspector()).send({ entityType: 'supplier', keyField: 'Account', fields }).expect(403);
    const v2 = (await api().put(`${base}/connections/${connId}/mapping`).set(await owner()).send({ entityType: 'supplier', keyField: 'Account', fields: [...fields.slice(0, 4), { target: 'email', source: 'E-mail' }, { target: 'active', transform: 'constant', value: 'yes' }], reason: 'Everyone in the file is active' }).expect(200)).body.data;
    expect(v2.map((m: { version: number; current: boolean }) => [m.version, m.current])).toEqual([[2, true], [1, false]]);
  });

  it('previews the file with the mapping: right counts, row errors, nothing written', async () => {
    const run = (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'supplier', kind: 'preview', fileId }).expect(201)).body;
    expect(run).toMatchObject({ kind: 'preview', drain: { state: 'finished' }, file: { id: fileId, name: 'suppliers.csv' }, mappingVersion: 2 });
    expect(run.counts).toMatchObject({ total: 5, created: 2, rejected: 3 });
    const rejected = (await api().get(`${base}/runs/${run.id}/rows`).set(await owner()).query({ status: 'rejected' }).expect(200)).body.data;
    const byRow = Object.fromEntries(rejected.map((r: { sourceRow: number; errors: { message: string }[] }) => [r.sourceRow, r.errors.map((e) => e.message)]));
    expect(byRow[4]).toEqual(['Name is required']);
    expect(byRow[5]).toEqual([expect.stringMatching(/^Supplier type: "Unknown" is not one of/), 'Email: "not-an-email" is not an email address']);
    expect(byRow[6]).toEqual(['The record has no identifier']);
    const previewed = (await api().get(`${base}/runs/${run.id}/rows`).set(await owner()).query({ status: 'previewed' }).expect(200)).body.data;
    expect(previewed.map((r: { externalId: string }) => r.externalId)).toEqual(['S-1', 'S-2']);
    const map = await admin.query('select count(*)::int as n from public.integration_external_records where connection_id = $1', [connId]);
    expect(map.rows[0].n).toBe(0);
    const canonical = await admin.query(`select canonical from public.integration_inbox where run_id = $1 and external_id = 'S-1'`, [run.id]);
    expect(canonical.rows[0].canonical).toEqual({ code: 'S-1', name: 'Alpha Ltd', supplierType: 'manufacturer', country: 'GB', email: 'q@alpha.example', active: true });
  });

  it('refuses a run without a file, a failed file, and a real import with no importer yet', async () => {
    await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'supplier', kind: 'preview' }).expect(409);
    const failed = (await admin.query(`select id from public.integration_files where connection_id = $1 and status = 'failed' limit 1`, [connId])).rows[0].id;
    await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'supplier', kind: 'preview', fileId: failed }).expect(409);
    await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'supplier', kind: 'full', fileId }).expect(409);
  });

  it('shows nothing of it to another organisation', async () => {
    await api().get(`${base}/files/${fileId}`).set(await other()).expect(404);
    await api().get(`${base}/connections/${connId}/files`).set(await other()).expect(404);
    await api().get(`${base}/connections/${connId}/mappings`).set(await other()).expect(404);
    await api().post(`${base}/connections/${connId}/files`).set(await other()).send({ path: `${folder()}x.csv`, fileName: 'x.csv', size: 1 }).expect(404);
    await api().put(`${base}/connections/${connId}/mapping`).set(await other()).send({ entityType: 'supplier', keyField: 'Account', fields: [{ target: 'code', source: 'Account' }, { target: 'name', source: 'Supplier name' }] }).expect(404);
  });
});
