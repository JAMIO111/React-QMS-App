/**
 * Connector agent AG5c through the API (docs/connector-agent-plan.md §18): an internal REST API read through the agent. Fortress never calls the
 * API: the token is sealed in the browser for the agent, the agent tries an address (preview) and reads an endpoint page by page (extract),
 * flattening each record as the cloud REST connector does, and sends the rows as the extraction's batches — so an API import runs as a database
 * import (a re-import writes nothing; an incremental read sends the mark of the last one). The rules are in supabase/tests/agent_rest.test.sql;
 * the agent's side is in connector-agent/tests/RestTests.cs.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { agentClient, seal, TestAgent } from './agent-helpers';
import { giveControllerSeats, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a96');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const agents = agentClient(() => app);
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const base = '/api/v1/integrations';

const CONFIG = { engine: 'rest', baseUrl: 'http://erp.factory.local:8080/api', authType: 'bearer', testPath: '/health' };
const SOURCE = { path: '/v1/machines', recordsPath: 'data', paging: { style: 'page', pageSize: 500 }, keyColumn: 'code', changedColumn: 'updatedAt', changedParam: 'since' };
const ROWS = Array.from({ length: 700 }, (_, i) => ({ code: `RM-${i + 1}`, name: `Rest machine ${i + 1}`, 'site.code': 'MAIN', updatedAt: `2026-11-16T0${Math.floor(i / 100)}:00:00Z` }));

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ag5c');
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
/** The agent reads the endpoint: batches of up to 500 flat rows (as it would after flattening), then completes with the highest changed value. */
const sends = async (jobId: string, rows: typeof ROWS) => {
  let seq = 0;
  for (let at = 0; at < rows.length; at += 500, seq++) {
    const part = rows.slice(at, at + 500);
    await agents.batch(agent, jobId, { seq, lastKey: JSON.stringify({ n: seq + 1, page: seq + 2, skip: 0 }), rows: part, changedUpTo: part[part.length - 1].updatedAt }).expect(200);
  }
  const changedUpTo = rows.length ? rows[rows.length - 1].updatedAt : undefined;
  await agents.signed(agent, `/api/v1/integrations/agent/jobs/${jobId}/complete`, { result: { batches: seq, rows: rows.length, changedUpTo } }).expect(200);
};

