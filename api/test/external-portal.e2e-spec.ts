/**
 * The external portal foundation (docs/external-portal-plan.md PT1): the staff switch and parties, invitations and accepting them, what an external
 * person reaches (their own portal routes and nothing else), the rules the portal guard applies (two-factor, suspended, switched off) and does NOT
 * apply (the organisation's network allow-list, which is about its own people), a party admin's colleagues, and isolation between parties and
 * organisations. The rules themselves are in supabase/tests/external_portal_foundation.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('9c71');
const u = (tail: string) => `${'9c71'.padEnd(8, '0')}-0000-0000-0000-${tail.padStart(12, '0')}`;
const sam = u('e1'); // a supplier's admin
const kim = u('e2'); // a colleague
const ben = u('e3'); // another supplier's contact
const cat = u('e4'); // a customer's contact
let app: INestApplication;
let admin: Pool;
let supA: string;
let supB: string;
let cusA: string;
const api = () => request(app.getHttpServer());
const staff = async (user = ids.ownerA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': ids.orgA });
const external = async (user: string, org = ids.orgA, claims: Record<string, unknown> = { aal: 'aal2' }) => ({
  Authorization: `Bearer ${await token(user, claims)}`,
  'X-Organisation-Id': org,
});
const bare = async (user: string, claims: Record<string, unknown> = { aal: 'aal2' }) => ({ Authorization: `Bearer ${await token(user, claims)}` });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pt1');
  for (const [id, email] of [[sam, 'sam@acme-supplier.test'], [kim, 'kim@acme-supplier.test'], [ben, 'ben@bolt-supplier.test'], [cat, 'cat@big-customer.test']]) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now()) on conflict do nothing`, [id, email]);
  }
  await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ACME', 'Acme Castings'), ($1, 'BOLT', 'Bolt Ltd') on conflict do nothing`, [ids.orgA]);
  await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'BIG', 'Big Customer') on conflict do nothing`, [ids.orgA]);
  supA = (await admin.query(`select id from public.suppliers where organisation_id = $1 and code = 'ACME'`, [ids.orgA])).rows[0].id;
  supB = (await admin.query(`select id from public.suppliers where organisation_id = $1 and code = 'BOLT'`, [ids.orgA])).rows[0].id;
  cusA = (await admin.query(`select id from public.customers where organisation_id = $1`, [ids.orgA])).rows[0].id;
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

let partyA: string;
let partyB: string;
let accSam: string;
let accKim: string;

describe('staff: the switch, the parties and the people', () => {
  it('the portal starts off and only people with the permission see or change it', async () => {
    const overview = await api().get('/api/v1/external-access').set(await staff()).expect(200);
    expect(overview.body.settings).toEqual({ enabled: false, rankingEnabled: false, requireMfa: true });
    expect(overview.body.canManage).toBe(true);
    expect(overview.body.parties.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(['Acme Castings', 'Bolt Ltd', 'Big Customer']));
    await api().get('/api/v1/external-access').set(await staff(ids.inspectorA)).expect(403);
    await api().put('/api/v1/external-access/settings').set(await staff(ids.inspectorA)).send({ enabled: true }).expect(403);
  });

  it('nobody can be invited until the portal and the party are on', async () => {
    await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: supA, enabled: false, contactName: 'Pat in Quality' }).expect(200);
    const overview = await api().get('/api/v1/external-access').set(await staff()).expect(200);
    partyA = overview.body.parties.find((p: { name: string }) => p.name === 'Acme Castings').partyId;
    const refused = await api().post('/api/v1/external-access/people').set(await staff()).send({ partyId: partyA, email: 'sam@acme-supplier.test', role: 'admin' }).expect(409);
    expect(refused.body.error).toMatchObject({ code: 'portal_rule', message: expect.stringMatching(/not switched on/) });
    await api().put('/api/v1/external-access/settings').set(await staff()).send({ enabled: true }).expect(200);
    await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: supA, enabled: true }).expect(200);
    await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: supB, enabled: true }).expect(200);
    const both = await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'customer', partyId: cusA, enabled: true, contactName: 'Quality desk' }).expect(200);
    partyB = both.body.parties.find((p: { name: string }) => p.name === 'Bolt Ltd').partyId;
    expect(both.body.parties.find((p: { name: string }) => p.name === 'Acme Castings')).toMatchObject({ enabled: true, contactName: 'Pat in Quality' });
  });

  it('invites a first contact as admin; the email is not configured in tests, and the invitation stays', async () => {
    const res = await api().post('/api/v1/external-access/people').set(await staff()).send({ partyId: partyA, email: ' Sam@Acme-Supplier.test ', role: 'admin', message: 'Welcome' }).expect(201);
    expect(res.body.person).toMatchObject({ email: 'sam@acme-supplier.test', role: 'admin', status: 'invited', partyName: 'Acme Castings' });
    expect(res.body.email).toMatchObject({ sent: false });
    accSam = res.body.person.id;
    await api().post('/api/v1/external-access/people').set(await staff()).send({ partyId: partyA, email: 'sam@acme-supplier.test', role: 'member' }).expect(409);
    await api().post('/api/v1/external-access/people').set(await staff(ids.inspectorA)).send({ partyId: partyA, email: 'x@acme-supplier.test' }).expect(403);
  });

  it('an organisation member cannot be invited as an external person', async () => {
    const row = await admin.query(`select email from auth.users where id = $1`, [ids.ownerA]);
    const refused = await api().post('/api/v1/external-access/people').set(await staff()).send({ partyId: partyA, email: row.rows[0].email, role: 'member' }).expect(409);
    expect(refused.body.error.message).toMatch(/one of your own people/);
  });
});

describe('the external person', () => {
  it('sees the invitation by address, is not a member, and cannot reach staff routes', async () => {
    const h = await bare(sam);
    const inv = await api().get('/api/v1/portal/invitations').set(h).expect(200);
    expect(inv.body.data).toMatchObject([{ organisationName: 'Alpha Precision', partyName: 'Acme Castings', partyKind: 'supplier', role: 'admin' }]);
    const me0 = await api().get('/api/v1/me').set(h).expect(200);
    expect(me0.body.memberships).toEqual([]);
    expect(me0.body.portal).toEqual([]);
    expect(me0.body.portalInvitations).toMatchObject([{ organisationName: 'Alpha Precision', partyName: 'Acme Castings', expired: false }]);
    // Not a member: every staff route says so.
    const asStaffRoute = { ...h, 'X-Organisation-Id': ids.orgA };
    await api().get('/api/v1/external-access').set(asStaffRoute).expect(404);
    await api().get('/api/v1/ncrs').set(asStaffRoute).expect(404);
    await api().get('/api/v1/suppliers').set(asStaffRoute).expect(404);
    await api().get('/api/v1/members').set(asStaffRoute).expect(404);
    await api().get('/api/v1/portal/home').set(asStaffRoute).expect(404);
  });

  it('accepts the invitation and lands in the portal', async () => {
    const h = await bare(sam);
    const inv = (await api().get('/api/v1/portal/invitations').set(h)).body.data[0];
    const res = await api().post(`/api/v1/portal/invitations/${inv.id}/accept`).set(h).expect(201);
    expect(res.body.data).toMatchObject([{ organisationName: 'Alpha Precision', partyName: 'Acme Castings', role: 'admin', contactName: 'Pat in Quality', mfaRequired: false }]);
    const me = await api().get('/api/v1/me').set(h).expect(200);
    expect(me.body.memberships).toEqual([]);
    expect(me.body.portal).toHaveLength(1);
    expect(me.body.portalInvitations).toEqual([]);
    const home = await api().get('/api/v1/portal/home').set(await external(sam)).expect(200);
    expect(home.body.access).toMatchObject({ partyName: 'Acme Castings', partyKind: 'supplier', role: 'admin' });
    await api().post(`/api/v1/portal/invitations/${inv.id}/accept`).set(h).expect(404);
  });

  it('two-factor applies: without it the portal answers mfa_required, and /me says so', async () => {
    const noMfa = await bare(sam, {});
    const me = await api().get('/api/v1/me').set(noMfa).expect(200);
    expect(me.body.portal[0].mfaRequired).toBe(true);
    const res = await api().get('/api/v1/portal/home').set(await external(sam, ids.orgA, {})).expect(403);
    expect(res.body.error.code).toBe('mfa_required');
    await api().put('/api/v1/external-access/settings').set(await staff()).send({ requireMfa: false }).expect(200);
    await api().get('/api/v1/portal/home').set(await external(sam, ids.orgA, {})).expect(200);
    await api().put('/api/v1/external-access/settings').set(await staff()).send({ requireMfa: true }).expect(200);
  });

  it('is not held back by the organisation’s network allow-list (that is for its own people)', async () => {
    await admin.query(`insert into public.organisation_networks (organisation_id, name, network) values ($1, 'HQ', '203.0.113.0/28') on conflict do nothing`, [ids.orgA]);
    await admin.query(`update public.organisation_settings set network_policy = 'enforce' where organisation_id = $1`, [ids.orgA]);
    try {
      const outside = { ...(await external(sam)), 'X-Forwarded-For': '198.51.100.77' };
      await api().get('/api/v1/portal/home').set(outside).expect(200);
      const staffOutside = { ...(await staff()), 'X-Forwarded-For': '198.51.100.77' };
      await api().get('/api/v1/external-access').set(staffOutside).expect(403);
    } finally {
      await admin.query(`update public.organisation_settings set network_policy = 'off' where organisation_id = $1`, [ids.orgA]);
    }
  });
});

describe('a party admin and their colleagues', () => {
  it('invites a colleague as a member, never an admin, and sees them', async () => {
    const h = await external(sam);
    const res = await api().post('/api/v1/portal/people').set(h).send({ email: 'kim@acme-supplier.test' }).expect(201);
    expect(res.body.person).toMatchObject({ email: 'kim@acme-supplier.test', role: 'member', status: 'invited', partyName: 'Acme Castings' });
    accKim = res.body.person.id;
    await api().post('/api/v1/portal/people').set(h).send({ email: 'boss@acme-supplier.test', role: 'admin' }).expect(400);
    const list = await api().get('/api/v1/portal/people').set(h).expect(200);
    expect(list.body.data.map((p: { email: string }) => p.email).sort()).toEqual(['kim@acme-supplier.test', 'sam@acme-supplier.test']);
  });

  it('the colleague accepts, is an ordinary member and cannot manage people', async () => {
    const h = await bare(kim);
    const inv = (await api().get('/api/v1/portal/invitations').set(h)).body.data[0];
    await api().post(`/api/v1/portal/invitations/${inv.id}/accept`).set(h).expect(201);
    await api().get('/api/v1/portal/home').set(await external(kim)).expect(200);
    await api().get('/api/v1/portal/people').set(await external(kim)).expect(403);
    await api().post('/api/v1/portal/people').set(await external(kim)).send({ email: 'q@acme-supplier.test' }).expect(403);
  });

  it('removes a colleague with a reason; their access ends at once; the row stays', async () => {
    const h = await external(sam);
    await api().post(`/api/v1/portal/people/${accKim}/remove`).set(h).send({ reason: 'x' }).expect(400);
    const res = await api().post(`/api/v1/portal/people/${accKim}/remove`).set(h).send({ reason: 'Left the company' }).expect(201);
    expect(res.body).toMatchObject({ status: 'removed', removedReason: 'Left the company' });
    await api().get('/api/v1/portal/home').set(await external(kim)).expect(404);
    const me = await api().get('/api/v1/me').set(await bare(kim)).expect(200);
    expect(me.body.portal).toEqual([]);
    await api().post(`/api/v1/portal/people/${accSam}/remove`).set(h).send({ reason: 'Myself' }).expect(409);
  });

  it('cannot reach another party’s people, or another organisation', async () => {
    // Bolt's contact (invited by staff and accepted) cannot see or remove Acme's people.
    const inv = await api().post('/api/v1/external-access/people').set(await staff()).send({ partyId: partyB, email: 'ben@bolt-supplier.test', role: 'admin' }).expect(201);
    const hb = await bare(ben);
    const mine = (await api().get('/api/v1/portal/invitations').set(hb)).body.data[0];
    await api().post(`/api/v1/portal/invitations/${mine.id}/accept`).set(hb).expect(201);
    const h = await external(ben);
    const list = await api().get('/api/v1/portal/people').set(h).expect(200);
    expect(list.body.data.map((p: { email: string }) => p.email)).toEqual(['ben@bolt-supplier.test']);
    await api().post(`/api/v1/portal/people/${accSam}/remove`).set(h).send({ reason: 'Not mine to remove' }).expect(404);
    await api().post(`/api/v1/portal/people/${accSam}/resend`).set(h).expect(404);
    await api().get('/api/v1/portal/home').set(await external(ben, ids.orgB)).expect(404);
    expect(inv.body.person.partyName).toBe('Bolt Ltd');
  });
});

describe('staff control over access', () => {
  it('lists everyone with last sign-in, suspends and brings back, and ends access when a party is switched off', async () => {
    const list = await api().get('/api/v1/external-access/people').set(await staff()).expect(200);
    expect(list.body.data.find((p: { email: string }) => p.email === 'sam@acme-supplier.test')).toMatchObject({ status: 'active', lastSignInAt: expect.any(String) });
    const one = await api().get(`/api/v1/external-access/people?partyId=${partyB}`).set(await staff()).expect(200);
    expect(one.body.data.every((p: { partyName: string }) => p.partyName === 'Bolt Ltd')).toBe(true);

    await api().post(`/api/v1/external-access/people/${accSam}/suspend`).set(await staff()).send({ reason: 'Under review' }).expect(201);
    await api().get('/api/v1/portal/home').set(await external(sam)).expect(404);
    await api().post(`/api/v1/external-access/people/${accSam}/restore`).set(await staff()).expect(201);
    await api().get('/api/v1/portal/home').set(await external(sam)).expect(200);

    await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: supA, enabled: false }).expect(200);
    await api().get('/api/v1/portal/home').set(await external(sam)).expect(404);
    await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: supA, enabled: true }).expect(200);

    await api().put('/api/v1/external-access/settings').set(await staff()).send({ enabled: false }).expect(200);
    await api().get('/api/v1/portal/home').set(await external(sam)).expect(404);
    await api().put('/api/v1/external-access/settings').set(await staff()).send({ enabled: true }).expect(200);
  });

  it('another organisation’s staff cannot touch our people', async () => {
    const other = { Authorization: `Bearer ${await token(ids.ownerB)}`, 'X-Organisation-Id': ids.orgB };
    await api().post(`/api/v1/external-access/people/${accSam}/remove`).set(other).send({ reason: 'Not yours to remove' }).expect(404);
    await api().post(`/api/v1/external-access/people/${accSam}/suspend`).set(other).send({ reason: 'Not yours to suspend' }).expect(404);
    const list = await api().get('/api/v1/external-access/people').set(other).expect(200);
    expect(list.body.data).toEqual([]);
  });

  it('what an external person writes is recorded under their name (the audit trail)', async () => {
    const r = await admin.query(
      `select count(*)::int as n from audit.events where organisation_id = $1 and entity_type = 'external_access' and actor_user_id = $2`,
      [ids.orgA, sam],
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });
});
