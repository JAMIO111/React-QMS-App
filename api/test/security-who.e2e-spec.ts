/**
 * The "who" rules (docs/security-plan.md SE6): invitations only to the organisation's email domains (one at a time and in bulk; members already outside
 * listed, not removed), and a maximum session age checked on every organisation request from the sign-in time in the token (amr). The rules are in
 * supabase/tests/security_who_rules.test.sql; signedInAt / sessionTooOld have unit tests too.
 */
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { InvitationMailer } from '../src/members/invitation-mailer.service';
import { hoursWords, sessionTooOld, signedInAt } from '../src/tenancy/organisation.guard';
import { makeIds, requireDb, seed, testEnv, token } from './helpers';

const ids = makeIds('5ec6');
const fakeMailer = { configured: true, send: async () => ({ sent: true as const }) };
let app: INestApplication;
let admin: Pool;
let roles: Record<string, string>;
const now = () => Math.floor(Date.now() / 1000);
const signedIn = (hoursAgo: number) => ({ amr: [{ method: 'password', timestamp: now() - Math.round(hoursAgo * 3600) }] });
const api = () => request(app.getHttpServer());
const as = async (user: string, claims: Record<string, unknown> = signedIn(0.1)) => ({
  Authorization: `Bearer ${await token(user, claims)}`,
  'X-Organisation-Id': ids.orgA,
});

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-se6');
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).overrideProvider(InvitationMailer).useValue(fakeMailer).compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true }), env);
  await app.init();
  const list = await api().get('/api/v1/roles').set(await as(ids.ownerA)).expect(200);
  roles = Object.fromEntries(list.body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('the sign-in time in the token', () => {
  it('is the newest amr entry; missing or unreadable means it cannot be known', () => {
    expect(signedInAt({ amr: [{ method: 'password', timestamp: 100 }, { method: 'totp', timestamp: 250 }] })).toBe(250);
    expect(signedInAt({ amr: 'pwd' })).toBeNull();
    expect(signedInAt({})).toBeNull();
    expect(sessionTooOld({ amr: [{ timestamp: 1000 }] }, 1, 1000 + 3599)).toBe(false);
    expect(sessionTooOld({ amr: [{ timestamp: 1000 }] }, 1, 1000 + 3601)).toBe(true);
    expect(sessionTooOld({}, 720)).toBe(true);
    expect(hoursWords(8)).toBe('8 hours');
    expect(hoursWords(24)).toBe('1 day');
    expect(hoursWords(168)).toBe('7 days');
  });
});

describe('allowed email domains', () => {
  it('owners and admins only', async () => {
    await api().put('/api/v1/security/email-domains').set(await as(ids.inspectorA)).send({ domains: ['alpha.test'] }).expect(403);
  });

  it('are normalised, and a typo is refused with the reason', async () => {
    const bad = await api().put('/api/v1/security/email-domains').set(await as(ids.ownerA)).send({ domains: ['alpha precision'] }).expect(409);
    expect(bad.body.error).toMatchObject({ code: 'security_rule', message: expect.stringMatching(/is not an email domain/) });
    const res = await api().put('/api/v1/security/email-domains').set(await as(ids.ownerA)).send({ domains: ['@Alpha.test', 'alpha.test', 'alpha-group.test'] }).expect(200);
    expect(res.body.allowedEmailDomains).toEqual(['alpha.test', 'alpha-group.test']);
  });

  it('limit invitations, one at a time and in bulk; members already outside are listed', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/members/invitations').set(h).send({ email: 'new@alpha.test', roleId: roles.quality_manager }).expect(201);
    const refused = await api().post('/api/v1/members/invitations').set(h).send({ email: 'friend@gmail.test', roleId: roles.quality_manager }).expect(409);
    expect(refused.body.error).toMatchObject({ code: 'invitation_rule', message: 'This organisation only invites addresses at alpha.test, alpha-group.test' });
    const bulk = await api().post('/api/v1/members/invitations/bulk').set(h)
      .send({ invitations: [{ email: 'a@uk.alpha.test', roleId: roles.quality_manager }, { email: 'b@gmail.test', roleId: roles.quality_manager }] });
    expect(bulk.status).toBeLessThan(300);
    const results = bulk.body.results ?? bulk.body.data;
    expect(results.map((r: { ok?: boolean; status?: string }) => r.ok ?? r.status === 'invited')).toEqual([true, false]);
    const policy = (await api().get('/api/v1/security/access-policy').set(h).expect(200)).body;
    // The seeded members' addresses are not at alpha.test, so they are listed — and they stay members.
    expect(policy.outsideDomains.length).toBeGreaterThan(0);
    expect(policy.outsideDomains.every((m: { status: string }) => ['active', 'invited'].includes(m.status))).toBe(true);
    await api().get('/api/v1/ncrs').set(await as(ids.inspectorA)).expect(200);
  });
});

describe('maximum session age', () => {
  it('is set by owners and admins, between an hour and 30 days', async () => {
    await api().put('/api/v1/security/session-age').set(await as(ids.inspectorA)).send({ hours: 8 }).expect(403);
    await api().put('/api/v1/security/session-age').set(await as(ids.ownerA)).send({ hours: 0 }).expect(400);
    const res = await api().put('/api/v1/security/session-age').set(await as(ids.ownerA)).send({ hours: 12 }).expect(200);
    expect(res.body.maxSessionHours).toBe(12);
  });

  it('asks someone who signed in too long ago to sign in again, on every organisation request', async () => {
    await api().get('/api/v1/ncrs').set(await as(ids.inspectorA, signedIn(11))).expect(200);
    const old = await api().get('/api/v1/ncrs').set(await as(ids.inspectorA, signedIn(13))).expect(401);
    expect(old.body.error).toMatchObject({ code: 'reauthentication_required', message: expect.stringMatching(/every 12 hours/), details: { maxSessionHours: 12 } });
    const unknown = await api().get('/api/v1/ncrs').set(await as(ids.inspectorA, {})).expect(401);
    expect(unknown.body.error.code).toBe('reauthentication_required');
  });

  it('does not touch another organisation, or a non-member (still 404)', async () => {
    const other = { Authorization: `Bearer ${await token(ids.ownerB, signedIn(100))}`, 'X-Organisation-Id': ids.orgB };
    await api().get('/api/v1/ncrs').set(other).expect(200);
    const outsider = { Authorization: `Bearer ${await token(ids.outsider, signedIn(100))}`, 'X-Organisation-Id': ids.orgA };
    await api().get('/api/v1/ncrs').set(outsider).expect(404);
  });

  it('no limit again', async () => {
    await api().put('/api/v1/security/session-age').set(await as(ids.ownerA)).send({ hours: null }).expect(200);
    await api().get('/api/v1/ncrs').set(await as(ids.inspectorA, {})).expect(200);
  });
});
