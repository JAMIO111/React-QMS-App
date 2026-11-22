/**
 * Closure confirmation (docs/external-portal-plan.md PT5b) through the API: staff ask a customer to confirm a shared NC can be closed, the customer
 * confirms or says what is still wrong, suppliers are never asked, isolation between customers. Information only: nothing internal changes.
 * The rules are in supabase/tests/portal_closure_confirmation.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { categoryId, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('9c79');
const u = (tail: string) => `${'9c79'.padEnd(8, '0')}-0000-0000-0000-${tail.padStart(12, '0')}`;
const sam = u('e1');
const cus = u('e4');
const cus2 = u('e5');
let app: INestApplication;
let admin: Pool;
let shareC: string;
let shareS: string;
let ncC: string;
const api = () => request(app.getHttpServer());
const staff = async () => ({ Authorization: `Bearer ${await token(ids.ownerA)}`, 'X-Organisation-Id': ids.orgA });
const external = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}`, 'X-Organisation-Id': ids.orgA });
const bare = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}` });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pt5b');
  for (const [id, email] of [[sam, 'sam@acme-pt5b.test'], [cus, 'cus@wayne-pt5b.test'], [cus2, 'cus2@other-pt5b.test']]) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now()) on conflict do nothing`, [id, email]);
  }
  await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ACME', 'Acme Castings') on conflict do nothing`, [ids.orgA]);
  await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'WAYNE', 'Wayne Ltd'), ($1, 'OTHER', 'Other Co') on conflict do nothing`, [ids.orgA]);
  const one = async (s: string) => (await admin.query(s, [ids.orgA])).rows[0].id as string;
  const acme = await one(`select id from public.suppliers where organisation_id = $1 and code = 'ACME'`);
  const wayne = await one(`select id from public.customers where organisation_id = $1 and code = 'WAYNE'`);
  const other = await one(`select id from public.customers where organisation_id = $1 and code = 'OTHER'`);
  const cat = await categoryId(admin, ids.orgA);
  ncC = (await admin.query(
    `insert into public.nonconformances (organisation_id, reference, source, stage, category_id, title, description, severity, quantity_affected, site_id, customer_id)
     values ($1, 'PT5B-E2E-1', 'customer', 'open', $2, 'Bracket cracked', 'Cracks at the bend', 'major', 3, $3, $4) returning id`, [ids.orgA, cat, ids.siteA, wayne])).rows[0].id;
  const ncS = (await admin.query(
    `insert into public.nonconformances (organisation_id, reference, source, stage, category_id, title, severity, quantity_affected, site_id, supplier_id)
     values ($1, 'PT5B-E2E-2', 'supplier', 'open', $2, 'Bar stock', 'minor', 1, $3, $4) returning id`, [ids.orgA, cat, ids.siteA, acme])).rows[0].id;
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  await api().put('/api/v1/external-access/settings').set(await staff()).send({ enabled: true, requireMfa: false }).expect(200);
  const party = async (kind: 'supplier' | 'customer', partyId: string, name: string) =>
    (await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind, partyId, enabled: true }).expect(200)).body.parties.find((p: { name: string }) => p.name === name).partyId as string;
  const pA = await party('supplier', acme, 'Acme Castings');
  const pC = await party('customer', wayne, 'Wayne Ltd');
  const pO = await party('customer', other, 'Other Co');
  for (const [p, email, user] of [[pA, 'sam@acme-pt5b.test', sam], [pC, 'cus@wayne-pt5b.test', cus], [pO, 'cus2@other-pt5b.test', cus2]] as const) {
    await api().post('/api/v1/external-access/people').set(await staff()).send({ partyId: p, email, role: 'admin' }).expect(201);
    const inv = (await api().get('/api/v1/portal/invitations').set(await bare(user))).body.data[0];
    await api().post(`/api/v1/portal/invitations/${inv.id}/accept`).set(await bare(user)).expect(201);
  }
  shareC = (await api().post('/api/v1/external-access/shares').set(await staff()).send({ kind: 'ncr', recordId: ncC, partyId: pC }).expect(201)).body.data[0].id;
  shareS = (await api().post('/api/v1/external-access/shares').set(await staff()).send({ kind: 'ncr', recordId: ncS, partyId: pA }).expect(201)).body.data[0].id;
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('closure confirmation', () => {
  let requestId: string;

  it('lets staff ask a customer, never a supplier, one request at a time', async () => {
    await api().post(`/api/v1/external-access/shares/${shareS}/closures`).set(await staff()).send({}).expect(409);
    const r = await api().post(`/api/v1/external-access/shares/${shareC}/closures`).set(await staff()).send({ note: 'We believe this is resolved.' }).expect(201);
    requestId = r.body.data[0].id;
    expect(r.body.data[0]).toMatchObject({ status: 'pending', requestNote: 'We believe this is resolved.' });
    await api().post(`/api/v1/external-access/shares/${shareC}/closures`).set(await staff()).send({}).expect(409);
  });

  it('shows the customer the request, waiting on the home page, without naming staff', async () => {
    const home = await api().get('/api/v1/portal/home').set(await external(cus)).expect(200);
    expect(home.body.toConfirm).toBe(1);
    expect(home.body.attention.find((i: { id: string }) => i.id === shareC)).toMatchObject({ needsClosure: true });
    const s = await api().get(`/api/v1/portal/shares/${shareC}`).set(await external(cus)).expect(200);
    expect(s.body.closures).toHaveLength(1);
    expect(s.body.closures[0]).toMatchObject({ status: 'pending', canDecide: true, requestedBy: null });
  });

  it('keeps it from another customer and a supplier', async () => {
    await api().post(`/api/v1/portal/closure-requests/${requestId}/decide`).set(await external(cus2)).send({ confirm: true }).expect(404);
    await api().post(`/api/v1/portal/closure-requests/${requestId}/decide`).set(await external(sam)).send({ confirm: true }).expect(404);
  });

  it('needs a reason to decline, and a decision is final; nothing internal changes', async () => {
    await api().post(`/api/v1/portal/closure-requests/${requestId}/decide`).set(await external(cus)).send({ confirm: false }).expect(409);
    const r = await api().post(`/api/v1/portal/closure-requests/${requestId}/decide`).set(await external(cus)).send({ confirm: false, note: 'Two more cracked last week.' }).expect(201);
    expect(r.body.closures[0]).toMatchObject({ status: 'declined', decisionNote: 'Two more cracked last week.' });
    await api().post(`/api/v1/portal/closure-requests/${requestId}/decide`).set(await external(cus)).send({ confirm: true }).expect(409);
    expect((await admin.query(`select stage from public.nonconformances where id = $1`, [ncC])).rows[0].stage).toBe('open');
    const staffView = await api().get(`/api/v1/external-access/shares/${shareC}/closures`).set(await staff()).expect(200);
    expect(staffView.body.data[0]).toMatchObject({ status: 'declined', decidedBy: expect.any(String) });
  });

  it('lets staff withdraw a waiting request with a reason', async () => {
    const r = await api().post(`/api/v1/external-access/shares/${shareC}/closures`).set(await staff()).send({}).expect(201);
    const id = r.body.data[0].id;
    await api().post(`/api/v1/external-access/closure-requests/${id}/withdraw`).set(await staff()).send({ reason: 'x' }).expect(400);
    const w = await api().post(`/api/v1/external-access/closure-requests/${id}/withdraw`).set(await staff()).send({ reason: 'Raised too early' }).expect(201);
    expect(w.body.data[0]).toMatchObject({ status: 'withdrawn', withdrawnReason: 'Raised too early' });
    const s = await api().get(`/api/v1/portal/shares/${shareC}`).set(await external(cus)).expect(200);
    expect(s.body.closures.map((c: { status: string }) => c.status)).toEqual(['declined']);
  });
});
