/**
 * Connector agent AG2 through the API (docs/connector-agent-plan.md): a database connection on an agent, the password sealed as the browser seals
 * it and opened only by the agent, the test, browse and preview jobs, rights and isolation. The rules themselves are in
 * supabase/tests/agent_database_connections.test.sql; the agent's side of the sealing is in connector-agent/tests.
 */
import { INestApplication } from '@nestjs/common';
import { createDecipheriv, createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { canonicalString, REGISTRATION_SUBJECT } from '../src/integrations/agents/agent-signature';
import { giveControllerSeats, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a93');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateKey };
};
interface TestAgent { id: string; signing: { spki: string; privateKey: KeyObject }; sealing: { spki: string; privateKey: KeyObject } }

function signed(agent: TestAgent, path: string, body: unknown = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const signature = sign('sha256', Buffer.from(canonicalString({ method: 'POST', path, body: Buffer.from(raw), timestamp, nonce, agentId: agent.id })), {
    key: agent.signing.privateKey, dsaEncoding: 'ieee-p1363',
  }).toString('base64');
  return api().post(path).set({ 'Content-Type': 'application/json', 'X-Agent-Id': agent.id, 'X-Agent-Timestamp': timestamp, 'X-Agent-Nonce': nonce, 'X-Agent-Signature': signature }).send(raw);
}

async function registerAgent(user: string, org: string, name: string): Promise<TestAgent> {
  const reg = await api().post('/api/v1/integrations/agent-registrations').set(await as(user, org)).send({ name }).expect(201);
  const keys = { signing: pair(), sealing: pair() };
  const path = '/api/v1/integrations/agent/register';
  const body = JSON.stringify({ token: reg.body.token, signingKey: keys.signing.spki, sealingKey: keys.sealing.spki, version: '0.2.0', os: 'Windows Server 2022', machine: 'ERP01' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const signature = sign('sha256', Buffer.from(canonicalString({ method: 'POST', path, body: Buffer.from(body), timestamp, nonce, agentId: REGISTRATION_SUBJECT })), {
    key: keys.signing.privateKey, dsaEncoding: 'ieee-p1363',
  }).toString('base64');
  const res = await api().post(path).set({ 'Content-Type': 'application/json', 'X-Agent-Timestamp': timestamp, 'X-Agent-Nonce': nonce, 'X-Agent-Signature': signature }).send(body).expect(201);
  return { id: res.body.agentId, ...keys };
}

/** Seal as the browser does (WebCrypto): ephemeral ECDH P-256 → HKDF-SHA256 (info fortress-agent-credential-v1) → AES-256-GCM, the connection id as AAD. */
const INFO = Buffer.from('fortress-agent-credential-v1');
function seal(sealingSpki: string, connectionId: string, plaintext: string) {
  const eph = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const secret = diffieHellman({ privateKey: eph.privateKey, publicKey: createPublicKey({ key: Buffer.from(sealingSpki, 'base64'), format: 'der', type: 'spki' }) });
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), INFO, 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(connectionId));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { epk: eph.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') };
}
/** Open as the agent does, with its sealing private key. */
function open(agent: TestAgent, connectionId: string, s: { epk: string; iv: string; ct: string }) {
  const secret = diffieHellman({ privateKey: agent.sealing.privateKey, publicKey: createPublicKey({ key: Buffer.from(s.epk, 'base64'), format: 'der', type: 'spki' }) });
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), INFO, 32));
  const all = Buffer.from(s.ct, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'));
  decipher.setAAD(Buffer.from(connectionId));
  decipher.setAuthTag(all.subarray(all.length - 16));
  return Buffer.concat([decipher.update(all.subarray(0, all.length - 16)), decipher.final()]).toString('utf8');
}

/** The agent takes its next job, acks it and reports. */
async function agentDoes(agent: TestAgent, report: 'complete' | 'fail', payload: unknown) {
  const next = await signed(agent, '/api/v1/integrations/agent/jobs/next').expect(200);
  await signed(agent, `/api/v1/integrations/agent/jobs/${next.body.id}/ack`).expect(200);
  await signed(agent, `/api/v1/integrations/agent/jobs/${next.body.id}/${report}`, payload).expect(200);
  return next.body as { id: string; kind: string; spec: Record<string, unknown> };
}

const CONFIG = { engine: 'postgres', server: 'erp-db.factory.local', port: 5432, database: 'erp', authType: 'password', encrypt: true };

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ag2');
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
let connectionId: string;

