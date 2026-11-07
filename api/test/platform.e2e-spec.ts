/**
 * ON1: the operator area through the API. Not organisation-scoped; open only to people on the platform allow-list whose session passed MFA.
 * Everyone else is told nothing (404), an operator without MFA is told what to do (403 mfa_required), and the funnel is correct.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('c9');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, claims: Record<string, unknown> = {}) => ({ Authorization: `Bearer ${await token(user, claims)}` });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-platform');
  // The "outsider" (no organisation) is the operator.
  await admin.query(`insert into public.platform_admins (user_id, note) values ($1, 'e2e operator') on conflict do nothing`, [ids.outsider]);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('the platform area', () => {
  it('needs a signed-in user', async () => {
    await api().get('/api/v1/platform/me').expect(401);
    await api().get('/api/v1/platform/overview').expect(401);
  });

  it('tells a normal user nothing', async () => {
    expect((await api().get('/api/v1/platform/me').set(await as(ids.ownerA, { aal: 'aal2' })).expect(200)).body).toEqual({ status: 'none' });
    const res = await api().get('/api/v1/platform/overview').set(await as(ids.ownerA, { aal: 'aal2' })).expect(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('asks an operator whose session has not passed MFA to do so', async () => {
    expect((await api().get('/api/v1/platform/me').set(await as(ids.outsider)).expect(200)).body).toEqual({ status: 'needs_mfa' });
    expect((await api().get('/api/v1/platform/me').set(await as(ids.outsider, { aal: 'aal1' })).expect(200)).body).toEqual({ status: 'needs_mfa' });
    const res = await api().get('/api/v1/platform/overview').set(await as(ids.outsider, { aal: 'aal1' })).expect(403);
    expect(res.body.error.code).toBe('mfa_required');
  });

  it('shows an operator with MFA the funnel and the latest sign-ups', async () => {
    const mfa = await as(ids.outsider, { aal: 'aal2' });
    expect((await api().get('/api/v1/platform/me').set(mfa).expect(200)).body).toEqual({ status: 'ok' });
    // Every suite adds people to one shared database, so "the latest 25" is only deterministic if this suite's person is the latest.
    await admin.query(`update public.signup_events set occurred_at = now() + interval '1 minute' where user_id = $1 and event = 'signed_up'`, [ids.ownerA]);
    const { body } = await api().get('/api/v1/platform/overview').set(mfa).expect(200);
    expect(body.funnel).toMatchObject({ days: 30, signedUp: expect.any(Number), verified: expect.any(Number), orgStarted: expect.any(Number), totalAccounts: expect.any(Number), totalOrganisations: expect.any(Number) });
    expect(body.funnel.signedUp).toBeGreaterThanOrEqual(6); // the seeded people signed themselves up (self)
    expect(body.funnel.totalOrganisations).toBeGreaterThanOrEqual(2);
    expect(body.funnel.verified).toBeLessThanOrEqual(body.funnel.signedUp);
    expect(body.recentSignups.length).toBeGreaterThan(0);
    expect(body.recentSignups[0]).toMatchObject({ userId: expect.any(String), signedUpAt: expect.any(String) });
    const ada = body.recentSignups.find((r: { userId: string }) => r.userId === ids.ownerA);
    expect(ada).toMatchObject({ name: 'Ada Owner', email: `${ids.ownerA}@example.test` });
  });

  it('takes a period, and refuses one that makes no sense', async () => {
    const mfa = await as(ids.outsider, { aal: 'aal2' });
    expect((await api().get('/api/v1/platform/overview?days=7').set(mfa).expect(200)).body.funnel.days).toBe(7);
    await api().get('/api/v1/platform/overview?days=0').set(mfa).expect(400);
    await api().get('/api/v1/platform/overview?days=400').set(mfa).expect(400);
    await api().get('/api/v1/platform/overview?days=abc').set(mfa).expect(400);
  });

  it('a platform operator does not become a member of any organisation by being one', async () => {
    const mfa = await as(ids.outsider, { aal: 'aal2' });
    await api().get('/api/v1/members').set({ ...mfa, 'X-Organisation-Id': ids.orgA }).expect(404);
  });
});
