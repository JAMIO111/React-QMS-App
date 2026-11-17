/**
 * No seat, no access (docs/seats-and-member-onboarding-plan.md SM3–SM5) through the API: in an organisation that enforces packages, a member
 * without a seat gets 403 seat_required on every organisation route, /me lists the organisation under seats.waitingIn (with who can give a seat)
 * instead of in memberships, a reminder is allowed once a day, and a seat lets them in. An admin without a seat still runs the account. The rules
 * are in supabase/tests/no_seat_no_access.test.sql and every_feature_priced.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { giveControllerSeats, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('5eab');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-seats');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  // Alpha enforces packages; the owner holds a Controller seat, the inspector none (a seat request is written at commit).
  await giveControllerSeats(admin, ids.orgA, [ids.ownerA]);
  await admin.query('update public.organisation_settings set entitlements_enforced = true where organisation_id = $1', [ids.orgA]);
  // An admin without a seat.
  const m = (await admin.query(`update auth.users set email = 'seatless-admin@example.test' where id = $1 returning id`, [ids.outsider])).rows[0];
  const ou = (await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, m.id])).rows[0];
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'admin'`, [ids.orgA, ou.id]);
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('a member without a seat', () => {
  it('is refused with seat_required on organisation routes', async () => {
    const res = await api().get('/api/v1/ncrs').set(await as(ids.inspectorA)).expect(403);
    expect(res.body.error.code).toBe('seat_required');
    expect(res.body.error.details).toEqual({ organisationId: ids.orgA });
  });

  it('sees the organisation under seats.waitingIn, with who can give a seat, and not among memberships', async () => {
    const me = await api().get('/api/v1/me').set({ Authorization: `Bearer ${await token(ids.inspectorA)}` }).expect(200);
    expect(me.body.memberships.map((m: { organisation: { id: string } }) => m.organisation.id)).not.toContain(ids.orgA);
    const wait = me.body.seats.waitingIn.find((w: { id: string }) => w.id === ids.orgA);
    expect(wait).toMatchObject({ name: 'Alpha Precision' });
    expect(wait.managers).toEqual(expect.arrayContaining(['Ada Owner', 'seatless-admin@example.test']));
  });

  it('may remind the people who give seats once a day', async () => {
    const h = { Authorization: `Bearer ${await token(ids.inspectorA)}` };
    // no request was written for a seed made by SQL (the membership was active before packages were enforced), so the first reminder goes
    const first = await api().post('/api/v1/me/seat-reminder').set(h).send({ organisationId: ids.orgA }).expect(201);
    expect(first.body.seats.waitingIn[0].lastToldAt).toBeTruthy();
    const again = await api().post('/api/v1/me/seat-reminder').set(h).send({ organisationId: ids.orgA }).expect(409);
    expect(again.body.error.code).toBe('subscription_rule');
    const told = await admin.query(`select count(*)::int n from public.notifications where organisation_id = $1 and entity_type = 'seat_requests'`, [ids.orgA]);
    expect(told.rows[0].n).toBeGreaterThan(0);
  });

  it('sets up their own profile while they wait (SM6), and cannot mark another organisation', async () => {
    const h = { Authorization: `Bearer ${await token(ids.inspectorA)}` };
    const me = await api().get('/api/v1/me').set(h).expect(200);
    expect(me.body.welcome.find((w: { id: string }) => w.id === ids.orgA)).toMatchObject({ aboutDone: false, notificationsDone: false, waitingForSeat: true });
    const after = await api().post('/api/v1/me/welcome').set(h).send({ organisationId: ids.orgA, step: 'about' }).expect(201);
    expect(after.body.welcome.find((w: { id: string }) => w.id === ids.orgA)).toMatchObject({ aboutDone: true, notificationsDone: false });
    await api().post('/api/v1/me/welcome').set(h).send({ organisationId: ids.orgA, step: 'later' }).expect(400);
    const other = await api().post('/api/v1/me/welcome').set(h).send({ organisationId: ids.orgB, step: 'about' });
    expect(other.status).toBeGreaterThanOrEqual(400);
  });

  it('is let in once given a seat', async () => {
    await giveControllerSeats(admin, ids.orgA, [ids.inspectorA]);
    await api().get('/api/v1/ncrs').set(await as(ids.inspectorA)).expect(200);
    const me = await api().get('/api/v1/me').set({ Authorization: `Bearer ${await token(ids.inspectorA)}` }).expect(200);
    expect(me.body.seats.waitingIn).toEqual([]);
    expect(me.body.memberships.map((m: { organisation: { id: string } }) => m.organisation.id)).toContain(ids.orgA);
    await api().post('/api/v1/me/seat-reminder').set({ Authorization: `Bearer ${await token(ids.inspectorA)}` }).send({ organisationId: ids.orgA }).expect(409);
  });
});

describe('an admin without a seat', () => {
  it('runs the account but uses nothing priced', async () => {
    await api().get('/api/v1/members').set(await as(ids.outsider)).expect(200);
    const ncrs = await api().get('/api/v1/ncrs').set(await as(ids.outsider)).expect(403);
    expect(ncrs.body.error.code).not.toBe('seat_required');
  });
});

describe('an organisation that does not enforce packages', () => {
  it('is unchanged: a member without a seat is a member', async () => {
    await api().get('/api/v1/ncrs').set(await as(ids.ownerB, ids.orgB)).expect(200);
  });
});
