/**
 * Connector agent updates (docs/connector-agent-plan.md AG6b): an operator publishes a signed release (Fortress checks the signature against
 * AGENT_RELEASE_KEYS); an admin approves an update of one agent to it; the agent takes the job carrying the manifest; completing it stages the
 * update; the next heartbeat at the new version applies it; a roll-back is reported in a heartbeat. Withdrawing cancels waiting updates.
 */
import { INestApplication } from '@nestjs/common';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { agentClient, type TestAgent } from './agent-helpers';
import { giveControllerSeats, makeIds, requireDb, seed, startApp, token } from './helpers';
import { releaseKeyId } from '../src/integrations/agents/agent-release';

const ids = makeIds('a6b');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, claims: Record<string, unknown> = {}, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user, claims)}`, 'X-Organisation-Id': org });
const operator = () => as(ids.outsider, { aal: 'aal2' });
const agents = agentClient(() => app);

const pair = () => {
  const p = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey: p.privateKey, spki: p.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
};
const releaseKey = pair();
const strangerKey = pair();
const manifest = (version: string, platform = 'win-x64') =>
  JSON.stringify({ format: 'fortress-agent-release-v1', version, platform, url: `https://releases.example.com/FortressAgent-${version}-${platform}.zip`, sha256: 'd'.repeat(64), size: 2048, notes: `Version ${version}` });
