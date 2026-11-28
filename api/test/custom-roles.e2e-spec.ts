/**
 * Custom roles (docs/custom-roles-plan.md RL2): an Owner makes, changes and deletes their own roles; what a role may carry; built-in roles are
 * fixed; a role someone holds cannot be deleted; a change takes effect for its holders; saves from an old screen are asked about; another
 * organisation sees none of it.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('cd01');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org: string = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });

const LIMITED = 'cd010000-0000-0000-0000-00000000aa01';
let limitedMembership: string;
let inspectorMembership: string;

const roles = async (user = ids.ownerA, org = ids.orgA) => (await api().get('/api/v1/roles').set(await as(user, org)).expect(200)).body.data as Array<{
  id: string; key: string; name: string; description: string | null; isSystem: boolean; permissions: string[]; holders: number; rowVersion?: string;
}>;
const roleNamed = async (name: string) => (await roles()).find((r) => r.name === name);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-roles');
  await admin.query(`insert into auth.users (id, email) values ($1, 'limited.manager@example.test') on conflict do nothing`, [LIMITED]);
  inspectorMembership = (await admin.query('select id from public.organisation_users where organisation_id = $1 and user_id = $2', [ids.orgA, ids.inspectorA])).rows[0].id;
  // Someone who may manage roles but holds only ncr.read: not makeable through the app (a custom role cannot carry roles.manage), so built with the triggers off.
  const client = await admin.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    const role = (await client.query(`insert into public.roles (organisation_id, key, name, is_system) values ($1, 'custom_limited_manager', 'Limited manager', false) returning id`, [ids.orgA])).rows[0].id;
    await client.query(`insert into public.role_permissions (role_id, permission_code) values ($1, 'roles.manage'), ($1, 'ncr.read')`, [role]);
    limitedMembership = (await client.query(`insert into public.organisation_users (organisation_id, user_id, status) values ($1, $2, 'active') returning id`, [ids.orgA, LIMITED])).rows[0].id;
    await client.query('insert into public.user_role_assignments (organisation_id, membership_id, role_id) values ($1, $2, $3)', [ids.orgA, limitedMembership, role]);
    await client.query('commit');
  } finally {
    client.release();
  }
  app = await startApp();
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('permissions grouped for the editor', () => {
  it('names the module and the seat level each permission needs', async () => {
    const res = await api().get('/api/v1/permissions').set(await as(ids.ownerA)).expect(200);
    const by = Object.fromEntries(res.body.data.map((p: { code: string }) => [p.code, p]));
    expect(by['ncr.read']).toMatchObject({ module: 'Nonconformance', needs: 'observer' });
    expect(by['ncr.create']).toMatchObject({ module: 'Nonconformance', needs: 'operator' });
    expect(by['ncr.update']).toMatchObject({ module: 'Nonconformance', needs: 'contributor' });
    expect(by['ncr.approve_disposition']).toMatchObject({ module: 'Nonconformance', needs: 'controller' });
    expect(by['members.manage']).toMatchObject({ module: 'Administration', needs: null });
    expect(res.body.data.length).toBeGreaterThan(60);
  });
});

describe('making a role', () => {
  it('lets the Owner make one, with a key that is never a built-in key', async () => {
    const res = await api()
      .post('/api/v1/roles')
      .set(await as(ids.ownerA))
      .send({ name: 'Calibration tech', description: 'Records calibrations', permissions: ['calibration.read', 'calibration.record', 'master_data.read'] })
      .expect(201);
    expect(res.body).toMatchObject({ name: 'Calibration tech', key: 'custom_calibration_tech', isSystem: false, holders: 0 });
    expect(res.body.permissions).toEqual(['calibration.read', 'calibration.record', 'master_data.read']);
    const listed = await roleNamed('Calibration tech');
    expect(listed?.rowVersion).toMatch(/^[0-9]{10,20}$/);
  });

  it('refuses a duplicate name (any case), roles.manage, unknown permissions and an empty list', async () => {
    const h = await as(ids.ownerA);
    const dup = await api().post('/api/v1/roles').set(h).send({ name: 'calibration TECH', permissions: ['ncr.read'] }).expect(409);
    expect(dup.body.error.code).toBe('role_rule');
    const builtIn = await api().post('/api/v1/roles').set(h).send({ name: 'Owner', permissions: ['ncr.read'] }).expect(409);
    expect(builtIn.body.error.code).toBe('role_rule');
    const manage = await api().post('/api/v1/roles').set(h).send({ name: 'Boss', permissions: ['ncr.read', 'roles.manage'] }).expect(409);
    expect(manage.body.error.code).toBe('role_rule');
    expect(manage.body.error.message).toMatch(/Owner role/);
    await api().post('/api/v1/roles').set(h).send({ name: 'Bad', permissions: ['nonsense.do'] }).expect(409);
    await api().post('/api/v1/roles').set(h).send({ name: 'Empty', permissions: [] }).expect(400);
    await api().post('/api/v1/roles').set(h).send({ name: '   ', permissions: ['ncr.read'] }).expect(400);
    await api().post('/api/v1/roles').set(h).send({ name: 'Extra', permissions: ['ncr.read'], isSystem: true }).expect(400);
  });

  it('only people who may manage roles can make them', async () => {
    await api().post('/api/v1/roles').set(await as(ids.inspectorA)).send({ name: 'Sneaky', permissions: ['ncr.read'] }).expect(403);
  });

  it('never lets someone hand out a permission they do not hold themselves', async () => {
    const h = await as(LIMITED);
    await api().post('/api/v1/roles').set(h).send({ name: 'Reader copy', permissions: ['ncr.read'] }).expect(201);
    const over = await api().post('/api/v1/roles').set(h).send({ name: 'Too much', permissions: ['ncr.read', 'ncr.update'] }).expect(409);
    expect(over.body.error.code).toBe('role_rule');
    expect(await roleNamed('Too much')).toBeUndefined();
  });
});

describe('changing and deleting', () => {
  it('changes a custom role and says when a save was made from an old screen', async () => {
    const h = await as(ids.ownerA);
    const opened = (await roleNamed('Calibration tech'))!;
    const first = await api()
      .patch(`/api/v1/roles/${opened.id}`)
      .set(h)
      .send({ name: 'Calibration technician', permissions: ['calibration.read', 'calibration.record'], rowVersion: opened.rowVersion })
      .expect(200);
    expect(first.body).toMatchObject({ name: 'Calibration technician', description: 'Records calibrations' });
    expect(first.body.permissions).toEqual(['calibration.read', 'calibration.record']);
    expect(first.body.rowVersion).not.toBe(opened.rowVersion);

    // A second person opened the same version and saves: asked about, nothing written.
    const second = await api().patch(`/api/v1/roles/${opened.id}`).set(h).send({ description: 'Overwritten', rowVersion: opened.rowVersion }).expect(409);
    expect(second.body.error.code).toBe('edit_conflict');
    expect((await roleNamed('Calibration technician'))?.description).toBe('Records calibrations');
  });

  it('keeps the built-in roles fixed', async () => {
    const h = await as(ids.ownerA);
    const owner = (await roles()).find((r) => r.key === 'owner')!;
    const patch = await api().patch(`/api/v1/roles/${owner.id}`).set(h).send({ name: 'Boss' }).expect(409);
    expect(patch.body.error.code).toBe('role_rule');
    const del = await api().delete(`/api/v1/roles/${owner.id}`).set(h).expect(409);
    expect(del.body.error.code).toBe('role_rule');
    await api().patch(`/api/v1/roles/${owner.id}`).set(h).send({}).expect(400);
  });

  it('applies a change at once to the people who hold the role, and will not delete a role someone holds', async () => {
    const h = await as(ids.ownerA);
    const role = (await api().post('/api/v1/roles').set(h).send({ name: 'Directory reader', permissions: ['members.read'] }).expect(201)).body;
    await api().get('/api/v1/members').set(await as(ids.inspectorA)).expect(403);
    const assigned = await api().post(`/api/v1/members/${inspectorMembership}/role-assignments`).set(h).send({ roleId: role.id }).expect(201);
    expect(assigned.body.roles.some((r: { roleKey: string }) => r.roleKey === role.key)).toBe(true);
    expect((await roleNamed('Directory reader'))?.holders).toBe(1);
    await api().get('/api/v1/members').set(await as(ids.inspectorA)).expect(200);

    const refused = await api().delete(`/api/v1/roles/${role.id}`).set(h).expect(409);
    expect(refused.body.error.code).toBe('role_rule');
    expect(refused.body.error.message).toBe('1 person holds this role. Take it off them first.');

    // Taking the permission away takes the access away.
    await api().patch(`/api/v1/roles/${role.id}`).set(h).send({ permissions: ['master_data.read'] }).expect(200);
    await api().get('/api/v1/members').set(await as(ids.inspectorA)).expect(403);

    // Take it off the person, then it can go.
    const assignment = (await admin.query('select id from public.user_role_assignments where role_id = $1', [role.id])).rows[0].id;
    await api().delete(`/api/v1/role-assignments/${assignment}`).set(h).expect(204);
    await api().delete(`/api/v1/roles/${role.id}`).set(h).expect(204);
    expect(await roleNamed('Directory reader')).toBeUndefined();
  });
});

describe('other organisations', () => {
  it('neither sees nor changes them', async () => {
    const mine = (await roleNamed('Calibration technician'))!;
    const theirs = await roles(ids.ownerB, ids.orgB);
    expect(theirs.map((r) => r.id)).not.toContain(mine.id);
    expect(theirs.every((r) => r.isSystem)).toBe(true);
    await api().patch(`/api/v1/roles/${mine.id}`).set(await as(ids.ownerB, ids.orgB)).send({ name: 'Theirs now' }).expect(404);
    await api().delete(`/api/v1/roles/${mine.id}`).set(await as(ids.ownerB, ids.orgB)).expect(404);
    expect((await roleNamed('Calibration technician'))?.name).toBe('Calibration technician');
  });
});
