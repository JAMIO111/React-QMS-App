/**
 * Connector agents AG1 through the API (docs/connector-agent-plan.md): one-time registrations, an agent registering with real P-256 keys and then
 * signing every request, replayed / changed / stale / unknown requests refused, a ping job end to end, the network rule for agent requests,
 * key rotation, revocation and deregistration, and that another organisation's people and agents cannot reach any of it.
 * The rules themselves are in supabase/tests/connector_agents.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { canonicalString, REGISTRATION_SUBJECT } from '../src/integrations/agents/agent-signature';
import { giveControllerSeats, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a91');
let app: INestApplication;
let admin: Pool;
const OFFICE = '203.0.113.10';
const ELSEWHERE = '198.51.100.200';
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org, 'X-Forwarded-For': OFFICE });

interface TestAgent {
  id: string;
  signing: { spki: string; privateKey: KeyObject };
  sealing: { spki: string };
}
const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateKey };
};

/** Send a request signed as the agent would. `tamper` changes something after signing. */
function signed(
  agent: { id: string; signing: { privateKey: KeyObject } },
  method: 'post',
  path: string,
  body: unknown = {},
  opts: { from?: string; nonce?: string; timestamp?: string; tamper?: (b: string) => string } = {},
) {
  const raw = JSON.stringify(body);
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? randomBytes(16).toString('hex');
  const signature = sign('sha256', Buffer.from(canonicalString({ method, path, body: Buffer.from(raw), timestamp, nonce, agentId: agent.id })), {
    key: agent.signing.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');
  return api()
    [method](path)
    .set({
      'Content-Type': 'application/json',
      'X-Agent-Id': agent.id,
      'X-Agent-Timestamp': timestamp,
      'X-Agent-Nonce': nonce,
      'X-Agent-Signature': signature,
      'X-Forwarded-For': opts.from ?? OFFICE,
    })
    .send(opts.tamper ? opts.tamper(raw) : raw);
}

async function register(tokenValue: string, from = OFFICE, keys = { signing: pair(), sealing: pair() }) {
  const path = '/api/v1/integrations/agent/register';
  const body = JSON.stringify({ token: tokenValue, signingKey: keys.signing.spki, sealingKey: keys.sealing.spki, version: '0.1.0', os: 'Windows Server 2022', machine: 'ERP01', capabilities: { adapters: [] } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const signature = sign('sha256', Buffer.from(canonicalString({ method: 'POST', path, body: Buffer.from(body), timestamp, nonce, agentId: REGISTRATION_SUBJECT })), {
    key: keys.signing.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');
  const res = await api().post(path).set({ 'Content-Type': 'application/json', 'X-Agent-Timestamp': timestamp, 'X-Agent-Nonce': nonce, 'X-Agent-Signature': signature, 'X-Forwarded-For': from }).send(body);
  return { res, agent: { id: res.body.agentId as string, signing: keys.signing, sealing: keys.sealing } as TestAgent };
}

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ag1');
  await giveControllerSeats(admin, ids.orgA, [ids.ownerA]);
  await giveControllerSeats(admin, ids.orgB, [ids.ownerB]);
  app = await startApp({ TRUST_PROXY_HOPS: '1', RATE_LIMIT_PER_MINUTE: '10000', AGENT_DOWNLOAD_URL: 'https://downloads.example.com/FortressConnectorSetup.exe' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

let agent: TestAgent;
let tokenA: string;

describe('registrations', () => {
  it('Controller seat holders who manage integrations make them; the token is shown once', async () => {
    await api().post('/api/v1/integrations/agent-registrations').set(await as(ids.inspectorA)).send({ name: 'Newcastle' }).expect(403);
    const res = await api().post('/api/v1/integrations/agent-registrations').set(await as(ids.ownerA)).send({ name: 'Newcastle factory', location: 'Server room B' }).expect(201);
    expect(res.body.token).toMatch(/^FAGT-[A-Za-z0-9_-]{43}$/);
    expect(res.body.apiUrl).toMatch(/\/api\/v1$/);
    expect(res.body.downloadUrl).toBe('https://downloads.example.com/FortressConnectorSetup.exe');
    tokenA = res.body.token;
    const list = await api().get('/api/v1/integrations/agent-registrations').set(await as(ids.ownerA)).expect(200);
    expect(list.body.data[0]).toMatchObject({ name: 'Newcastle factory', state: 'waiting' });
    expect(JSON.stringify(list.body)).not.toContain(tokenA);
    const stored = await admin.query('select token_hash from public.integration_agent_registrations where organisation_id = $1', [ids.orgA]);
    expect(JSON.stringify(stored.rows)).not.toContain(tokenA);
  });
});

describe('registering', () => {
  it('refuses a registration not signed with the key it registers', async () => {
    const keys = { signing: pair(), sealing: pair() };
    const other = pair();
    const { res } = await register(tokenA, OFFICE, { signing: { spki: keys.signing.spki, privateKey: other.privateKey }, sealing: keys.sealing });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('agent_unauthenticated');
  });

  it('registers with the token, once', async () => {
    const first = await register(tokenA);
    expect(first.res.status).toBe(201);
    expect(first.res.body).toMatchObject({ organisationId: ids.orgA, name: 'Newcastle factory', pollSeconds: 60 });
    expect(first.res.body.fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    agent = first.agent;
    const again = await register(tokenA);
    expect(again.res.status).toBe(409);
    expect(again.res.body.error.message).toMatch(/not valid/);
  });
});

describe('signed requests', () => {
  it('a heartbeat is accepted and the agent shows online', async () => {
    const res = await signed(agent, 'post', '/api/v1/integrations/agent/heartbeat', { version: '0.1.1', os: 'Windows Server 2022', machine: 'ERP01' }).expect(200);
    expect(res.body).toMatchObject({ revoked: false, jobsWaiting: false, pollSeconds: 60 });
    const list = await api().get('/api/v1/integrations/agents').set(await as(ids.ownerA)).expect(200);
    expect(list.body.data[0]).toMatchObject({ id: agent.id, online: true, version: '0.1.1', machineName: 'ERP01', status: 'active' });
    expect(list.body.onlineCount).toBe(1);
  });

  it('refuses a changed body, a replay, an old timestamp and an unknown agent', async () => {
    const changed = await signed(agent, 'post', '/api/v1/integrations/agent/heartbeat', { version: '0.1.1' }, { tamper: (b) => b.replace('0.1.1', '6.6.6') });
    expect(changed.status).toBe(401);
    const nonce = randomBytes(16).toString('hex');
    await signed(agent, 'post', '/api/v1/integrations/agent/heartbeat', {}, { nonce }).expect(200);
    const replay = await signed(agent, 'post', '/api/v1/integrations/agent/heartbeat', {}, { nonce });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('agent_replay');
    const stale = await signed(agent, 'post', '/api/v1/integrations/agent/heartbeat', {}, { timestamp: String(Math.floor(Date.now() / 1000) - 600) });
    expect(stale.body.error.code).toBe('agent_clock');
    const unknown = await signed({ id: '00000000-0000-0000-0000-00000000dead', signing: agent.signing }, 'post', '/api/v1/integrations/agent/heartbeat', {});
    expect(unknown.status).toBe(401);
    const unsigned = await api().post('/api/v1/integrations/agent/heartbeat').send({});
    expect(unsigned.status).toBe(401);
  });

  it('a person\'s token does not work on the agent\'s routes', async () => {
    const res = await api().post('/api/v1/integrations/agent/jobs/next').set(await as(ids.ownerA));
    expect(res.status).toBe(401);
  });
});

describe('a ping, end to end', () => {
  it('a person pings, the agent takes it, answers, and the person sees the answer', async () => {
    await api().post(`/api/v1/integrations/agents/${agent.id}/ping`).set(await as(ids.inspectorA)).send({}).expect(403);
    const ping = await api().post(`/api/v1/integrations/agents/${agent.id}/ping`).set(await as(ids.ownerA)).send({ idempotencyKey: 'ping-e2e-0001' }).expect(201);
    expect(ping.body).toMatchObject({ kind: 'ping', status: 'pending' });
    const hb = await signed(agent, 'post', '/api/v1/integrations/agent/heartbeat', {}).expect(200);
    expect(hb.body).toMatchObject({ jobsWaiting: true, pollSeconds: 15 });
    const next = await signed(agent, 'post', '/api/v1/integrations/agent/jobs/next').expect(200);
    expect(next.body).toMatchObject({ id: ping.body.id, kind: 'ping', attempt: 1 });
    await signed(agent, 'post', '/api/v1/integrations/agent/jobs/next').expect(204);
    await signed(agent, 'post', `/api/v1/integrations/agent/jobs/${ping.body.id}/ack`).expect(200);
    const done = await signed(agent, 'post', `/api/v1/integrations/agent/jobs/${ping.body.id}/complete`, { result: { pong: true, version: '0.1.1' } }).expect(200);
    expect(done.body.status).toBe('completed');
    const job = await api().get(`/api/v1/integrations/agent-jobs/${ping.body.id}`).set(await as(ids.ownerA)).expect(200);
    expect(job.body).toMatchObject({ status: 'completed', result: { pong: true, version: '0.1.1' } });
    const detail = await api().get(`/api/v1/integrations/agents/${agent.id}`).set(await as(ids.ownerA)).expect(200);
    expect(detail.body.jobs[0]).toMatchObject({ id: ping.body.id, status: 'completed' });
    expect(detail.body.events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['registered', 'version_changed']));
    expect(detail.body.keys[0]).toMatchObject({ status: 'active' });
  });

  it('a failure the agent reports shows as the agent\'s last error', async () => {
    const ping = await api().post(`/api/v1/integrations/agents/${agent.id}/ping`).set(await as(ids.ownerA)).send({}).expect(201);
    await signed(agent, 'post', '/api/v1/integrations/agent/jobs/next').expect(200);
    await signed(agent, 'post', `/api/v1/integrations/agent/jobs/${ping.body.id}/fail`, { kind: 'internal', message: 'Something went wrong on the agent' }).expect(200);
    const list = await api().get('/api/v1/integrations/agents').set(await as(ids.ownerA)).expect(200);
    expect(list.body.data[0].lastError.message).toBe('Something went wrong on the agent');
  });
});

describe('another organisation', () => {
  it('cannot see, ping, rename or revoke A\'s agent, nor read its jobs', async () => {
    const b = await as(ids.ownerB, ids.orgB);
    await api().get(`/api/v1/integrations/agents/${agent.id}`).set(b).expect(404);
    await api().post(`/api/v1/integrations/agents/${agent.id}/ping`).set(b).send({}).expect(404);
    await api().patch(`/api/v1/integrations/agents/${agent.id}`).set(b).send({ name: 'Hijacked' }).expect(404);
    await api().post(`/api/v1/integrations/agents/${agent.id}/revoke`).set(b).send({ reason: 'Not ours' }).expect(404);
    expect((await api().get('/api/v1/integrations/agents').set(b).expect(200)).body.data).toEqual([]);
  });

  it('B\'s agent cannot report on A\'s job', async () => {
    const reg = await api().post('/api/v1/integrations/agent-registrations').set(await as(ids.ownerB, ids.orgB)).send({ name: 'Beta agent' }).expect(201);
    const b = await register(reg.body.token);
    expect(b.res.status).toBe(201);
    const ping = await api().post(`/api/v1/integrations/agents/${agent.id}/ping`).set(await as(ids.ownerA)).send({}).expect(201);
    await signed(b.agent, 'post', `/api/v1/integrations/agent/jobs/${ping.body.id}/complete`, { result: {} }).expect(404);
    await signed(b.agent, 'post', '/api/v1/integrations/agent/jobs/next').expect(204);
  });
});

describe('the network rule applies to agents', () => {
  it('while enforced, an agent outside the approved networks is refused and recorded', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/security/networks').set(h).send({ name: 'Office', network: '203.0.113.0/24' }).expect(201);
    await api().put('/api/v1/security/access-policy').set(h).send({ mode: 'enforce', confirm: true }).expect(200);
    await signed(agent, 'post', '/api/v1/integrations/agent/heartbeat', {}).expect(200);
    const away = await signed(agent, 'post', '/api/v1/integrations/agent/heartbeat', {}, { from: ELSEWHERE });
    expect(away.status).toBe(403);
    expect(away.body.error).toMatchObject({ code: 'network_not_allowed', details: { address: ELSEWHERE } });
    const denials = await admin.query('select count(*)::int n from public.access_denials where organisation_id = $1 and address = $2 and user_id is null', [ids.orgA, ELSEWHERE]);
    expect(denials.rows[0].n).toBe(1);
    await api().put('/api/v1/security/access-policy').set(h).send({ mode: 'off' }).expect(200);
  });
});

describe('keys and the end of an agent', () => {
  it('rotates its key: the old one stops working', async () => {
    const next = { signing: pair(), sealing: pair() };
    await signed(agent, 'post', '/api/v1/integrations/agent/keys/rotate', { signingKey: next.signing.spki, sealingKey: next.sealing.spki }).expect(200);
    const old = await signed(agent, 'post', '/api/v1/integrations/agent/heartbeat', {});
    expect(old.status).toBe(401);
    agent = { ...agent, signing: next.signing, sealing: next.sealing };
    await signed(agent, 'post', '/api/v1/integrations/agent/heartbeat', {}).expect(200);
  });

  it('renaming needs a name; revoking needs a reason and stops the agent at once', async () => {
    const h = await as(ids.ownerA);
    const renamed = await api().patch(`/api/v1/integrations/agents/${agent.id}`).set(h).send({ name: 'Newcastle ERP', location: 'Rack 3' }).expect(200);
    expect(renamed.body).toMatchObject({ name: 'Newcastle ERP', location: 'Rack 3' });
    await api().post(`/api/v1/integrations/agents/${agent.id}/revoke`).set(h).send({ reason: 'x' }).expect(400);
    const revoked = await api().post(`/api/v1/integrations/agents/${agent.id}/revoke`).set(h).send({ reason: 'Server decommissioned' }).expect(200);
    expect(revoked.body).toMatchObject({ status: 'revoked', online: false, revokedReason: 'Server decommissioned' });
    const after = await signed(agent, 'post', '/api/v1/integrations/agent/heartbeat', {});
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('agent_revoked');
  });

  it('an agent being uninstalled revokes itself', async () => {
    const reg = await api().post('/api/v1/integrations/agent-registrations').set(await as(ids.ownerA)).send({ name: 'Short-lived' }).expect(201);
    const { agent: temp } = await register(reg.body.token);
    await signed(temp, 'post', '/api/v1/integrations/agent/deregister').expect(200);
    const res = await signed(temp, 'post', '/api/v1/integrations/agent/heartbeat', {});
    expect(res.body.error.code).toBe('agent_revoked');
  });

  it('a cancelled registration cannot be used', async () => {
    const reg = await api().post('/api/v1/integrations/agent-registrations').set(await as(ids.ownerA)).send({ name: 'Never used' }).expect(201);
    await api().post(`/api/v1/integrations/agent-registrations/${reg.body.id}/cancel`).set(await as(ids.ownerA)).expect(200);
    expect((await register(reg.body.token)).res.status).toBe(409);
  });
});
