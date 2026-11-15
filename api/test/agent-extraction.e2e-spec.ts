/**
 * Connector agent AG3 through the API (docs/connector-agent-plan.md): a table chosen for a kind of record, a sample asked of the agent and mapped
 * with a template, a preview and an import that wait for the agent's batches and then go through the existing pipeline (a re-import writes
 * nothing), batches checked (checksum, gzip cap, order, signature), a failed extraction failing its run, cancellation, rights and isolation.
 * The rules themselves are in supabase/tests/agent_extraction.test.sql; the agent's side is in connector-agent/tests.
 */
import { INestApplication } from '@nestjs/common';
import { gzipSync } from 'node:zlib';
import { Pool } from 'pg';
import request from 'supertest';
import { agentClient, seal, TestAgent } from './agent-helpers';
import { giveControllerSeats, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a94');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const agents = agentClient(() => app);
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const base = '/api/v1/integrations';

const CONFIG = { engine: 'postgres', server: 'erp-db.factory.local', port: 5432, database: 'erp', authType: 'password', encrypt: true };
const SOURCE = { schema: 'erp', object: 'machines', keyColumn: 'id', columns: ['id', 'code', 'name', 'plant', 'commissioned'], filters: [{ column: 'active', op: 'eq', value: true }] };
const ROWS = [1, 2, 3, 4, 5].map((i) => ({ id: i, code: `DB-M${i}`, name: `Machine ${i}`, plant: 'MAIN', commissioned: `2026-0${i}-01` }));

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ag3');
  await giveControllerSeats(admin, ids.orgA, [ids.ownerA]);
  await giveControllerSeats(admin, ids.orgB, [ids.ownerB]);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

let agent: TestAgent;
let agentB: TestAgent;
let connId: string;
let templateId: string;

/** The agent reads the extraction it is given and sends the rows in batches of two, then reports it complete. */
async function agentExtracts(rows = ROWS, size = 2) {
  const job = await agents.take(agent);
  expect(job.kind).toBe('extract');
  let seq = 0;
  for (let i = 0; i < rows.length; i += size) {
    const part = rows.slice(i, i + size);
    const res = await agents.batch(agent, job.id, { seq, lastKey: String(part.at(-1)!.id), rows: part }).expect(200);
    expect(res.body).toMatchObject({ stored: true, batches: seq + 1 });
    seq++;
  }
  await agents.signed(agent, `/api/v1/integrations/agent/jobs/${job.id}/complete`, { result: { batches: seq, rows: rows.length, columns: [{ name: 'id' }] } }).expect(200);
  return job;
}

const run = async (kind: 'preview' | 'full' | 'incremental', extra: Record<string, unknown> = {}) =>
  (await api().post(`${base}/connections/${connId}/runs`).set(await as(ids.ownerA)).send({ entityType: 'machine', kind, ...extra }).expect(201)).body;
const carryOn = async (runId: string) => (await api().post(`${base}/runs/${runId}/continue`).set(await as(ids.ownerA)).send({}).expect(200)).body;

describe('reading a database through the agent into an import', () => {
  it('sets up a tested, active database connection', async () => {
    agent = await agents.register(await as(ids.ownerA), 'Newcastle');
    agentB = await agents.register(await as(ids.ownerB, ids.orgB), 'Beta');
    connId = (await api().post(`${base}/connections`).set(await as(ids.ownerA)).send({ providerKey: 'sql_agent', name: 'ERP database', externalSystem: 'erp', agentId: agent.id, config: CONFIG }).expect(201)).body.id;
    const detail = (await api().get(`${base}/connections/${connId}`).set(await as(ids.ownerA)).expect(200)).body;
    await api().put(`${base}/connections/${connId}/agent-credential`).set(await as(ids.ownerA))
      .send({ keyId: detail.agent.keyId, sealed: seal(detail.agent.sealingKey, connId, JSON.stringify({ username: 'reader', password: 'hunter2' })) }).expect(200);
    await agents.does(agent, 'complete', { result: { stored: true } });
    await api().post(`${base}/connections/${connId}/test`).set(await as(ids.ownerA)).send({}).expect(200);
    await agents.does(agent, 'complete', { result: { ok: true, message: 'Signed in to PostgreSQL 16.4 as reader' } });
    await api().post(`${base}/connections/${connId}/ready`).set(await as(ids.ownerA)).send({}).expect(200);
    const c = (await api().post(`${base}/connections/${connId}/activate`).set(await as(ids.ownerA)).send({}).expect(200)).body;
    expect(c.status).toBe('active');
    expect(c.importable).toContain('machine');
  });

  it('says which table holds machines, as a structured request', async () => {
    const refused = await api().post(`${base}/connections/${connId}/runs`).set(await as(ids.ownerA)).send({ entityType: 'machine', kind: 'preview' }).expect(409);
    expect(refused.body.error.message).toMatch(/which table holds machine records/);
    await api().put(`${base}/connections/${connId}/record-source`).set(await as(ids.inspectorA)).send({ entityType: 'machine', source: SOURCE }).expect(403);
    await api().put(`${base}/connections/${connId}/record-source`).set(await as(ids.ownerA)).send({ entityType: 'machine', source: { ...SOURCE, sql: 'select 1' } }).expect(400);
    const noKey = await api().put(`${base}/connections/${connId}/record-source`).set(await as(ids.ownerA)).send({ entityType: 'machine', source: { ...SOURCE, columns: ['code'] } }).expect(409);
    expect(noKey.body.error.message).toMatch(/identifies each row too/);
    const c = (await api().put(`${base}/connections/${connId}/record-source`).set(await as(ids.ownerA)).send({ entityType: 'machine', source: SOURCE }).expect(200)).body;
    expect(c.recordSources).toEqual([{ entityType: 'machine', source: SOURCE, updatedAt: expect.any(String) }]);
    expect(c.status).toBe('active');
    await api().put(`${base}/connections/${connId}/record-source`).set(await as(ids.ownerB, ids.orgB)).send({ entityType: 'machine', source: SOURCE }).expect(404);
  });

  it('maps fields from a sample the agent sends', async () => {
    const none = await api().post(`${base}/connections/${connId}/sample`).set(await as(ids.ownerA)).send({ entityType: 'machine' }).expect(409);
    expect(none.body.error.code).toBe('agent_sample_needed');
    await api().post(`${base}/connections/${connId}/agent-jobs`).set(await as(ids.ownerA)).send({ kind: 'preview', request: { schema: 'erp', object: 'machines', limit: 20 } }).expect(201);
    await agents.does(agent, 'complete', {
      result: { columns: [...SOURCE.columns, 'secret_cost'].map((name) => ({ name })), rows: ROWS.slice(0, 3).map((r) => ({ ...r, secret_cost: 99.5 })) },
    });
    const sample = (await api().post(`${base}/connections/${connId}/sample`).set(await as(ids.ownerA)).send({ entityType: 'machine' }).expect(200)).body;
    expect(sample.columns).toEqual(SOURCE.columns);
    expect(sample.rows[0]).toEqual({ r: 1, v: { id: '1', code: 'DB-M1', name: 'Machine 1', plant: 'MAIN', commissioned: '2026-01-01' } });
    const fields = [{ target: 'code', source: 'code' }, { target: 'name', source: 'name' }, { target: 'site', source: 'plant' }];
    const preview = (await api().post(`${base}/templates/preview`).set(await as(ids.ownerA)).send({ entityType: 'machine', connectionId: connId, keyField: 'id', fields }).expect(200)).body;
    expect(preview.rows[0].fields.find((f: { target: string }) => f.target === 'code')).toMatchObject({ value: 'DB-M1', error: null });
    templateId = (await api().post(`${base}/templates`).set(await as(ids.ownerA)).send({
      entityType: 'machine', name: 'ERP machines', keyField: 'id', fields, expectedColumns: sample.columns, settings: { writeMode: 'add_update', matchExisting: false },
    }).expect(201)).body.id;
  });

  it('a preview waits for the agent, then shows every row and writes nothing', async () => {
    const r = await run('preview', { templateId });
    expect(r.status).toBe('queued');
    expect(r.drain).toMatchObject({ state: 'waiting', reason: expect.stringMatching(/Waiting for the connector agent/) });
    const job = await agentExtracts();
    expect(job.spec.request).toMatchObject({ ...SOURCE, maxRows: 1000, batchRows: 1000 });
    const done = await carryOn(r.id);
    expect(done).toMatchObject({ status: 'succeeded', counts: { total: 5, created: 5 } });
    expect((await admin.query(`select count(*)::int as n from public.machines where organisation_id = $1 and code like 'DB-M%'`, [ids.orgA])).rows[0].n).toBe(0);
  });

  it('an import writes once, and the same import again writes nothing', async () => {
    const first = await run('full', { templateId });
    const job = await agentExtracts();
    expect(job.spec.request.maxRows).toBeUndefined();
    expect(await carryOn(first.id)).toMatchObject({ status: 'succeeded', counts: { total: 5, created: 5 } });
    expect((await admin.query(`select count(*)::int as n from public.machines where organisation_id = $1 and code like 'DB-M%'`, [ids.orgA])).rows[0].n).toBe(5);
    const again = await run('full', { templateId });
    await agentExtracts();
    expect(await carryOn(again.id)).toMatchObject({ status: 'succeeded', counts: { total: 5, created: 0, updated: 0, unchanged: 5 } });
  });

  it('checks every batch: checksum, size once inflated, order, its own job', async () => {
    const r = await run('full', { templateId });
    const job = await agents.take(agent);
    const wrongSum = await agents.batch(agent, job.id, { seq: 0, lastKey: '1', rows: [ROWS[0]] }, { checksum: 'a'.repeat(64) }).expect(400);
    expect(wrongSum.body.error.code).toBe('batch_checksum');
    const bomb = Buffer.alloc(9 * 1024 * 1024, 0x20);
    const big = await agents.batch(agent, job.id, { seq: 0, lastKey: null, rows: [] }, { gzip: gzipSync(bomb), checksum: 'b'.repeat(64) }).expect(413);
    expect(big.body.error.code).toBe('payload_too_large');
    const gap = await agents.batch(agent, job.id, { seq: 1, lastKey: '2', rows: [ROWS[1]] }).expect(409);
    expect(gap.body.error.message).toMatch(/Batch 0 was expected next/);
    await agents.batch(agentB, job.id, { seq: 0, lastKey: '1', rows: [ROWS[0]] }).expect(404);
    await agents.batch(agent, job.id, { seq: 0, lastKey: '1', rows: [ROWS[0]] }).expect(200);
    const again = await agents.batch(agent, job.id, { seq: 0, lastKey: '1', rows: [ROWS[0]] }).expect(200);
    expect(again.body).toMatchObject({ stored: false, duplicate: true });
    const short = await agents.signed(agent, `/api/v1/integrations/agent/jobs/${job.id}/complete`, { result: { batches: 2, rows: 2 } }).expect(409);
    expect(short.body.error.message).toMatch(/Fortress holds 1/);
    // A run cancelled while the agent reads cancels the job; the agent learns it from its next batch.
    await api().post(`${base}/runs/${r.id}/cancel`).set(await as(ids.ownerA)).send({ reason: 'Wrong table' }).expect(200);
    const after = await agents.batch(agent, job.id, { seq: 1, lastKey: '2', rows: [ROWS[1]] }).expect(200);
    expect(after.body).toMatchObject({ cancelled: true, stored: false });
  });

  it('an extraction the agent cannot do fails its run with the agent\'s reason', async () => {
    const r = await run('full', { templateId });
    await agents.does(agent, 'fail', { kind: 'not_found', message: 'There is no table or view erp.machines that this sign-in can read' });
    const detail = (await api().get(`${base}/runs/${r.id}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(detail.status).toBe('failed');
    expect(detail.errorSummary ?? detail.errors?.[0]?.message).toMatch(/could not read the records: There is no table/);
  });

  it('reads only what changed once the source names its changed column (AG4)', async () => {
    const changed = { ...SOURCE, columns: [...SOURCE.columns, 'changed'], changedColumn: 'changed' };
    await api().put(`${base}/connections/${connId}/record-source`).set(await as(ids.ownerA)).send({ entityType: 'machine', source: changed }).expect(200);
    // A full read sets the mark: the agent reports the highest changed value it read.
    const full = await run('full', { templateId });
    const job = await agents.take(agent);
    expect(job.spec.request).toMatchObject({ changedColumn: 'changed' });
    expect(job.spec.request.changedSince).toBeUndefined();
    const rows = ROWS.map((r, i) => ({ ...r, changed: `2026-11-0${i + 1}T08:00:00Z` }));
    await agents.batch(agent, job.id, { seq: 0, lastKey: '5', rows, changedUpTo: "2026-11-05T08:00:00Z" }).expect(200);
    await agents.signed(agent, `/api/v1/integrations/agent/jobs/${job.id}/complete`, { result: { batches: 1, rows: 5, changedUpTo: '2026-11-05T08:00:00Z' } }).expect(200);
    expect(await carryOn(full.id)).toMatchObject({ status: 'succeeded' });
    const cursor = (await admin.query(`select cursor from public.integration_sync_cursors where connection_id = $1 and entity_type = 'machine'`, [connId])).rows[0].cursor;
    expect(JSON.parse(cursor)).toEqual({ w: '2026-11-05T08:00:00Z' });
    // An incremental read starts at it; one changed row comes back and is updated, the mark moves on.
    const inc = await run('incremental', { templateId });
    const job2 = await agents.take(agent);
    expect(job2.spec.request.changedSince).toBe('2026-11-05T08:00:00Z');
    await agents.batch(agent, job2.id, { seq: 0, lastKey: '2', rows: [{ ...rows[1], name: 'Machine 2 (rebuilt)', changed: '2026-11-09T08:00:00Z' }], changedUpTo: "2026-11-09T08:00:00Z" }).expect(200);
    await agents.signed(agent, `/api/v1/integrations/agent/jobs/${job2.id}/complete`, { result: { batches: 1, rows: 1, changedUpTo: '2026-11-09T08:00:00Z' } }).expect(200);
    expect(await carryOn(inc.id)).toMatchObject({ kind: 'incremental', status: 'succeeded', counts: { total: 1, updated: 1 } });
    expect((await admin.query(`select name from public.machines where organisation_id = $1 and code = 'DB-M2'`, [ids.orgA])).rows[0].name).toBe('Machine 2 (rebuilt)');
    const after = (await admin.query(`select cursor from public.integration_sync_cursors where connection_id = $1 and entity_type = 'machine'`, [connId])).rows[0].cursor;
    expect(JSON.parse(after)).toEqual({ w: '2026-11-09T08:00:00Z' });
  }, 90000);

  it('lists a row that is no longer in the table after a full read (AG4)', async () => {
    await api().put(`${base}/connections/${connId}/settings`).set(await as(ids.ownerA)).send({ entityType: 'machine', onMissing: 'list' }).expect(200);
    const full = await run('full', { templateId });
    const job = await agents.take(agent);
    const rows = ROWS.filter((r) => r.id !== 4).map((r) => ({ ...r, changed: '2026-11-09T08:00:00Z' }));
    await agents.batch(agent, job.id, { seq: 0, lastKey: '5', rows, changedUpTo: '2026-11-09T08:00:00Z' }).expect(200);
    await agents.signed(agent, `/api/v1/integrations/agent/jobs/${job.id}/complete`, { result: { batches: 1, rows: rows.length, changedUpTo: '2026-11-09T08:00:00Z' } }).expect(200);
    expect(await carryOn(full.id)).toMatchObject({ status: 'succeeded' });
    const missing = (await api().get(`${base}/missing-records?connectionId=${connId}&entityType=machine`).set(await as(ids.ownerA)).expect(200)).body;
    expect(missing.data).toEqual([expect.objectContaining({ externalId: '4', status: 'listed' })]);
    await api().put(`${base}/connections/${connId}/settings`).set(await as(ids.ownerA)).send({ entityType: 'machine', onMissing: 'nothing' }).expect(200);
  }, 60000);

  it('runs every few minutes on a schedule, and health names the agent (AG4)', async () => {
    const bad = await api().put(`${base}/connections/${connId}/settings`).set(await as(ids.ownerA)).send({ entityType: 'part', schedule: 'every_15m', templateId }).expect(409);
    expect(bad.body.error.message).toMatch(/template is for another kind|table these records are read from/);
    const saved = (await api().put(`${base}/connections/${connId}/settings`).set(await as(ids.ownerA)).send({ entityType: 'machine', schedule: 'every_15m', templateId }).expect(200)).body;
    expect(saved.schedule).toBe('every_15m');
    const health = (await api().get(`${base}/health`).set(await as(ids.ownerA)).expect(200)).body;
    const row = health.data.find((r: { connectionId: string; entityType: string }) => r.connectionId === connId && r.entityType === 'machine');
    expect(row).toMatchObject({ schedule: 'every_15m', agent: { name: 'Newcastle', online: true } });
    await api().put(`${base}/connections/${connId}/settings`).set(await as(ids.ownerA)).send({ entityType: 'machine', schedule: 'manual' }).expect(200);
  });

  it('batches are never readable by people, and another organisation sees nothing', async () => {
    const rows = await admin.query(`select count(*)::int as n from public.integration_agent_batches b join public.integration_agent_jobs j on j.id = b.job_id where j.connection_id = $1`, [connId]);
    expect(rows.rows[0].n).toBeGreaterThan(0);
    await api().get(`${base}/connections/${connId}`).set(await as(ids.ownerB, ids.orgB)).expect(404);
    await api().post(`${base}/connections/${connId}/sample`).set(await as(ids.ownerB, ids.orgB)).send({ entityType: 'machine' }).expect(404);
  });
});
