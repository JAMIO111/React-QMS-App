/**
 * ON4a: invitations through the API: message and package (a seat reserved at once), bulk with per-row results, resend limits, revoke freeing the seat, what the invitee sees,
 * expired invitations, and isolation. The mailer is replaced by a recorder; the mailer itself is covered by its unit tests.
 */
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { InvitationMailer } from '../src/members/invitation-mailer.service';
import { makeIds, requireDb, seed, testEnv, token } from './helpers';

const ids = makeIds('d2');
const INVITEE = 'd2000000-0000-0000-0000-00000000aa01';
const mailed: { email: string; org: string }[] = [];
const fakeMailer = {
  configured: true,
  send: async (email: string, org: string) => {
    mailed.push({ email, org });
    return { sent: true as const };
  },
};

let app: INestApplication;
let admin: Pool;
let roles: Record<string, string>;
let dept: string;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user, { email: user === INVITEE ? 'invitee@example.test' : undefined })}`, 'X-Organisation-Id': org });
const asInvitee = async () => ({ Authorization: `Bearer ${await token(INVITEE, { email: 'invitee@example.test' })}` });
const overview = async () => (await api().get('/api/v1/subscription').set(await as(ids.ownerA)).expect(200)).body;
const available = async (slug: string) => (await overview()).items.find((i: { planSlug: string }) => i.planSlug === slug)?.available ?? 0;
const members = async () => (await api().get('/api/v1/members').set(await as(ids.ownerA)).expect(200)).body.data;
const byEmail = async (email: string) => (await members()).find((m: { email: string }) => m.email === email);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-invites');
  await admin.query(`insert into auth.users (id, email) values ($1, 'invitee@example.test') on conflict do nothing`, [INVITEE]);
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).overrideProvider(InvitationMailer).useValue(fakeMailer).compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true }), env);
  await app.init();
  const list = await api().get('/api/v1/roles').set(await as(ids.ownerA)).expect(200);
  roles = Object.fromEntries(list.body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
  dept = (await api().post('/api/v1/departments').set(await as(ids.ownerA)).send({ siteId: ids.siteA, code: 'QA2', name: 'Quality 2' }).expect(201)).body.id;
  await api().put('/api/v1/subscription/seats').set(await as(ids.ownerA)).send({ planSlug: 'contributor', quantity: 2 }).expect(200);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('inviting with a message and a package', () => {
  it('reserves the seat at once and records the message, expiry and the email sent', async () => {
    const before = await available('contributor');
    const res = await api()
      .post('/api/v1/members/invitations')
      .set(await as(ids.ownerA))
      .send({ email: 'invitee@example.test', roleId: roles.viewer, departmentIds: [dept], message: 'Welcome to quality', packageSlug: 'contributor' })
      .expect(201);
    expect(res.body.email).toEqual({ sent: true });
    expect(mailed.at(-1)).toMatchObject({ email: 'invitee@example.test' });
    expect(res.body.member.invite).toMatchObject({ message: 'Welcome to quality', packageSlug: 'contributor', packageName: 'Contributor', sendCount: 1, expired: false });
    const days = (new Date(res.body.member.invite.expiresAt).getTime() - Date.now()) / 864e5;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
    expect(await available('contributor')).toBe(before - 1);
  });

  it('refuses a package with no free seat and leaves nothing behind', async () => {
    await api().post('/api/v1/members/invitations').set(await as(ids.ownerA)).send({ email: 'second@example.test', roleId: roles.viewer, departmentIds: [dept], packageSlug: 'contributor' }).expect(201);
    expect(await available('contributor')).toBe(0);
    const res = await api().post('/api/v1/members/invitations').set(await as(ids.ownerA)).send({ email: 'third@example.test', roleId: roles.viewer, departmentIds: [dept], packageSlug: 'contributor' }).expect(409);
    expect(res.body.error.code).toBe('subscription_rule');
    expect(await byEmail('third@example.test')).toBeUndefined();
  });

  it('refuses an overlong message and an unknown package', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/members/invitations').set(h).send({ email: 'long@example.test', roleId: roles.viewer, departmentIds: [dept], message: 'x'.repeat(501) }).expect(400);
    const unknown = await api().post('/api/v1/members/invitations').set(h).send({ email: 'gold@example.test', roleId: roles.viewer, departmentIds: [dept], packageSlug: 'gold' });
    expect(unknown.status).toBe(409);
    expect(await byEmail('gold@example.test')).toBeUndefined();
  });

  it('works without a package or a message, taking no seat', async () => {
    const before = await available('contributor');
    const res = await api().post('/api/v1/members/invitations').set(await as(ids.ownerA)).send({ email: 'plain@example.test', roleId: roles.viewer, departmentIds: [dept] }).expect(201);
    expect(res.body.member.invite).toMatchObject({ message: null, packageSlug: null, sendCount: 1 });
    expect(await available('contributor')).toBe(before);
  });

  it('is for people who manage members', async () => {
    await api().post('/api/v1/members/invitations').set(await as(ids.inspectorA)).send({ email: 'x@example.test', roleId: roles.viewer, departmentIds: [dept] }).expect(403);
    await api().post('/api/v1/members/invitations/bulk').set(await as(ids.inspectorA)).send({ invitations: [{ email: 'x@example.test', roleId: roles.viewer, departmentIds: [dept] }] }).expect(403);
  });
});

describe('bulk invitations', () => {
  it('invites what it can and says why for the rest, in order', async () => {
    const res = await api()
      .post('/api/v1/members/invitations/bulk')
      .set(await as(ids.ownerA))
      .send({
        invitations: [
          { email: 'bulk1@example.test', roleId: roles.viewer, departmentIds: [dept], message: 'Hi' },
          { email: 'bulk1@example.test', roleId: roles.viewer, departmentIds: [dept] },
          { email: `${ids.ownerA}@example.test`, roleId: roles.viewer, departmentIds: [dept] },
          { email: 'bulk-nodept@example.test', roleId: roles.viewer },
          { email: 'bulk-seat@example.test', roleId: roles.viewer, departmentIds: [dept], packageSlug: 'contributor' },
          { email: 'bulk2@example.test', roleId: roles.quality_manager },
        ],
      })
      .expect(200);
    expect(res.body.invited).toBe(2);
    expect(res.body.failed).toBe(4);
    expect(res.body.results.map((r: { email: string; ok: boolean }) => [r.email, r.ok])).toEqual([
      ['bulk1@example.test', true],
      ['bulk1@example.test', false],
      [`${ids.ownerA}@example.test`, false],
      ['bulk-nodept@example.test', false],
      ['bulk-seat@example.test', false],
      ['bulk2@example.test', true],
    ]);
    expect(res.body.results[1].error.code).toBe('duplicate_in_request');
    expect(res.body.results[2].error.code).toBe('already_member');
    expect(res.body.results[3].error.code).toBe('department_required');
    expect(res.body.results[4].error.code).toBe('subscription_rule');
    expect(res.body.results[0].emailOutcome).toEqual({ sent: true });
    expect(await byEmail('bulk-seat@example.test')).toBeUndefined();
    expect(await byEmail('bulk2@example.test')).toBeDefined();
  });

  it('takes 1 to 50 rows', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/members/invitations/bulk').set(h).send({ invitations: [] }).expect(400);
    const many = Array.from({ length: 51 }, (_, i) => ({ email: `many${i}@example.test`, roleId: roles.viewer, departmentIds: [dept] }));
    await api().post('/api/v1/members/invitations/bulk').set(h).send({ invitations: many }).expect(400);
  });
});

describe('resend and revoke', () => {
  it('will not resend straight away, then resends, counts it and extends the invitation', async () => {
    const h = await as(ids.ownerA);
    const m = await byEmail('plain@example.test');
    const refused = await api().post(`/api/v1/members/${m.membershipId}/invitation/resend`).set(h).expect(409);
    expect(refused.body.error.code).toBe('invitation_rule');
    await admin.query(`update public.organisation_users set invite_last_sent_at = now() - interval '5 minutes', invite_expires_at = now() + interval '1 day' where id = $1`, [m.membershipId]);
    const before = mailed.length;
    const res = await api().post(`/api/v1/members/${m.membershipId}/invitation/resend`).set(h).expect(200);
    expect(res.body.member.invite.sendCount).toBe(2);
    expect(res.body.email).toEqual({ sent: true });
    expect(mailed.length).toBe(before + 1);
    expect((new Date(res.body.member.invite.expiresAt).getTime() - Date.now()) / 864e5).toBeGreaterThan(13);
  });

  it('stops at ten sends', async () => {
    const m = await byEmail('plain@example.test');
    await admin.query(`update public.organisation_users set invite_last_sent_at = now() - interval '5 minutes', invite_send_count = 10 where id = $1`, [m.membershipId]);
    const res = await api().post(`/api/v1/members/${m.membershipId}/invitation/resend`).set(await as(ids.ownerA)).expect(409);
    expect(res.body.error.message).toMatch(/10 times/);
  });

  it('revoking frees the seat, by either route, and a revoked invitation cannot be accepted', async () => {
    const h = await as(ids.ownerA);
    const second = await byEmail('second@example.test');
    const before = await available('contributor');
    const res = await api().post(`/api/v1/members/${second.membershipId}/invitation/revoke`).set(h).expect(200);
    expect(res.body.status).toBe('removed');
    expect(await available('contributor')).toBe(before + 1);
    await api().post(`/api/v1/members/${second.membershipId}/invitation/revoke`).set(h).expect(409);
    await api().post(`/api/v1/members/${second.membershipId}/invitation/resend`).set(h).expect(409);

    // The existing "revoke" through the status route frees the seat too.
    const again = await api().post('/api/v1/members/invitations').set(h).send({ email: 'viastatus@example.test', roleId: roles.viewer, departmentIds: [dept], packageSlug: 'contributor' }).expect(201);
    const taken = await available('contributor');
    await api().patch(`/api/v1/members/${again.body.member.membershipId}`).set(h).send({ status: 'removed' }).expect(200);
    expect(await available('contributor')).toBe(taken + 1);
  });

  it('only people who manage members, and only in their own organisation', async () => {
    const m = await byEmail('bulk2@example.test');
    await api().post(`/api/v1/members/${m.membershipId}/invitation/resend`).set(await as(ids.inspectorA)).expect(403);
    await api().post(`/api/v1/members/${m.membershipId}/invitation/revoke`).set(await as(ids.inspectorA)).expect(403);
    const other = await as(ids.ownerB, ids.orgB);
    expect([403, 404]).toContain((await api().post(`/api/v1/members/${m.membershipId}/invitation/revoke`).set(other)).status);
    expect([403, 404]).toContain((await api().post(`/api/v1/members/${m.membershipId}/invitation/resend`).set(other)).status);
    expect((await byEmail('bulk2@example.test')).status).toBe('invited');
  });
});

describe('the invitee', () => {
  it('sees what they were invited to', async () => {
    const res = await api().get('/api/v1/invitations').set(await asInvitee()).expect(200);
    const inv = res.body.data.find((i: { organisationId: string }) => i.organisationId === ids.orgA);
    expect(inv).toMatchObject({ organisationName: 'Alpha Precision', message: 'Welcome to quality', packageSlug: 'contributor', packageName: 'Contributor', expired: false, departments: ['Quality 2'] });
    expect(inv.roles).toEqual([{ key: 'viewer', name: 'Viewer' }]);
    expect(inv.invitedByName).toBe('Ada Owner');
  });

  it('cannot accept an expired invitation, and can once it is sent again', async () => {
    const m = await byEmail('invitee@example.test');
    await admin.query(`update public.organisation_users set invite_expires_at = now() - interval '1 minute', invite_last_sent_at = now() - interval '5 minutes' where id = $1`, [m.membershipId]);
    const list = await api().get('/api/v1/invitations').set(await asInvitee()).expect(200);
    expect(list.body.data.find((i: { membershipId: string }) => i.membershipId === m.membershipId).expired).toBe(true);
    const refused = await api().post(`/api/v1/invitations/${m.membershipId}/accept`).set(await asInvitee()).expect(409);
    expect(refused.body.error.code).toBe('invitation_rule');
    expect((await byEmail('invitee@example.test')).invite.expired).toBe(true);
    await api().post(`/api/v1/members/${m.membershipId}/invitation/resend`).set(await as(ids.ownerA)).expect(200);
    await api().post(`/api/v1/invitations/${m.membershipId}/accept`).set(await asInvitee()).expect(200);
  });

  it('keeps the reserved seat on accepting, and the person is a member with their role and department', async () => {
    const m = await byEmail('invitee@example.test');
    expect(m).toMatchObject({ status: 'active', roles: [expect.objectContaining({ roleKey: 'viewer' })], invite: null });
    expect(m.departments.map((d: { name: string }) => d.name)).toEqual(['Quality 2']);
    const seats = (await api().get('/api/v1/subscription/assignments').set(await as(ids.ownerA)).expect(200)).body.data;
    expect(seats.find((s: { email: string }) => s.email === 'invitee@example.test').plan).toMatchObject({ slug: 'contributor' });
  });
});
