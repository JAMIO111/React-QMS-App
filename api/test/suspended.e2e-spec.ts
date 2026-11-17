/**
 * A suspended member is told so (the app's "You have been suspended from … by … on …" screen): /me lists the organisation under `suspended`
 * with who suspended them and when, and not among memberships. The rule is in supabase/tests/suspended_screen.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('5eac');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-susp');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('a suspended member', () => {
  it('finds the organisation under suspended and not among memberships', async () => {
    const me = await api().get('/api/v1/me').set({ Authorization: `Bearer ${await token(ids.suspendedA)}` }).expect(200);
    expect(me.body.memberships.map((m: { organisation: { id: string } }) => m.organisation.id)).not.toContain(ids.orgA);
    expect(me.body.suspended).toEqual([expect.objectContaining({ id: ids.orgA, name: 'Alpha Precision' })]);
  });

  it('is told who suspended them and when, once an owner does it', async () => {
    const before = await api().get('/api/v1/me').set({ Authorization: `Bearer ${await token(ids.inspectorA)}` }).expect(200);
    expect(before.body.suspended).toEqual([]);
    const members = await api().get('/api/v1/members').set(await as(ids.ownerA)).expect(200);
    const row = members.body.data.find((m: { userId: string }) => m.userId === ids.inspectorA);
    await api().patch(`/api/v1/members/${row.membershipId}`).set(await as(ids.ownerA)).send({ status: 'suspended' }).expect(200);
    const me = await api().get('/api/v1/me').set({ Authorization: `Bearer ${await token(ids.inspectorA)}` }).expect(200);
    expect(me.body.memberships.map((m: { organisation: { id: string } }) => m.organisation.id)).not.toContain(ids.orgA);
    const entry = me.body.suspended.find((s: { id: string }) => s.id === ids.orgA);
    expect(entry.suspendedBy).toBe('Ada Owner');
    expect(Date.now() - new Date(entry.suspendedAt).getTime()).toBeLessThan(60_000);
  });

  it('is let back in when reactivated', async () => {
    const members = await api().get('/api/v1/members').set(await as(ids.ownerA)).expect(200);
    const row = members.body.data.find((m: { userId: string }) => m.userId === ids.inspectorA);
    await api().patch(`/api/v1/members/${row.membershipId}`).set(await as(ids.ownerA)).send({ status: 'active' }).expect(200);
    const me = await api().get('/api/v1/me').set({ Authorization: `Bearer ${await token(ids.inspectorA)}` }).expect(200);
    expect(me.body.suspended).toEqual([]);
    expect(me.body.memberships.map((m: { organisation: { id: string } }) => m.organisation.id)).toContain(ids.orgA);
  });
});
