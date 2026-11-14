/**
 * Network allowlisting through the API (docs/security-plan.md SE2): who may manage it, approving networks, monitor and enforce, the check on every
 * organisation request (an existing session is blocked on its next request), the right organisation's policy for someone in two, /me telling the app,
 * lockout prevention, blocked attempts, and the address the API checks (a forged X-Forwarded-For in front of the proxy's is ignored).
 * The app trusts one proxy hop, as in production behind Vercel, so a test "comes from" the address the proxy would put last in X-Forwarded-For.
 * The rules themselves are in supabase/tests/organisation_security.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('5ec2');
let app: INestApplication;
let direct: INestApplication;
let admin: Pool;
const HQ = '203.0.113.10';
const HOME = '198.51.100.200';
const api = () => request(app.getHttpServer());
const as = async (user: string, from: string, org = ids.orgA) => ({
  Authorization: `Bearer ${await token(user)}`,
  'X-Organisation-Id': org,
  'X-Forwarded-For': from,
});

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-se2');
  app = await startApp({ TRUST_PROXY_HOPS: '1', RATE_LIMIT_PER_MINUTE: '10000' });
  direct = await startApp({ TRUST_PROXY_HOPS: '0', RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await Promise.all([app?.close(), direct?.close()]);
  await admin?.end();
});

describe('the address the API checks', () => {
  it('behind one proxy hop: the address the proxy added last, never one forged in front of it', async () => {
    const res = await api().get('/api/v1/security/access-policy').set(await as(ids.ownerA, `6.6.6.6, ${HQ}`)).expect(200);
    expect(res.body).toMatchObject({ mode: 'off', address: HQ, covered: false, networks: [] });
    const v6 = await api().get('/api/v1/security/access-policy').set(await as(ids.ownerA, '2001:DB8:1234::5')).expect(200);
    expect(v6.body.address).toBe('2001:db8:1234::5');
  });

  it('with no trusted hop: forwarding headers are ignored and the connection’s own address is used', async () => {
    const res = await request(direct.getHttpServer()).get('/api/v1/security/access-policy').set(await as(ids.ownerA, HQ)).expect(200);
    expect(res.body.address).toMatch(/^(127\.0\.0\.1|::1)$/);
  });
});

describe('managing the policy', () => {
  it('owners and admins only', async () => {
    await api().get('/api/v1/security/access-policy').set(await as(ids.inspectorA, HQ)).expect(403);
    await api().post('/api/v1/security/networks').set(await as(ids.inspectorA, HQ)).send({ name: 'x', network: HQ }).expect(403);
    await api().put('/api/v1/security/access-policy').set(await as(ids.dual, HQ)).send({ mode: 'monitor' }).expect(403);
  });

  it('approves networks, normalised, and refuses ones that could never match', async () => {
    const h = await as(ids.ownerA, HQ);
    const bad = await api().post('/api/v1/security/networks').set(h).send({ name: 'Office', network: '198.51.100.5/28' }).expect(409);
    expect(bad.body.error).toMatchObject({ code: 'security_rule', message: expect.stringMatching(/did you mean 198\.51\.100\.0\/28/) });
    const priv = await api().post('/api/v1/security/networks').set(h).send({ name: 'Office', network: '192.168.1.0/24' }).expect(409);
    expect(priv.body.error.message).toMatch(/private or special/);
    const res = await api().post('/api/v1/security/networks').set(h).send({ name: 'Headquarters', network: ` ${HQ} ` }).expect(201);
    expect(res.body.networks).toMatchObject([{ name: 'Headquarters', network: `${HQ}/32`, count: '1 address', single: true, active: true, includesYou: true, createdBy: 'Ada Owner' }]);
    expect(res.body).toMatchObject({ covered: true, activeCount: 1, canManage: true });
    const range = await api().post('/api/v1/security/networks').set(h).send({ name: 'Factory 2', network: '198.51.100.0/28' }).expect(201);
    expect(range.body.networks.find((n: { name: string }) => n.name === 'Factory 2')).toMatchObject({ count: '16 addresses', includesYou: false });
    await api().post('/api/v1/security/networks').set(h).send({ name: 'Company VPN', network: '2001:db8:1234::/48' }).expect(201);
  });

  it('monitor records who would be blocked, and blocks nobody', async () => {
    await api().put('/api/v1/security/access-policy').set(await as(ids.ownerA, HQ)).send({ mode: 'monitor' }).expect(200);
    await api().get('/api/v1/ncrs').set(await as(ids.inspectorA, HOME)).expect(200);
    const denials = (await api().get('/api/v1/security/access-denials').set(await as(ids.ownerA, HQ)).expect(200)).body.data;
    expect(denials).toMatchObject([{ address: HOME, mode: 'monitor', attempts: 1, lastPath: '/api/v1/ncrs', nowAllowed: false }]);
  });

  it('enforcing needs a confirmation and the caller’s own address in a network', async () => {
    await api().put('/api/v1/security/access-policy').set(await as(ids.ownerA, HQ)).send({ mode: 'enforce' }).expect(400);
    const outside = await api().put('/api/v1/security/access-policy').set(await as(ids.ownerA, HOME)).send({ mode: 'enforce', confirm: true }).expect(409);
    expect(outside.body.error.message).toMatch(/Your own address \(198\.51\.100\.200\) is not in an approved network/);
    const res = await api().put('/api/v1/security/access-policy').set(await as(ids.ownerA, HQ)).send({ mode: 'enforce', confirm: true }).expect(200);
    expect(res.body).toMatchObject({ mode: 'enforce', changedBy: 'Ada Owner' });
  });
});

describe('enforced', () => {
  it('blocks every organisation request from outside, with the address and a clear message; inside works', async () => {
    const outside = await api().get('/api/v1/ncrs').set(await as(ids.inspectorA, HOME)).expect(403);
    expect(outside.body.error).toMatchObject({ code: 'network_not_allowed', details: { address: HOME } });
    await api().get('/api/v1/ncrs').set(await as(ids.inspectorA, HQ)).expect(200);
    await api().get('/api/v1/ncrs').set(await as(ids.inspectorA, '198.51.100.15')).expect(200);
    await api().get('/api/v1/ncrs').set(await as(ids.inspectorA, '198.51.100.16')).expect(403);
    await api().get('/api/v1/ncrs').set(await as(ids.inspectorA, '2001:db8:1234:ffff::9')).expect(200);
    await api().get('/api/v1/ncrs').set(await as(ids.inspectorA, '::ffff:198.51.100.3')).expect(200);
    await api().post('/api/v1/ncrs').set(await as(ids.ownerA, HOME)).send({ source: 'internal', title: 'From home' }).expect(403);
  });

  it('a forged address in front of the proxy’s does not get in', async () => {
    await api().get('/api/v1/ncrs').set(await as(ids.inspectorA, `${HQ}, ${HOME}`)).expect(403);
  });

  it('the same session is blocked on its next request after moving networks', async () => {
    const t = await token(ids.inspectorA);
    const h = (from: string) => ({ Authorization: `Bearer ${t}`, 'X-Organisation-Id': ids.orgA, 'X-Forwarded-For': from });
    await api().get('/api/v1/home-dashboard').set(h(HQ)).expect(200);
    await api().get('/api/v1/home-dashboard').set(h(HOME)).expect(403);
  });

  it('only that organisation’s policy applies: someone in two organisations still uses the other one from anywhere', async () => {
    await api().get('/api/v1/ncrs').set(await as(ids.dual, HOME, ids.orgB)).expect(200);
    await api().get('/api/v1/ncrs').set(await as(ids.dual, HOME, ids.orgA)).expect(403);
    const me = (await api().get('/api/v1/me').set({ Authorization: `Bearer ${await token(ids.dual)}`, 'X-Forwarded-For': HOME }).expect(200)).body;
    const by = Object.fromEntries(me.memberships.map((m: { organisation: { id: string }; network: { state: string } }) => [m.organisation.id, m.network]));
    expect(by[ids.orgA]).toEqual({ state: 'denied', address: HOME });
    expect(by[ids.orgB]).toEqual({ state: 'open', address: HOME });
  });

  it('someone outside the organisation still gets 404, so the rule confirms nothing about it', async () => {
    await api().get('/api/v1/ncrs').set(await as(ids.ownerB, HOME, ids.orgA)).expect(404);
  });

  it('refuses a change that would lock the person making it out', async () => {
    const h = await as(ids.ownerA, HQ);
    const policy = (await api().get('/api/v1/security/access-policy').set(h).expect(200)).body;
    const hq = policy.networks.find((n: { name: string }) => n.name === 'Headquarters');
    const off = await api().patch(`/api/v1/security/networks/${hq.id}`).set(h).send({ active: false }).expect(409);
    expect(off.body.error.message).toMatch(/would block your own address \(203\.0\.113\.10\)/);
    await api().post(`/api/v1/security/networks/${hq.id}/remove`).set(h).send({ reason: 'Moving out' }).expect(409);
    // From the factory, headquarters can go.
    await api().patch(`/api/v1/security/networks/${hq.id}`).set(await as(ids.ownerA, '198.51.100.4')).send({ active: false }).expect(200);
    await api().get('/api/v1/ncrs').set(await as(ids.inspectorA, HQ)).expect(403);
    await api().patch(`/api/v1/security/networks/${hq.id}`).set(await as(ids.ownerA, '198.51.100.4')).send({ active: true }).expect(200);
  });

  it('lists the blocked attempts, counted per person, address and hour, and says when a network now covers one', async () => {
    const denials = (await api().get('/api/v1/security/access-denials?mode=enforce').set(await as(ids.ownerA, HQ)).expect(200)).body.data;
    const home = denials.find((d: { address: string; person: { id: string } | null }) => d.address === HOME && d.person?.id === ids.inspectorA);
    expect(home).toMatchObject({ mode: 'enforce', nowAllowed: false });
    expect(home.attempts).toBeGreaterThanOrEqual(3);
    await api().get('/api/v1/security/access-denials').set(await as(ids.inspectorA, HQ)).expect(403);
  });

  it('switching off opens every network again at once', async () => {
    await api().put('/api/v1/security/access-policy').set(await as(ids.ownerA, HQ)).send({ mode: 'off' }).expect(200);
    await api().get('/api/v1/ncrs').set(await as(ids.inspectorA, HOME)).expect(200);
  });
});