const signed = (text: string, key = releaseKey) => sign('sha256', Buffer.from(text), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
const publish = async (version: string, platform = 'win-x64') => {
  const m = manifest(version, platform);
  return (await api().post('/api/v1/platform/agent-releases').set(await operator()).send({ manifest: m, signature: signed(m) }).expect(201)).body.id as string;
};

let agent: TestAgent;

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ag6b');
  await giveControllerSeats(admin, ids.orgA, [ids.ownerA]);
  await giveControllerSeats(admin, ids.orgB, [ids.ownerB]);
  await admin.query(`insert into public.platform_admins (user_id, note) values ($1, 'e2e operator') on conflict do nothing`, [ids.outsider]);
  // Releases are global: withdraw any another suite published (the tenancy sweep seeds one), so "the newest release" here is this suite's.
  await admin.query(`update public.integration_agent_releases set status = 'withdrawn', withdrawn_at = now(), withdrawn_reason = 'Withdrawn by the agent-updates e2e' where status = 'published'`);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000', AGENT_RELEASE_KEYS: releaseKey.spki });
  agent = await agents.register(await as(ids.ownerA), 'Update agent');
  // The agent says which platform it runs on (AG6b) in its heartbeat.
  await agents.signed(agent, '/api/v1/integrations/agent/heartbeat', { version: '0.6.0', capabilities: { platform: 'win-x64', jobs: ['update_agent'] } }).expect(200);
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('publishing a release', () => {
  it('is the operator\'s, needs a signature by a configured key and a manifest that reads right', async () => {
    const m = manifest('0.7.0');
    await api().post('/api/v1/platform/agent-releases').set(await as(ids.ownerA)).send({ manifest: m, signature: signed(m) }).expect(404);
    const noMfa = await api().post('/api/v1/platform/agent-releases').set(await as(ids.outsider)).send({ manifest: m, signature: signed(m) });
    expect(noMfa.status).toBe(403);
    const stranger = await api().post('/api/v1/platform/agent-releases').set(await operator()).send({ manifest: m, signature: signed(m, strangerKey) }).expect(400);
    expect(stranger.body.error.message).toMatch(/does not match/);
    const tampered = await api().post('/api/v1/platform/agent-releases').set(await operator()).send({ manifest: m.replace('releases.example', 'evil.example'), signature: signed(m) }).expect(400);
    expect(tampered.body.error.message).toMatch(/does not match/);
    const http = manifest('0.7.0').replace('https://', 'http://');
    const bad = await api().post('/api/v1/platform/agent-releases').set(await operator()).send({ manifest: http, signature: signed(http) }).expect(400);
    expect(bad.body.error.message).toMatch(/https/);
    const ok = await api().post('/api/v1/platform/agent-releases').set(await operator()).send({ manifest: m, signature: signed(m) }).expect(201);
    expect(ok.body.keyId).toBe(releaseKeyId(releaseKey.spki));
    await api().post('/api/v1/platform/agent-releases').set(await operator()).send({ manifest: m, signature: signed(m) }).expect(409);
    const list = await api().get('/api/v1/platform/agent-releases').set(await operator()).expect(200);
    expect(list.body).toMatchObject({ keysConfigured: true, keyIds: [releaseKeyId(releaseKey.spki)] });
    expect(list.body.data.find((r: { version: string }) => r.version === '0.7.0')).toMatchObject({ platform: 'win-x64', status: 'published', sizeBytes: 2048, notes: 'Version 0.7.0' });
  });

  it('cannot happen without a configured key', async () => {
    const bare = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
    const m = manifest('0.7.1');
    const res = await request(bare.getHttpServer()).post('/api/v1/platform/agent-releases').set(await operator()).send({ manifest: m, signature: signed(m) });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('release_keys_unavailable');
    await bare.close();
  });
});

describe('updating an agent', () => {
  let rel8: string;
  let rel9: string;

  beforeAll(async () => {
    rel8 = await publish('0.8.0');
    rel9 = await publish('0.9.0');
    await publish('0.9.5', 'linux-x64');
  });

  it('the agent page offers the newest release for its platform; only a manager approves', async () => {
    const page = await api().get(`/api/v1/integrations/agents/${agent.id}`).set(await as(ids.ownerA)).expect(200);
    expect(page.body).toMatchObject({ platform: 'win-x64', version: '0.6.0', availableUpdate: { version: '0.9.0', platform: 'win-x64' }, updates: [] });
    // Integrations are for Controller-seat holders with integrations.read; an inspector sees no releases and approves nothing.
    await api().get('/api/v1/integrations/agent-releases').set(await as(ids.inspectorA)).expect(403);
    const releases = await api().get('/api/v1/integrations/agent-releases').set(await as(ids.ownerA)).expect(200);
    expect(releases.body.data.map((r: { version: string }) => r.version)).toEqual(expect.arrayContaining(['0.7.0', '0.8.0', '0.9.0', '0.9.5']));
    await api().post(`/api/v1/integrations/agents/${agent.id}/updates`).set(await as(ids.inspectorA)).send({ releaseId: rel8 }).expect(403);
    await api().post(`/api/v1/integrations/agents/${agent.id}/updates`).set(await as(ids.ownerB, {}, ids.orgB)).send({ releaseId: rel8 }).expect(404);
  });

  it('approve → the agent takes the job with the manifest → staged → applied when it comes back at the version', async () => {
    const upd = await api().post(`/api/v1/integrations/agents/${agent.id}/updates`).set(await as(ids.ownerA)).send({ releaseId: rel8 }).expect(201);
    expect(upd.body).toMatchObject({ fromVersion: '0.6.0', toVersion: '0.8.0', status: 'waiting' });
    const again = await api().post(`/api/v1/integrations/agents/${agent.id}/updates`).set(await as(ids.ownerA)).send({ releaseId: rel9 });
    expect(again.status).toBe(409);
    const job = await agents.take(agent);
    expect(job.kind).toBe('update_agent');
    expect(job.spec).toMatchObject({ updateId: upd.body.id, version: '0.8.0', manifest: manifest('0.8.0'), keyId: releaseKeyId(releaseKey.spki) });
    expect(job.spec.signature).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    await agents.signed(agent, `/api/v1/integrations/agent/jobs/${job.id}/complete`, { result: { staged: true, version: '0.8.0' } }).expect(200);
    let page = await api().get(`/api/v1/integrations/agents/${agent.id}`).set(await as(ids.ownerA)).expect(200);
    expect(page.body.updates[0]).toMatchObject({ id: upd.body.id, status: 'staged' });
    await api().post(`/api/v1/integrations/agent-updates/${upd.body.id}/cancel`).set(await as(ids.ownerA)).expect(409);
    await agents.signed(agent, '/api/v1/integrations/agent/heartbeat', { version: '0.8.0', capabilities: { platform: 'win-x64' } }).expect(200);
    page = await api().get(`/api/v1/integrations/agents/${agent.id}`).set(await as(ids.ownerA)).expect(200);
    expect(page.body).toMatchObject({ version: '0.8.0', availableUpdate: { version: '0.9.0' } });
    expect(page.body.updates[0]).toMatchObject({ status: 'applied', approvedBy: expect.any(String) });
    expect(page.body.events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['update_approved', 'update_staged', 'update_applied']));
  });

  it('a roll-back is reported in a heartbeat; a waiting update can be cancelled', async () => {
    const upd = await api().post(`/api/v1/integrations/agents/${agent.id}/updates`).set(await as(ids.ownerA)).send({ releaseId: rel9 }).expect(201);
    const job = await agents.take(agent);
    await agents.signed(agent, `/api/v1/integrations/agent/jobs/${job.id}/complete`, { result: { staged: true } }).expect(200);
    const beat = await agents.signed(agent, '/api/v1/integrations/agent/heartbeat', {
      version: '0.8.0', capabilities: { platform: 'win-x64' },
      updateReport: { updateId: upd.body.id, outcome: 'rolled_back', message: 'Version 0.9.0 did not check in within 5 minutes; 0.8.0 was put back' },
    }).expect(200);
    expect(beat.body.updateReport).toBe('rolled_back');
    let page = await api().get(`/api/v1/integrations/agents/${agent.id}`).set(await as(ids.ownerA)).expect(200);
    expect(page.body.updates[0]).toMatchObject({ status: 'rolled_back', message: expect.stringMatching(/did not check in/) });

    const second = await api().post(`/api/v1/integrations/agents/${agent.id}/updates`).set(await as(ids.ownerA)).send({ releaseId: rel9 }).expect(201);
    await api().post(`/api/v1/integrations/agent-updates/${second.body.id}/cancel`).set(await as(ids.inspectorA)).expect(403);
    const cancelled = await api().post(`/api/v1/integrations/agent-updates/${second.body.id}/cancel`).set(await as(ids.ownerA)).expect(200);
    expect(cancelled.body.status).toBe('cancelled');
    await agents.signed(agent, '/api/v1/integrations/agent/jobs/next').expect(204);
    page = await api().get(`/api/v1/integrations/agents/${agent.id}`).set(await as(ids.ownerA)).expect(200);
    expect(page.body.updates.map((u: { status: string }) => u.status).slice(0, 2)).toEqual(['cancelled', 'rolled_back']);
  });

  it('withdrawing a release cancels updates waiting for it and members no longer see it', async () => {
    const upd = await api().post(`/api/v1/integrations/agents/${agent.id}/updates`).set(await as(ids.ownerA)).send({ releaseId: rel9 }).expect(201);
    await api().post(`/api/v1/platform/agent-releases/${rel9}/withdraw`).set(await as(ids.ownerA)).send({ reason: 'Not mine' }).expect(404);
    await api().post(`/api/v1/platform/agent-releases/${rel9}/withdraw`).set(await operator()).send({ reason: 'Breaks SQL Server 2014' }).expect(200);
    const page = await api().get(`/api/v1/integrations/agents/${agent.id}`).set(await as(ids.ownerA)).expect(200);
    expect(page.body.updates[0]).toMatchObject({ id: upd.body.id, status: 'cancelled', message: expect.stringMatching(/withdrawn/) });
    expect(page.body.availableUpdate).toBeNull();
    const releases = await api().get('/api/v1/integrations/agent-releases').set(await as(ids.ownerA)).expect(200);
    expect(releases.body.data.map((r: { version: string }) => r.version)).not.toContain('0.9.0');
    const ops = await api().get('/api/v1/platform/agent-releases').set(await operator()).expect(200);
    expect(ops.body.data.find((r: { version: string }) => r.version === '0.9.0')).toMatchObject({ status: 'withdrawn', withdrawnReason: 'Breaks SQL Server 2014' });
  });
});
