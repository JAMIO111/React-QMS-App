/**
 * Integrations IN4 through the API: a file connection in use at once, import settings (add only / add and update; NCs fixed), a real import of machines
 * from a file (created through the table rules, stamped as the person who imported), the same file again writing nothing, "add new only" skipping changed
 * records, and NCs whose machine column holds the old system's id resolved through the map of the earlier import (an unknown one rejected in the preview too).
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

const ids = makeIds('4f');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const owner = () => as(ids.ownerA);
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
  await seed(admin, ids, '-im');
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

describe('real imports from a file', () => {
  let connId: string;
  let site: string;
  const upload = async (name: string, text: string): Promise<string> => {
    const path = `${ids.orgA}/integration/${connId}/${Math.random().toString(36).slice(2)}-${name}`;
    files.set(path, strToU8(text));
    return (await api().post(`${base}/connections/${connId}/files`).set(await owner()).send({ path, fileName: name, size: text.length }).expect(201)).body.id;
  };
  const run = async (entityType: string, kind: 'preview' | 'full', fileId: string) =>
    (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType, kind, fileId }).expect(201)).body;

  it('a file connection is in use at once, and says what the caller may write', async () => {
    const c = (await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'csv', name: 'Legacy QMS', externalSystem: 'legacy' }).expect(201)).body;
    connId = c.id;
    expect(c).toMatchObject({ status: 'active', fileConnection: true });
    expect(c.importable).toEqual(expect.arrayContaining(['machine', 'nonconformance', 'gauge', 'employee']));
    expect(c.writable).toEqual(expect.arrayContaining(['machine', 'nonconformance']));
    site = (await admin.query(`select code from public.sites where organisation_id = $1 order by created_at limit 1`, [ids.orgA])).rows[0].code;
  });

  it('keeps import settings per kind of record, with the safest defaults and fixed rules for NCs', async () => {
    const all = (await api().get(`${base}/connections/${connId}/settings`).set(await owner()).expect(200)).body.data;
    expect(all.find((s: { entityType: string }) => s.entityType === 'machine')).toMatchObject({ writeMode: 'add_only', matchExisting: false, saved: false, fixed: false, canDeactivate: true });
    expect(all.find((s: { entityType: string }) => s.entityType === 'nonconformance')).toMatchObject({ writeMode: 'add_only', fixed: true, canDeactivate: false });
    const bad = await api().put(`${base}/connections/${connId}/settings`).set(await owner()).send({ entityType: 'nonconformance', writeMode: 'add_update' }).expect(409);
    expect(bad.body.error.message).toMatch(/only ever added/);
    await api().put(`${base}/connections/${connId}/settings`).set(await owner()).send({ entityType: 'machine', schedule: 'daily' }).expect(409);
    await api().put(`${base}/connections/${connId}/settings`).set(await owner()).send({ entityType: 'machine', writeMode: 'replace' }).expect(400);
    const saved = (await api().put(`${base}/connections/${connId}/settings`).set(await owner()).send({ entityType: 'machine', writeMode: 'add_update' }).expect(200)).body;
    expect(saved).toMatchObject({ writeMode: 'add_update', saved: true });
  });

  it('imports machines, then the same file again writes nothing', async () => {
    const fileId = await upload('machines.csv', ['Id,Code,Name,Site', `17,CNC-01,Lathe,${site}`, `18,MILL-02,Mill,${site}`].join('\n'));
    await api().put(`${base}/connections/${connId}/mapping`).set(await owner()).send({
      entityType: 'machine', keyField: 'Id', fileId,
      fields: [{ target: 'code', source: 'Code' }, { target: 'name', source: 'Name' }, { target: 'site', source: 'Site', match: 'code' }],
    }).expect(200);
    const first = await run('machine', 'full', fileId);
    expect(first).toMatchObject({ status: 'succeeded', counts: { total: 2, created: 2 }, settings: { writeMode: 'add_update' }, drain: { state: 'finished' } });
    const rows = (await admin.query(`select code, created_by, site_id is not null as has_site from public.machines where organisation_id = $1 and code in ('CNC-01', 'MILL-02') order by code`, [ids.orgA])).rows;
    expect(rows).toEqual([{ code: 'CNC-01', created_by: ids.ownerA, has_site: true }, { code: 'MILL-02', created_by: ids.ownerA, has_site: true }]);
    const again = await run('machine', 'full', fileId);
    expect(again).toMatchObject({ status: 'succeeded', counts: { unchanged: 2, created: 0, updated: 0 } });
    expect((await admin.query(`select count(*)::int as n from public.machines where organisation_id = $1 and code in ('CNC-01', 'MILL-02')`, [ids.orgA])).rows[0].n).toBe(2);
  });

  it('"add new only" leaves changed records alone and says why', async () => {
    await api().put(`${base}/connections/${connId}/settings`).set(await owner()).send({ entityType: 'machine', writeMode: 'add_only' }).expect(200);
    const fileId = await upload('machines-v2.csv', ['Id,Code,Name,Site', `17,CNC-01,Lathe (renamed),${site}`, `19,DRILL-03,Drill,${site}`].join('\n'));
    const res = await run('machine', 'full', fileId);
    expect(res).toMatchObject({ counts: { skipped: 1, created: 1 }, settings: { writeMode: 'add_only' } });
    expect((await admin.query(`select name from public.machines where organisation_id = $1 and code = 'CNC-01'`, [ids.orgA])).rows[0].name).toBe('Lathe');
    const skipped = (await api().get(`${base}/runs/${res.id}/rows?status=skipped`).set(await owner()).expect(200)).body.data;
    expect(skipped[0].errors[0].message).toBe('Already imported: this import only adds new records');
  });

  it('imports historical NCs whose machine column holds the old id, rejecting one it cannot link', async () => {
    const fileId = await upload('ncs.csv', ['NC,Title,Source,Machine', 'NC-0001,Burr on edge,Internal,17', 'NC-0002,Wrong size,Internal,99'].join('\n'));
    const bad = await api().put(`${base}/connections/${connId}/mapping`).set(await owner()).send({
      entityType: 'nonconformance', keyField: 'NC', fileId,
      fields: [{ target: 'title', source: 'Title' }, { target: 'source', source: 'Source' }, { target: 'causalMachine', source: 'Machine', match: 'nope' }],
    }).expect(400);
    expect(bad.body.error).toBeDefined();
    await api().put(`${base}/connections/${connId}/mapping`).set(await owner()).send({
      entityType: 'nonconformance', keyField: 'NC', fileId,
      fields: [{ target: 'title', source: 'Title' }, { target: 'source', source: 'Source' }, { target: 'causalMachine', source: 'Machine', match: 'source' }],
    }).expect(200);
    const preview = await run('nonconformance', 'preview', fileId);
    expect(preview).toMatchObject({ counts: { created: 1, rejected: 1 } });
    const rejected = (await api().get(`${base}/runs/${preview.id}/rows?status=rejected`).set(await owner()).expect(200)).body.data;
    expect(rejected[0].errors[0]).toMatchObject({ field: 'causalMachine', message: expect.stringMatching(/no machine "99" has been imported through this connection yet/) });
    expect((await admin.query(`select count(*)::int as n from public.nonconformances where organisation_id = $1 and title = 'Burr on edge'`, [ids.orgA])).rows[0].n).toBe(0);

    const real = await run('nonconformance', 'full', fileId);
    const failed = (await admin.query(`select errors from public.integration_inbox where run_id = $1 and status = 'failed'`, [real.id])).rows;
    expect(failed).toEqual([]);
    expect(real).toMatchObject({ status: 'partial', counts: { created: 1, rejected: 1 } });
    const nc = (await admin.query(
      `select n.stage, n.reference is not null as has_ref, m.code as machine from public.nonconformances n join public.machines m on m.id = n.causal_process_id where n.organisation_id = $1 and n.title = 'Burr on edge'`,
      [ids.orgA],
    )).rows;
    expect(nc).toEqual([{ stage: 'draft', has_ref: true, machine: 'CNC-01' }]);
    const again = await run('nonconformance', 'full', fileId);
    expect(again.counts).toMatchObject({ created: 0, unchanged: 1, rejected: 1 });
  });

  it('shows nothing of it to another organisation', async () => {
    await api().get(`${base}/connections/${connId}/settings`).set(await other()).expect(404);
    await api().put(`${base}/connections/${connId}/settings`).set(await other()).send({ entityType: 'machine', writeMode: 'add_update' }).expect(404);
  });
});
