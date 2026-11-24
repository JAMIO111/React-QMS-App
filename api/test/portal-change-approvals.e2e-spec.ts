/**
 * Staff ask a customer to approve a change in the portal (docs/change-management-plan.md CH6b): the customer approves it or says what they cannot accept,
 * the answer is recorded on the change's own customer approval, suppliers and other customers are refused, and nothing else moves. The rules are in
 * supabase/tests/portal_change_approvals.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('9c81');
const u = (tail: string) => `${'9c81'.padEnd(8, '0')}-0000-0000-0000-${tail.padStart(12, '0')}`;
const sam = u('e1');
const cus = u('e4');
const cus2 = u('e5');
let app: INestApplication;
let admin: Pool;
let partyC: string;
let changeId: string;
const api = () => request(app.getHttpServer());
const staff = async () => ({ Authorization: `Bearer ${await token(ids.ownerA)}`, 'X-Organisation-Id': ids.orgA });
const external = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}`, 'X-Organisation-Id': ids.orgA });
const bare = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}` });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ch6b');
  for (const [id, email] of [[sam, 'sam@acme-ch6b.test'], [cus, 'cus@wayne-ch6b.test'], [cus2, 'cus2@other-ch6b.test']]) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now()) on conflict do nothing`, [id, email]);
  }
  await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ACME', 'Acme Castings') on conflict do nothing`, [ids.orgA]);
  await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'WAYNE', 'Wayne Ltd'), ($1, 'OTHER', 'Other Co') on conflict do nothing`, [ids.orgA]);
  await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'C6B-100', 'Bracket') on conflict do nothing`, [ids.orgA]);
  const one = async (s: string) => (await admin.query(s, [ids.orgA])).rows[0].id as string;
  const acme = await one(`select id from public.suppliers where organisation_id = $1 and code = 'ACME'`);
  const wayne = await one(`select id from public.customers where organisation_id = $1 and code = 'WAYNE'`);
  const other = await one(`select id from public.customers where organisation_id = $1 and code = 'OTHER'`);
  const part = await one(`select id from public.parts where organisation_id = $1 and part_number = 'C6B-100'`);
  await admin.query(`insert into public.part_customers (organisation_id, part_id, customer_id, customer_part_number, is_primary) values ($1, $2, $3, 'W-9', true)`, [ids.orgA, part, wayne]);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  await api().put('/api/v1/external-access/settings').set(await staff()).send({ enabled: true, requireMfa: false }).expect(200);
  const party = async (kind: 'supplier' | 'customer', partyId: string, name: string) =>
    (await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind, partyId, enabled: true }).expect(200)).body.parties.find((p: { name: string }) => p.name === name).partyId as string;
  const pA = await party('supplier', acme, 'Acme Castings');
  partyC = await party('customer', wayne, 'Wayne Ltd');
  const pO = await party('customer', other, 'Other Co');
  for (const [p, email, user] of [[pA, 'sam@acme-ch6b.test', sam], [partyC, 'cus@wayne-ch6b.test', cus], [pO, 'cus2@other-ch6b.test', cus2]] as const) {
    await api().post('/api/v1/external-access/people').set(await staff()).send({ partyId: p, email, role: 'admin' }).expect(201);
    const inv = (await api().get('/api/v1/portal/invitations').set(await bare(user))).body.data[0];
    await api().post(`/api/v1/portal/invitations/${inv.id}/accept`).set(await bare(user)).expect(201);
  }
  const types = await api().get('/api/v1/change-types').set(await staff()).expect(200);
  const typeId = types.body.data.find((t: { key: string }) => t.key === 'product_design').id;
  const made = await api().post('/api/v1/changes').set(await staff())
    .send({ title: 'Tighten the bend radius', description: 'Bend radius from 3 mm to 2 mm', reason: 'Customer request', typeId, links: [{ kind: 'part', id: part }] }).expect(201);
  changeId = made.body.id;
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('customer approval of a change in the portal', () => {
  let requestId: string;

  it('names the customers a change is about, and refuses a draft', async () => {
    await api().post(`/api/v1/changes/${changeId}/customer-approvals`).set(await staff()).send({ partyId: partyC }).expect(409);
    await api().post(`/api/v1/changes/${changeId}/submit`).set(await staff()).expect(200);
    const list = await api().get(`/api/v1/changes/${changeId}/customer-approvals`).set(await staff()).expect(200);
    expect(list.body.customers.map((c: { name: string }) => c.name)).toEqual(['Wayne Ltd']);
    expect(list.body.data).toEqual([]);
  });

  it('lets staff ask the customer, one request at a time', async () => {
    await api().post(`/api/v1/changes/${changeId}/customer-approvals`).set(await staff()).send({ partyId: u('aa') }).expect(409);
    const r = await api().post(`/api/v1/changes/${changeId}/customer-approvals`).set(await staff()).send({ partyId: partyC, note: 'Please approve the tighter radius.' }).expect(201);
    requestId = r.body.data[0].id;
    expect(r.body.data[0]).toMatchObject({ status: 'pending', customer: 'Wayne Ltd', requestNote: 'Please approve the tighter radius.' });
    await api().post(`/api/v1/changes/${changeId}/customer-approvals`).set(await staff()).send({ partyId: partyC }).expect(409);
    const detail = await api().get(`/api/v1/changes/${changeId}`).set(await staff()).expect(200);
    expect(detail.body.customerApproval.status).toBe('requested');
  });

  it('shows the customer the change in named fields only', async () => {
    const list = await api().get('/api/v1/portal/change-approvals').set(await external(cus)).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(Object.keys(list.body.data[0]).sort()).toEqual(['canDecide', 'decidedAt', 'id', 'reference', 'requestedAt', 'status', 'title']);
    const one = await api().get(`/api/v1/portal/change-approvals/${requestId}`).set(await external(cus)).expect(200);
    expect(Object.keys(one.body).sort()).toEqual([
      'appliesFrom', 'canDecide', 'contact', 'decidedAt', 'decidedBy', 'decisionNote', 'expedited', 'id', 'open', 'parts', 'reference', 'requestNote', 'requestedAt', 'status', 'stock', 'title', 'type', 'whatIsChanging', 'why', 'yourReference',
    ]);
    expect(one.body.parts).toEqual([{ partNumber: 'C6B-100', name: 'Bracket', theirPartNumber: 'W-9' }]);
    const home = await api().get('/api/v1/portal/home').set(await external(cus)).expect(200);
    expect(home.body.changesToApprove).toBe(1);
  });

  it('refuses a supplier and another customer', async () => {
    await api().get('/api/v1/portal/change-approvals').set(await external(sam)).expect(404);
    await api().get(`/api/v1/portal/change-approvals/${requestId}`).set(await external(cus2)).expect(404);
    await api().post(`/api/v1/portal/change-approvals/${requestId}/decide`).set(await external(cus2)).send({ approve: true }).expect(404);
    expect((await api().get('/api/v1/portal/change-approvals').set(await external(cus2)).expect(200)).body.data).toEqual([]);
  });

  it('records a no (with a reason) on the change, finally, and moves nothing else', async () => {
    await api().post(`/api/v1/portal/change-approvals/${requestId}/decide`).set(await external(cus)).send({ approve: false }).expect(409);
    const done = await api().post(`/api/v1/portal/change-approvals/${requestId}/decide`).set(await external(cus)).send({ approve: false, note: 'A 2 mm radius cracks on our press.' }).expect(200);
    expect(done.body).toMatchObject({ status: 'rejected', decisionNote: 'A 2 mm radius cracks on our press.', canDecide: false });
    await api().post(`/api/v1/portal/change-approvals/${requestId}/decide`).set(await external(cus)).send({ approve: true }).expect(409);
    const detail = await api().get(`/api/v1/changes/${changeId}`).set(await staff()).expect(200);
    expect(detail.body.customerApproval.status).toBe('rejected');
    expect(detail.body.stage).toBe('assessment');
    const notices = await admin.query(`select count(*)::int as n from public.portal_activity where kind = 'change_declined' and record_id = $1`, [changeId]);
    expect(notices.rows[0].n).toBe(1);
  });

  it('can be asked again and approved with the customer’s own reference', async () => {
    const again = await api().post(`/api/v1/changes/${changeId}/customer-approvals`).set(await staff()).send({ partyId: partyC }).expect(201);
    const second = again.body.data[0].id;
    expect(again.body.data).toHaveLength(2);
    const done = await api().post(`/api/v1/portal/change-approvals/${second}/decide`).set(await external(cus)).send({ approve: true, reference: 'WAYNE-ECN-12' }).expect(200);
    expect(done.body).toMatchObject({ status: 'approved', yourReference: 'WAYNE-ECN-12' });
    const detail = await api().get(`/api/v1/changes/${changeId}`).set(await staff()).expect(200);
    expect(detail.body.customerApproval).toMatchObject({ status: 'approved', reference: 'WAYNE-ECN-12' });
    await api().post(`/api/v1/changes/${changeId}/customer-approvals`).set(await staff()).send({ partyId: partyC }).expect(409);
  });

  it('lets staff withdraw a waiting request with a reason', async () => {
    await api().put(`/api/v1/changes/${changeId}/customer-approval`).set(await staff()).send({ status: 'required' }).expect(200);
    const asked = await api().post(`/api/v1/changes/${changeId}/customer-approvals`).set(await staff()).send({ partyId: partyC }).expect(201);
    const waiting = asked.body.data[0].id;
    await api().post(`/api/v1/change-customer-approvals/${waiting}/withdraw`).set(await staff()).send({ reason: 'x' }).expect(400);
    const w = await api().post(`/api/v1/change-customer-approvals/${waiting}/withdraw`).set(await staff()).send({ reason: 'Raised too early' }).expect(200);
    expect(w.body.data[0]).toMatchObject({ status: 'withdrawn', withdrawnReason: 'Raised too early' });
    const detail = await api().get(`/api/v1/changes/${changeId}`).set(await staff()).expect(200);
    expect(detail.body.customerApproval.status).toBe('required');
    await api().get(`/api/v1/portal/change-approvals/${waiting}`).set(await external(cus)).expect(404);
    expect((await api().get('/api/v1/portal/change-approvals').set(await external(cus)).expect(200)).body.data).toHaveLength(2);
  });
});
