/**
 * Phase 1.5: members, invitations, roles. Covers the exit criteria for access management:
 * invite -> accept -> role -> permission effective; suspended member loses access; no privilege
 * escalation; last Owner protected; other tenants invisible.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds(3);
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org?: string) => ({
  Authorization: `Bearer ${await token(user)}`,
  ...(org ? { 'X-Organisation-Id': org } : {}),
});

const NEW_PERSON = '30000000-0000-0000-0000-00000000aa01';
const ADMIN_PERSON = '30000000-0000-0000-0000-00000000aa02';
let roleIds: Record<string, string>;

const roleId = (key: string) => roleIds[key];
const memberByEmail = async (email: string) => {
  const res = await api().get('/api/v1/members').set(await as(ids.ownerA, ids.orgA)).expect(200);
  return res.body.data.find((m: { email: string }) => m.email === email);
};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-members');
  await admin.query(
    `insert into auth.users (id, email) values ($1, 'new.person@example.test'), ($2, 'admin.person@example.test') on conflict do nothing`,
    [NEW_PERSON, ADMIN_PERSON],
  );
  app = await startApp();
  const roles = await api().get('/api/v1/roles').set(await as(ids.ownerA, ids.orgA)).expect(200);
  roleIds = Object.fromEntries(roles.body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('directory, roles and permissions', () => {
  it('lists members with emails and roles for members.read holders', async () => {
    const res = await api().get('/api/v1/members').set(await as(ids.ownerA, ids.orgA)).expect(200);
    const owner = res.body.data.find((m: { userId: string }) => m.userId === ids.ownerA);
    expect(owner).toMatchObject({ email: `${ids.ownerA}@example.test`, status: 'active', roles: [expect.objectContaining({ roleKey: 'owner' })] });
    expect(res.body.data.map((m: { userId: string }) => m.userId)).not.toContain(ids.ownerB);
  });

  it('forbids the directory without members.read and hides other tenants', async () => {
    await api().get('/api/v1/members').set(await as(ids.inspectorA, ids.orgA)).expect(403);
    await api().get('/api/v1/members').set(await as(ids.ownerA, ids.orgB)).expect(404);
  });

  it('lists the six standard roles with their permissions and the permission catalogue', async () => {
    const roles = await api().get('/api/v1/roles').set(await as(ids.ownerA, ids.orgA)).expect(200);
    expect(roles.body.data.map((r: { key: string }) => r.key).sort()).toEqual(['admin', 'inspector', 'owner', 'quality_engineer', 'quality_manager', 'viewer']);
    expect(roles.body.data.find((r: { key: string }) => r.key === 'viewer').permissions).toEqual(['master_data.read', 'ncr.read']);
    const perms = await api().get('/api/v1/permissions').set(await as(ids.ownerA, ids.orgA)).expect(200);
    expect(perms.body.data).toContainEqual({ code: 'members.manage', description: expect.any(String) });
  });
});

describe('invite -> accept -> role -> permission', () => {
  it('invites by email with a role; no email is sent when the mailer is not configured', async () => {
    const res = await api()
      .post('/api/v1/members/invitations')
      .set(await as(ids.ownerA, ids.orgA))
      .send({ email: '  New.Person@Example.test ', roleId: roleId('quality_engineer') })
      .expect(201);
    expect(res.body.member).toMatchObject({ email: 'new.person@example.test', status: 'invited', userId: null, roles: [expect.objectContaining({ roleKey: 'quality_engineer' })] });
    expect(res.body.email).toEqual({ sent: false, reason: 'not_configured' });
  });

  it('refuses duplicates and existing members', async () => {
    const h = await as(ids.ownerA, ids.orgA);
    const dup = await api().post('/api/v1/members/invitations').set(h).send({ email: 'new.person@example.test', roleId: roleId('viewer') }).expect(409);
    expect(dup.body.error.code).toBe('already_invited');
    const member = await api().post('/api/v1/members/invitations').set(h).send({ email: `${ids.inspectorA}@example.test`, roleId: roleId('viewer') }).expect(409);
    expect(member.body.error.code).toBe('already_member');
  });

  it('rejects a role from another organisation without leaving a half-made invitation', async () => {
    const other = await api().get('/api/v1/roles').set(await as(ids.ownerB, ids.orgB)).expect(200);
    const foreignRole = other.body.data[0].id;
    const res = await api().post('/api/v1/members/invitations').set(await as(ids.ownerA, ids.orgA)).send({ email: 'stray@example.test', roleId: foreignRole }).expect(400);
    expect(res.body.error.code).toBe('invalid_reference');
    expect(await memberByEmail('stray@example.test')).toBeUndefined();
  });

  it('requires members.manage to invite', async () => {
    await api().post('/api/v1/members/invitations').set(await as(ids.inspectorA, ids.orgA)).send({ email: 'x@example.test', roleId: roleId('viewer') }).expect(403);
    await api().post('/api/v1/members/invitations').set(await as(ids.ownerA, ids.orgA)).send({ email: 'not-an-email', roleId: roleId('viewer') }).expect(400);
  });

  it('shows the invitation only to the invited person, who accepts it and gains the role’s permissions', async () => {
    const others = await api().get('/api/v1/invitations').set(await as(ids.outsider)).expect(200);
    expect(others.body.data).toEqual([]);

    const mine = await api().get('/api/v1/invitations').set(await as(NEW_PERSON)).expect(200);
    expect(mine.body.data).toEqual([expect.objectContaining({ organisationId: ids.orgA, organisationName: 'Alpha Precision' })]);

    await api().post(`/api/v1/invitations/${mine.body.data[0].membershipId}/accept`).set(await as(ids.outsider)).expect(404);
    const accepted = await api().post(`/api/v1/invitations/${mine.body.data[0].membershipId}/accept`).set(await as(NEW_PERSON)).expect(200);
    expect(accepted.body).toEqual({ organisationId: ids.orgA });

    const me = await api().get('/api/v1/me').set(await as(NEW_PERSON)).expect(200);
    expect(me.body.memberships).toEqual([
      expect.objectContaining({ organisation: expect.objectContaining({ id: ids.orgA }), permissions: expect.arrayContaining(['ncr.update', 'members.read']) }),
    ]);
    await api().get('/api/v1/organisations/current').set(await as(NEW_PERSON, ids.orgA)).expect(200);
    await api().post(`/api/v1/invitations/${mine.body.data[0].membershipId}/accept`).set(await as(NEW_PERSON)).expect(404);
  });

  it('lets an owner revoke a pending invitation', async () => {
    const h = await as(ids.ownerA, ids.orgA);
    const created = await api().post('/api/v1/members/invitations').set(h).send({ email: 'revoke.me@example.test', roleId: roleId('viewer') }).expect(201);
    const revoked = await api().patch(`/api/v1/members/${created.body.member.membershipId}`).set(h).send({ status: 'removed' }).expect(200);
    expect(revoked.body.status).toBe('removed');
  });
});

describe('managing members without escalation', () => {
  let adminMembership: string;

  beforeAll(async () => {
    const created = await api()
      .post('/api/v1/members/invitations')
      .set(await as(ids.ownerA, ids.orgA))
      .send({ email: 'admin.person@example.test', roleId: roleId('admin') })
      .expect(201);
    adminMembership = created.body.member.membershipId;
    await api().post(`/api/v1/invitations/${adminMembership}/accept`).set(await as(ADMIN_PERSON)).expect(200);
  });

  it('an admin cannot grant Owner to themselves or anyone else', async () => {
    const h = await as(ADMIN_PERSON, ids.orgA);
    await api().post(`/api/v1/members/${adminMembership}/role-assignments`).set(h).send({ roleId: roleId('owner') }).expect(403);
    const inspector = await memberByEmail(`${ids.inspectorA}@example.test`);
    await api().post(`/api/v1/members/${inspector.membershipId}/role-assignments`).set(h).send({ roleId: roleId('owner') }).expect(403);
  });

  it('an admin can grant roles they fully hold, scoped to a site, once', async () => {
    const h = await as(ADMIN_PERSON, ids.orgA);
    const inspector = await memberByEmail(`${ids.inspectorA}@example.test`);
    const res = await api()
      .post(`/api/v1/members/${inspector.membershipId}/role-assignments`)
      .set(h)
      .send({ roleId: roleId('quality_engineer'), siteId: ids.siteA })
      .expect(201);
    expect(res.body.roles).toContainEqual(expect.objectContaining({ roleKey: 'quality_engineer', siteId: ids.siteA }));
    const dup = await api().post(`/api/v1/members/${inspector.membershipId}/role-assignments`).set(h).send({ roleId: roleId('quality_engineer'), siteId: ids.siteA }).expect(409);
    expect(dup.body.error.message).toBe('This member already has that role');
  });

  it('an admin cannot suspend the owner or themselves', async () => {
    const h = await as(ADMIN_PERSON, ids.orgA);
    const owner = await memberByEmail(`${ids.ownerA}@example.test`);
    await api().patch(`/api/v1/members/${owner.membershipId}`).set(h).send({ status: 'suspended' }).expect(403);
    await api().patch(`/api/v1/members/${adminMembership}`).set(h).send({ status: 'suspended' }).expect(403);
  });

  it('a suspended member loses access and regains it when reactivated', async () => {
    const h = await as(ADMIN_PERSON, ids.orgA);
    const inspector = await memberByEmail(`${ids.inspectorA}@example.test`);
    await api().patch(`/api/v1/members/${inspector.membershipId}`).set(h).send({ status: 'suspended' }).expect(200);
    await api().get('/api/v1/organisations/current').set(await as(ids.inspectorA, ids.orgA)).expect(404);
    await api().patch(`/api/v1/members/${inspector.membershipId}`).set(h).send({ status: 'active' }).expect(200);
    await api().get('/api/v1/organisations/current').set(await as(ids.inspectorA, ids.orgA)).expect(200);
  });

  it('refuses invalid status changes', async () => {
    const h = await as(ids.ownerA, ids.orgA);
    const revoked = await memberByEmail('revoke.me@example.test');
    const res = await api().patch(`/api/v1/members/${revoked.membershipId}`).set(h).send({ status: 'active' }).expect(409);
    expect(res.body.error.code).toBe('invalid_transition');
    await api().patch(`/api/v1/members/${revoked.membershipId}`).set(h).send({ status: 'invited' }).expect(400);
  });

  it('answers 404 for another tenant’s members', async () => {
    const { rows } = await admin.query('select id from public.organisation_users where organisation_id = $1 limit 1', [ids.orgB]);
    await api().patch(`/api/v1/members/${rows[0].id}`).set(await as(ids.ownerA, ids.orgA)).send({ status: 'suspended' }).expect(404);
  });
});

describe('last Owner', () => {
  it('cannot remove the only Owner role', async () => {
    const owner = await memberByEmail(`${ids.ownerA}@example.test`);
    const assignment = owner.roles.find((r: { roleKey: string }) => r.roleKey === 'owner');
    const res = await api().delete(`/api/v1/role-assignments/${assignment.assignmentId}`).set(await as(ids.ownerA, ids.orgA)).expect(409);
    expect(res.body.error.code).toBe('last_owner');
  });

  it('can remove it once someone else is also an Owner', async () => {
    const h = await as(ids.ownerA, ids.orgA);
    const newPerson = await memberByEmail('new.person@example.test');
    await api().post(`/api/v1/members/${newPerson.membershipId}/role-assignments`).set(h).send({ roleId: roleId('owner') }).expect(201);
    const owner = await memberByEmail(`${ids.ownerA}@example.test`);
    const assignment = owner.roles.find((r: { roleKey: string }) => r.roleKey === 'owner');
    await api().delete(`/api/v1/role-assignments/${assignment.assignmentId}`).set(h).expect(204);
  });
});
