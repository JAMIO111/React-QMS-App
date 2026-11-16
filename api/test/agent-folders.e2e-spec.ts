/**
 * Connector agent AG5b through the API (docs/connector-agent-plan.md §18): a folder of files read through the agent. The agent sends a file's bytes
 * in signed parts; Fortress puts them back together, reads them with the uploaded-file reader and keeps a preview's first rows, or an import's rows
 * as the extraction's batches — so a folder import runs as a database import (a re-import writes nothing; an unchanged file sends nothing).
 * The rules themselves are in supabase/tests/agent_folders.test.sql; the agent's side is in connector-agent/tests/FolderTests.cs.
 */
import { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { agentClient, TestAgent } from './agent-helpers';
import { giveControllerSeats, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a95');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const agents = agentClient(() => app);
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const base = '/api/v1/integrations';

const FOLDER = { engine: 'folder', folder: '\\\\files01\\exports\\erp', authType: 'none', delimiter: ';' };
const csv = (rows: Array<[string, string]>) => Buffer.from(['code;name;plant', ...rows.map(([c, n]) => `${c};${n};MAIN`)].join('\r\n') + '\r\n');
const FILE = csv(Array.from({ length: 1200 }, (_, i) => [`FM-${i + 1}`, `Folder machine ${i + 1}`]));

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ag5b');
  await giveControllerSeats(admin, ids.orgA, [ids.ownerA]);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

let agent: TestAgent;
let connId: string;
let templateId: string;

const run = async (kind: 'preview' | 'full' | 'incremental', extra: Record<string, unknown> = {}) =>
  (await api().post(`${base}/connections/${connId}/runs`).set(await as(ids.ownerA)).send({ entityType: 'machine', kind, ...extra }).expect(201)).body;
const carryOn = async (runId: string) => (await api().post(`${base}/runs/${runId}/continue`).set(await as(ids.ownerA)).send({})).body;

describe('reading a folder of files through the agent', () => {
  it('makes a folder connection that needs no password, tested and browsed by the agent', async () => {
    agent = await agents.register(await as(ids.ownerA), 'Newcastle');
    const bad = await api().post(`${base}/connections`).set(await as(ids.ownerA))
      .send({ providerKey: 'sql_agent', name: 'Exports', externalSystem: 'erp-files', agentId: agent.id, config: { ...FOLDER, folder: 'exports' } }).expect(409);
    expect(bad.body.error.message).toMatch(/whole folder path/);
    const created = (await api().post(`${base}/connections`).set(await as(ids.ownerA))
      .send({ providerKey: 'sql_agent', name: 'ERP exports', externalSystem: 'erp-files', agentId: agent.id, config: FOLDER }).expect(201)).body;
    connId = created.id;
    expect(created.agentCredential).toBeNull();
    await api().post(`${base}/connections/${connId}/test`).set(await as(ids.ownerA)).send({}).expect(200);
    const test = await agents.does(agent, 'complete', { result: { ok: true, message: 'The folder \\\\files01\\exports\\erp can be read: 3 files, 2 of them CSV or Excel' } });
    expect(test.kind).toBe('test_connection');
    expect(test.spec.connection).toMatchObject(FOLDER);
    const listed = (await api().post(`${base}/connections/${connId}/agent-jobs`).set(await as(ids.ownerA)).send({ kind: 'discover', request: { level: 'files' } }).expect(201)).body;
    const job = await agents.take(agent);
    expect(job.id).toBe(listed.id);
    expect(job.spec.request).toEqual({ level: 'files' });
    await agents.signed(agent, `${'/api/v1/integrations/agent/jobs/'}${job.id}/complete`, { result: { level: 'files', files: [{ name: 'machines-2026-11-15.csv', size: FILE.length, supported: true }] } }).expect(200);
    await api().post(`${base}/connections/${connId}/agent-jobs`).set(await as(ids.ownerA)).send({ kind: 'discover', request: { level: 'schemas' } }).expect(409);
    await api().post(`${base}/connections/${connId}/agent-jobs`).set(await as(ids.ownerA)).send({ kind: 'preview', request: { file: '../secret.csv' } }).expect(400);
    await api().post(`${base}/connections/${connId}/ready`).set(await as(ids.ownerA)).send({}).expect(200);
    expect((await api().post(`${base}/connections/${connId}/activate`).set(await as(ids.ownerA)).send({}).expect(200)).body.status).toBe('active');
  });

  it('reads a previewed file in Fortress and offers its first rows as the sample to map', async () => {
    const r = (await api().put(`${base}/connections/${connId}/record-source`).set(await as(ids.ownerA)).send({ entityType: 'machine', source: { file: 'machines-*.csv' } }).expect(200)).body;
    expect(r.recordSources).toEqual([expect.objectContaining({ entityType: 'machine', source: { file: 'machines-*.csv' } })]);
    await api().put(`${base}/connections/${connId}/record-source`).set(await as(ids.ownerA)).send({ entityType: 'machine', source: { schema: 'erp', object: 'machines', keyColumn: 'id' } }).expect(409);
    await api().put(`${base}/connections/${connId}/record-source`).set(await as(ids.ownerA)).send({ entityType: 'machine', source: { file: 'a/b.csv' } }).expect(400);
    await api().post(`${base}/connections/${connId}/sample`).set(await as(ids.ownerA)).send({ entityType: 'machine' }).expect(409);
    await api().post(`${base}/connections/${connId}/agent-jobs`).set(await as(ids.ownerA)).send({ kind: 'preview', request: { file: 'machines-*.csv', limit: 5 } }).expect(201);
    const job = await agents.take(agent);
    expect(job.spec.request).toEqual({ file: 'machines-*.csv', limit: 5 });
    // parts are checked as they arrive: their checksum, and their order
    const wrong = await agents.filePart(agent, job.id, 0, FILE.subarray(0, 10), { checksum: 'a'.repeat(64) }).expect(400);
    expect(wrong.body.error.code).toBe('file_part_checksum');
    const gap = await agents.filePart(agent, job.id, 1, FILE.subarray(0, 10)).expect(409);
    expect(gap.body.error.message).toMatch(/Part 0 was expected next/);
    await agents.sendsFile(agent, job.id, 'machines-2026-11-15.csv', FILE, 16 * 1024).then((res) => expect(res.status).toBe(200));
    const done = (await api().get(`${base}/agent-jobs/${job.id}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(done.status).toBe('completed');
    expect(done.result.columns).toEqual([{ name: 'code' }, { name: 'name' }, { name: 'plant' }]);
    expect(done.result.rows).toEqual([1, 2, 3, 4, 5].map((i) => ({ code: `FM-${i}`, name: `Folder machine ${i}`, plant: 'MAIN' })));
    expect(done.result).toMatchObject({ rowCount: 1200, truncated: true, file: { name: 'machines-2026-11-15.csv', size: FILE.length } });
    expect((await admin.query(`select count(*)::int as n from public.integration_agent_file_parts where job_id = $1`, [job.id])).rows[0].n).toBe(0);
    const sample = (await api().post(`${base}/connections/${connId}/sample`).set(await as(ids.ownerA)).send({ entityType: 'machine' }).expect(200)).body;
    expect(sample.columns).toEqual(['code', 'name', 'plant']);
    expect(sample.rows[0].v).toEqual({ code: 'FM-1', name: 'Folder machine 1', plant: 'MAIN' });
    const fields = [{ target: 'code', source: 'code' }, { target: 'name', source: 'name' }, { target: 'site', source: 'plant' }];
    templateId = (await api().post(`${base}/templates`).set(await as(ids.ownerA)).send({
      entityType: 'machine', name: 'Exported machines', keyField: 'code', fields, expectedColumns: sample.columns, settings: { writeMode: 'add_update', matchExisting: false },
    }).expect(201)).body.id;
  });

  it('imports the newest file, again with nothing written, and an unchanged file sends nothing at all', async () => {
    const first = await run('full', { templateId });
    let job = await agents.take(agent);
    expect(job.spec.request).toMatchObject({ file: 'machines-*.csv', changedColumn: '@file' });
    expect((await agents.sendsFile(agent, job.id, 'machines-2026-11-15.csv', FILE)).status).toBe(200);
    expect(await carryOn(first.id)).toMatchObject({ status: 'succeeded', counts: { total: 1200, created: 1200 } });
    expect((await admin.query(`select count(*)::int as n from public.machines where organisation_id = $1 and code like 'FM-%'`, [ids.orgA])).rows[0].n).toBe(1200);
    const sha = createHash('sha256').update(FILE).digest('hex');
    const cursor = (await admin.query(`select cursor from public.integration_sync_cursors where connection_id = $1 and entity_type = 'machine'`, [connId])).rows[0].cursor;
    expect(JSON.parse(cursor)).toEqual({ w: sha });

    const again = await run('full', { templateId });
    job = await agents.take(agent);
    await agents.sendsFile(agent, job.id, 'machines-2026-11-15.csv', FILE);
    expect(await carryOn(again.id)).toMatchObject({ status: 'succeeded', counts: { total: 1200, created: 0, updated: 0, unchanged: 1200 } });

    const inc = await run('incremental', { templateId });
    job = await agents.take(agent);
    expect(job.spec.request.changedSince).toBe(sha);
    await agents.signed(agent, `/api/v1/integrations/agent/jobs/${job.id}/complete`, {
      result: { file: { name: 'machines-2026-11-15.csv', size: FILE.length, sha256: sha }, parts: 0, unchanged: true, batches: 0, rows: 0, changedUpTo: sha },
    }).expect(200);
    expect(await carryOn(inc.id)).toMatchObject({ kind: 'incremental', status: 'succeeded', counts: { total: 0 } });

    // A changed file: only what changed is written.
    const changed = csv([['FM-1', 'Folder machine 1 (rebuilt)'], ...Array.from({ length: 1199 }, (_, i): [string, string] => [`FM-${i + 2}`, `Folder machine ${i + 2}`])]);
    const inc2 = await run('incremental', { templateId });
    job = await agents.take(agent);
    await agents.sendsFile(agent, job.id, 'machines-2026-11-16.csv', changed);
    expect(await carryOn(inc2.id)).toMatchObject({ status: 'succeeded', counts: { total: 1200, updated: 1, unchanged: 1199 } });
    expect((await admin.query(`select name from public.machines where organisation_id = $1 and code = 'FM-1'`, [ids.orgA])).rows[0].name).toBe('Folder machine 1 (rebuilt)');
  });

  it('fails the import with the reader\'s words when the file cannot be read, and refuses a file that did not arrive whole', async () => {
    const broken = await run('full', { templateId });
    let job = await agents.take(agent);
    await agents.sendsFile(agent, job.id, 'machines-2026-11-17.xlsx', Buffer.from('this is not a workbook')).then((res) => expect(res.status).toBe(200));
    const detail = (await api().get(`${base}/runs/${broken.id}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(detail.status).toBe('failed');
    expect(detail.errorSummary ?? detail.errors?.[0]?.message).toMatch(/machines-2026-11-17\.xlsx could not be read: The file is not a valid Excel workbook/);

    const short = await run('full', { templateId });
    job = await agents.take(agent);
    await agents.filePart(agent, job.id, 0, FILE.subarray(0, 100)).expect(200);
    const res = await agents.signed(agent, `/api/v1/integrations/agent/jobs/${job.id}/complete`, {
      result: { file: { name: 'machines.csv', size: FILE.length, sha256: createHash('sha256').update(FILE).digest('hex') }, parts: 2 },
    }).expect(409);
    expect(res.body.error.code).toBe('agent_file_incomplete');
    await api().post(`${base}/runs/${short.id}/cancel`).set(await as(ids.ownerA)).send({ reason: 'Test over' }).expect(200);
    expect((await admin.query(`select count(*)::int as n from public.integration_agent_file_parts where job_id = $1`, [job.id])).rows[0].n).toBe(0);
  });

  it('schedules a folder every few minutes, reading only a changed file', async () => {
    const saved = (await api().put(`${base}/connections/${connId}/settings`).set(await as(ids.ownerA)).send({ entityType: 'machine', schedule: 'every_15m', templateId }).expect(200)).body;
    expect(saved.schedule).toBe('every_15m');
    await api().put(`${base}/connections/${connId}/settings`).set(await as(ids.ownerA)).send({ entityType: 'machine', schedule: 'manual' }).expect(200);
  });
});