describe('a database connection on an agent', () => {
  it('names its agent, and only its own organisation\'s', async () => {
    agent = await registerAgent(ids.ownerA, ids.orgA, 'Newcastle');
    agentB = await registerAgent(ids.ownerB, ids.orgB, 'Beta');
    const body = { providerKey: 'sql_agent', name: 'ERP database', externalSystem: 'erp', config: CONFIG };
    await api().post('/api/v1/integrations/connections').set(await as(ids.ownerA)).send(body).expect(400);
    await api().post('/api/v1/integrations/connections').set(await as(ids.ownerA)).send({ ...body, agentId: agentB.id }).expect(404);
    await api().post('/api/v1/integrations/connections').set(await as(ids.inspectorA)).send({ ...body, agentId: agent.id }).expect(403);
    const bad = await api().post('/api/v1/integrations/connections').set(await as(ids.ownerA)).send({ ...body, agentId: agent.id, config: { ...CONFIG, server: 'db;Password=x' } }).expect(409);
    expect(bad.body.error.message).toMatch(/server/);
    const res = await api().post('/api/v1/integrations/connections').set(await as(ids.ownerA)).send({ ...body, agentId: agent.id }).expect(201);
    connectionId = res.body.id;
    expect(res.body.provider.key).toBe('sql_agent');
    expect(res.body.agent).toMatchObject({ id: agent.id, name: 'Newcastle', status: 'active', online: true, sealingKey: agent.sealing.spki });
    expect(res.body.agent.keyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.problems).toEqual(expect.arrayContaining(['Test the connection', expect.stringMatching(/^Type the database password/)]));
    expect(res.body.agentCredential).toBeNull();
  });

  it('gives the agent the password, sealed so that only the agent can open it', async () => {
    const detail = (await api().get(`/api/v1/integrations/connections/${connectionId}`).set(await as(ids.ownerA)).expect(200)).body;
    const sealed = seal(detail.agent.sealingKey, connectionId, JSON.stringify({ username: 'reader', password: 'hunter2' }));
    await api().put(`/api/v1/integrations/connections/${connectionId}/agent-credential`).set(await as(ids.inspectorA)).send({ keyId: detail.agent.keyId, sealed }).expect(403);
    await api().put(`/api/v1/integrations/connections/${connectionId}/agent-credential`).set(await as(ids.ownerB, ids.orgB)).send({ keyId: detail.agent.keyId, sealed }).expect(404);
    await api().put(`/api/v1/integrations/connections/${connectionId}/agent-credential`).set(await as(ids.ownerA)).send({ keyId: detail.agent.keyId, password: 'hunter2' }).expect(400);
    const res = await api().put(`/api/v1/integrations/connections/${connectionId}/agent-credential`).set(await as(ids.ownerA)).send({ keyId: detail.agent.keyId, sealed }).expect(200);
    expect(res.body.agentCredential).toMatchObject({ status: 'waiting' });
    expect(res.body.agentJobs[0]).toMatchObject({ kind: 'store_credential', status: 'pending' });

    const job = await agentDoes(agent, 'complete', { result: { stored: true } });
    expect(job.kind).toBe('store_credential');
    expect(open(agent, connectionId, job.spec.sealed as { epk: string; iv: string; ct: string })).toBe(JSON.stringify({ username: 'reader', password: 'hunter2' }));
    // Sealed to this connection: it cannot be replayed onto another
    expect(() => open(agent, ids.orgA, job.spec.sealed as { epk: string; iv: string; ct: string })).toThrow();

    const after = (await api().get(`/api/v1/integrations/connections/${connectionId}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(after.agentCredential).toMatchObject({ status: 'stored' });
    const kept = await admin.query('select spec from public.integration_agent_jobs where id = $1', [job.id]);
    expect(kept.rows[0].spec.sealed).toBeUndefined();
    const jobView = await api().get(`/api/v1/integrations/agent-jobs/${job.id}`).set(await as(ids.ownerA)).expect(200);
    expect(JSON.stringify(jobView.body)).not.toContain(job.spec.sealed && (job.spec.sealed as { ct: string }).ct);
  });

  it('is tested by its agent, and the answer is recorded on the connection', async () => {
    const asked = await api().post(`/api/v1/integrations/connections/${connectionId}/test`).set(await as(ids.ownerA)).expect(200);
    expect(asked.body.agentJobs[0]).toMatchObject({ kind: 'test_connection', status: 'pending' });
    const job = await agentDoes(agent, 'complete', { result: { ok: true, message: 'Signed in to PostgreSQL 16.4 as reader' } });
    expect(job.spec).toMatchObject({ connectionId, connection: CONFIG, request: {} });
    const detail = (await api().get(`/api/v1/integrations/connections/${connectionId}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(detail.lastTest).toMatchObject({ ok: true, message: 'Signed in to PostgreSQL 16.4 as reader' });
    expect(detail.problems).toEqual([]);
  });

  it('is browsed and previewed through structured requests, never SQL', async () => {
    const path = `/api/v1/integrations/connections/${connectionId}/agent-jobs`;
    await api().post(path).set(await as(ids.inspectorA)).send({ kind: 'discover' }).expect(403);
    await api().post(path).set(await as(ids.ownerB, ids.orgB)).send({ kind: 'discover' }).expect(404);
    await api().post(path).set(await as(ids.ownerA)).send({ kind: 'preview', request: { schema: 'erp', object: 'orders', sql: 'select 1' } }).expect(400);
    const noSchema = await api().post(path).set(await as(ids.ownerA)).send({ kind: 'discover', request: { level: 'objects' } }).expect(409);
    expect(noSchema.body.error.message).toBe('Choose the schema');
    const asked = await api().post(path).set(await as(ids.ownerA)).send({ kind: 'preview', request: { schema: 'erp', object: 'work orders', limit: 5 } }).expect(201);
    expect(asked.body).toMatchObject({ kind: 'preview', status: 'pending' });
    const job = await agentDoes(agent, 'complete', { result: { columns: [{ name: 'order no', type: 'text' }], rows: [{ 'order no': 'WO-1' }] } });
    expect(job.spec.request).toEqual({ schema: 'erp', object: 'work orders', limit: 5 });
    const done = await api().get(`/api/v1/integrations/agent-jobs/${asked.body.id}`).set(await as(ids.ownerA)).expect(200);
    expect(done.body).toMatchObject({ status: 'completed', result: { rows: [{ 'order no': 'WO-1' }] } });
  });

  it('cannot import until a table is chosen for the records (AG3)', async () => {
    const res = await api().post(`/api/v1/integrations/connections/${connectionId}/runs`).set(await as(ids.ownerA)).send({ entityType: 'machine', kind: 'preview' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/which table or file holds machine records/);
  });

  it('another organisation cannot see the connection', async () => {
    await api().get(`/api/v1/integrations/connections/${connectionId}`).set(await as(ids.ownerB, ids.orgB)).expect(404);
  });
});
