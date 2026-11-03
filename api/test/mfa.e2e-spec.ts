/**
 * Phase 2.0: organisations can require two-factor authentication. A member whose token has not
 * passed MFA (aal1) gets 403 mfa_required for that organisation, is told about it by /me, and
 * keeps access to organisations that do not require it. The requirement cannot be switched on
 * from an aal1 session.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds(5);
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org?: string, aal: 'aal1' | 'aal2' = 'aal1') => ({
  Authorization: `Bearer ${await token(user, { aal })}`,
  ...(org ? { 'X-Organisation-Id': org } : {}),
});

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-mfa');
  app = await startApp();
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('requiring two-factor authentication', () => {
  it('cannot be switched on from a password-only session', async () => {
    const res = await api()
      .patch('/api/v1/organisations/current')
      .set(await as(ids.ownerA, ids.orgA, 'aal1'))
      .send({ settings: { requireMfa: true } })
      .expect(409);
    expect(res.body.error.code).toBe('mfa_setup_required');
  });

  it('is switched on by an owner who has passed MFA', async () => {
    const res = await api()
      .patch('/api/v1/organisations/current')
      .set(await as(ids.ownerA, ids.orgA, 'aal2'))
      .send({ settings: { requireMfa: true } })
      .expect(200);
    expect(res.body.settings.requireMfa).toBe(true);
  });

  it('blocks password-only sessions with a clear error', async () => {
    const res = await api().get('/api/v1/organisations/current').set(await as(ids.inspectorA, ids.orgA, 'aal1')).expect(403);
    expect(res.body.error.code).toBe('mfa_required');
    await api().get('/api/v1/sites').set(await as(ids.ownerA, ids.orgA, 'aal1')).expect(403);
  });

  it('lets sessions that passed MFA in', async () => {
    await api().get('/api/v1/organisations/current').set(await as(ids.inspectorA, ids.orgA, 'aal2')).expect(200);
    await api().get('/api/v1/sites').set(await as(ids.ownerA, ids.orgA, 'aal2')).expect(200);
  });

  it('tells the user which organisations need MFA in /me', async () => {
    const blocked = await api().get('/api/v1/me').set(await as(ids.dual, undefined, 'aal1')).expect(200);
    expect(blocked.body.mfa.level).toBe('aal1');
    expect(blocked.body.mfa.requiredBy.map((o: { id: string }) => o.id)).toEqual([ids.orgA]);
    // The other organisation (no requirement) stays usable.
    expect(blocked.body.memberships.map((m: { organisation: { id: string } }) => m.organisation.id)).toEqual([ids.orgB]);

    const passed = await api().get('/api/v1/me').set(await as(ids.dual, undefined, 'aal2')).expect(200);
    expect(passed.body.mfa).toEqual({ level: 'aal2', requiredBy: [] });
    expect(passed.body.memberships).toHaveLength(2);
  });

  it('does not affect organisations that do not require it', async () => {
    await api().get('/api/v1/organisations/current').set(await as(ids.ownerB, ids.orgB, 'aal1')).expect(200);
    await api().get('/api/v1/organisations/current').set(await as(ids.dual, ids.orgB, 'aal1')).expect(200);
  });

  it('still answers 404 to outsiders, not mfa_required', async () => {
    const res = await api().get('/api/v1/organisations/current').set(await as(ids.outsider, ids.orgA, 'aal1')).expect(404);
    expect(res.body.error.code).toBe('organisation_not_found');
  });

  it('can be switched off again by an owner who passed MFA', async () => {
    await api()
      .patch('/api/v1/organisations/current')
      .set(await as(ids.ownerA, ids.orgA, 'aal2'))
      .send({ settings: { requireMfa: false } })
      .expect(200);
    await api().get('/api/v1/organisations/current').set(await as(ids.inspectorA, ids.orgA, 'aal1')).expect(200);
  });
});