describe('reading an internal API through the agent', () => {
  it('makes an API connection whose token is sealed for the agent, and tests it through the agent', async () => {
    agent = await agents.register(await as(ids.ownerA), 'Newcastle');
    const bad = await api().post(`${base}/connections`).set(await as(ids.ownerA))
      .send({ providerKey: 'sql_agent', name: 'ERP API', externalSystem: 'erp-api', agentId: agent.id, config: { ...CONFIG, baseUrl: 'http://169.254.169.254/latest' } }).expect(409);
    expect(bad.body.error.message).toMatch(/link-local/);
    const created = (await api().post(`${base}/connections`).set(await as(ids.ownerA))
      .send({ providerKey: 'sql_agent', name: 'ERP API', externalSystem: 'erp-api', agentId: agent.id, config: CONFIG }).expect(201)).body;
    connId = created.id;
    expect(created.problems).toContain('Type the API\'s token (it is sealed in your browser and only the agent can open it)');
    const sealed = seal(created.agent.sealingKey, connId, JSON.stringify({ username: '', password: 'erp-token' }));
    await api().put(`${base}/connections/${connId}/agent-credential`).set(await as(ids.ownerA)).send({ keyId: created.agent.keyId, sealed }).expect(200);
    const stored = await agents.does(agent, 'complete', { result: { stored: true, username: '' } });
    expect(stored.kind).toBe('store_credential');
    await api().post(`${base}/connections/${connId}/test`).set(await as(ids.ownerA)).send({}).expect(200);
    const test = await agents.does(agent, 'complete', { result: { ok: true, message: 'The API answered 200 at /api/health', engine: 'rest' } });
    expect(test.spec.connection).toMatchObject(CONFIG);
    const detail = (await api().get(`${base}/connections/${connId}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(detail.lastTest).toMatchObject({ ok: true, message: 'The API answered 200 at /api/health' });
    expect(detail.problems).toEqual([]);
    await api().post(`${base}/connections/${connId}/agent-jobs`).set(await as(ids.ownerA)).send({ kind: 'discover', request: {} }).expect(409);
    await api().post(`${base}/connections/${connId}/agent-jobs`).set(await as(ids.ownerA)).send({ kind: 'preview', request: { path: '/v1/../admin' } }).expect(400);
    await api().post(`${base}/connections/${connId}/ready`).set(await as(ids.ownerA)).send({}).expect(200);
    expect((await api().post(`${base}/connections/${connId}/activate`).set(await as(ids.ownerA)).send({}).expect(200)).body.status).toBe('active');
  });

  it('tries an address through the agent and offers what it sent as the sample to map', async () => {
    await api().put(`${base}/connections/${connId}/record-source`).set(await as(ids.ownerA)).send({ entityType: 'machine', source: { ...SOURCE, changedParam: undefined } }).expect(400);
    await api().put(`${base}/connections/${connId}/record-source`).set(await as(ids.ownerA)).send({ entityType: 'machine', source: { file: 'm.csv' } }).expect(409);
    const r = (await api().put(`${base}/connections/${connId}/record-source`).set(await as(ids.ownerA)).send({ entityType: 'machine', source: SOURCE }).expect(200)).body;
    expect(r.recordSources).toEqual([expect.objectContaining({ entityType: 'machine', source: SOURCE })]);
    const none = await api().post(`${base}/connections/${connId}/sample`).set(await as(ids.ownerA)).send({ entityType: 'machine' }).expect(409);
    expect(none.body.error.code).toBe('agent_sample_needed');
    await api().post(`${base}/connections/${connId}/agent-jobs`).set(await as(ids.ownerA))
      .send({ kind: 'preview', request: { path: SOURCE.path, recordsPath: 'data', paging: SOURCE.paging, limit: 20 } }).expect(201);
    const job = await agents.take(agent);
    expect(job.spec.request).toEqual({ path: SOURCE.path, recordsPath: 'data', paging: SOURCE.paging, limit: 20 });
    const columns = ['code', 'name', 'site.code', 'updatedAt'];
    await agents.signed(agent, `/api/v1/integrations/agent/jobs/${job.id}/complete`, {
      result: { path: SOURCE.path, columns: columns.map((name) => ({ name, type: 'text' })), rows: ROWS.slice(0, 3), truncated: true, pageRecords: 500, morePages: true },
    }).expect(200);
    const sample = (await api().post(`${base}/connections/${connId}/sample`).set(await as(ids.ownerA)).send({ entityType: 'machine' }).expect(200)).body;
    expect(sample.columns).toEqual(columns);
    expect(sample.rows[0].v).toEqual({ code: 'RM-1', name: 'Rest machine 1', 'site.code': 'MAIN', updatedAt: '2026-11-16T00:00:00Z' });
    const fields = [{ target: 'code', source: 'code' }, { target: 'name', source: 'name' }, { target: 'site', source: 'site.code' }];
    templateId = (await api().post(`${base}/templates`).set(await as(ids.ownerA)).send({
      entityType: 'machine', name: 'API machines', keyField: 'code', fields, expectedColumns: columns, settings: { writeMode: 'add_update', matchExisting: false },
    }).expect(201)).body.id;
  });

  it('imports the endpoint, again with nothing written, and reads only what changed since the mark', async () => {
    const first = await run('full', { templateId });
    let job = await agents.take(agent);
    expect(job.kind).toBe('extract');
    expect(job.spec.request).toMatchObject({ path: SOURCE.path, changedColumn: 'updatedAt', changedParam: 'since' });
    expect(job.spec.request.changedSince).toBeUndefined();
    await sends(job.id, ROWS);
    expect(await carryOn(first.id)).toMatchObject({ status: 'succeeded', counts: { total: 700, created: 700 } });
    expect((await admin.query(`select count(*)::int as n from public.machines where organisation_id = $1 and code like 'RM-%'`, [ids.orgA])).rows[0].n).toBe(700);
    const cursor = (await admin.query(`select cursor from public.integration_sync_cursors where connection_id = $1 and entity_type = 'machine'`, [connId])).rows[0].cursor;
    expect(JSON.parse(cursor)).toEqual({ w: '2026-11-16T06:00:00Z' });

    const again = await run('full', { templateId });
    job = await agents.take(agent);
    await sends(job.id, ROWS);
    expect(await carryOn(again.id)).toMatchObject({ status: 'succeeded', counts: { total: 700, created: 0, updated: 0, unchanged: 700 } });

    const inc = await run('incremental', { templateId });
    job = await agents.take(agent);
    expect(job.spec.request.changedSince).toBe('2026-11-16T06:00:00Z');
    const changed = [{ ...ROWS[0], name: 'Rest machine 1 (rebuilt)', updatedAt: '2026-11-16T07:00:00Z' }];
    await sends(job.id, changed);
    expect(await carryOn(inc.id)).toMatchObject({ kind: 'incremental', status: 'succeeded', counts: { total: 1, updated: 1 } });
    expect((await admin.query(`select name from public.machines where organisation_id = $1 and code = 'RM-1'`, [ids.orgA])).rows[0].name).toBe('Rest machine 1 (rebuilt)');
  });

  it('fails the import with the agent\'s words when the API cannot be read', async () => {
    const broken = await run('full', { templateId });
    const job = await agents.take(agent);
    await agents.signed(agent, `/api/v1/integrations/agent/jobs/${job.id}/fail`, {
      kind: 'refused', message: 'erp.factory.local:8080 is not on this agent\'s allow-list: add it under "hosts" in allowlist.json on the agent\'s machine', transient: false,
    }).expect(200);
    const detail = (await api().get(`${base}/runs/${broken.id}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(detail.status).toBe('failed');
    expect(JSON.stringify(detail)).toMatch(/not on this agent's allow-list/);
  });
});
