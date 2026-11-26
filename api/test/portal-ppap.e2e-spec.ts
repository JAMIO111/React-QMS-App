/**
 * A customer answers a PPAP submission in the portal (docs/ppap-plan.md PP4): staff ask, the customer sees named fields only and answers (approved, interim approved,
 * rejected), the answer is recorded as the submission's own decision, suppliers and other customers are refused. The rules are in supabase/tests/portal_ppap.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('f4b');
const u = (tail: string) => `${'f4b'.padEnd(8, '0')}-0000-0000-0000-${tail.padStart(12, '0')}`;
const sam = u('e1');
const cus = u('e4');
const cus2 = u('e5');
const ELI = u('e6');
const QUINN = u('e7');
let app: INestApplication;
let admin: Pool;
let partyC: string;
const ctx: Record<string, string> = {};
const api = () => request(app.getHttpServer());
const staff = async (user = ids.ownerA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': ids.orgA });
const external = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}`, 'X-Organisation-Id': ids.orgA });
const bare = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}` });
const day = (offset = 0) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

async function addMember(user: string, email: string, role: string, first: string, surname: string) {
  await admin.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [user, email]);
  await admin.query(`update public.profiles set first_name = $2, surname = $3 where id = $1`, [user, first, surname]);
  const m = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, user]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = $3`, [ids.orgA, m.rows[0].id, role]);
}

/** Makes a level-1 submission for a part (typed by Eli), signs the warrant (Quinn), marks it ready and sends it. */
async function sent(part: string) {
  const made = await api().post('/api/v1/ppaps').set(await staff(ELI)).send({ partId: part, customerId: ctx.customer, reason: 'new_part', ownerId: ELI }).expect(201);
  const id = made.body.id as string;
  await api().put(`/api/v1/ppaps/${id}/psw`).set(await staff(ELI)).send({ partWeight: 1.25, weightUnit: 'kg', purchaseOrder: 'PO-1', resultsMeetRequirements: true }).expect(200);
  await api().post(`/api/v1/ppaps/${id}/psw/sign`).set(await staff(QUINN)).send({ title: 'Quality Manager', phone: '01234 567890' }).expect(200);
  await api().post(`/api/v1/ppaps/${id}/ready`).set(await staff(ELI)).expect(200);
  await api().post(`/api/v1/ppaps/${id}/submit`).set(await staff(ELI)).send({ sentOn: day(-1), how: 'Customer portal' }).expect(200);
  return id;
}

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pp4');
  for (const [id, email] of [[sam, 'sam@acme-pp4.test'], [cus, 'cus@wayne-pp4.test'], [cus2, 'cus2@other-pp4.test']]) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now()) on conflict do nothing`, [id, email]);
  }
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  await addMember(ELI, 'eli@pp4.test', 'quality_engineer', 'Eli', 'Engineer');
  await addMember(QUINN, 'quinn@pp4.test', 'quality_manager', 'Quinn', 'Manager');
  const h = await staff();
  await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ACME', 'Acme Castings') on conflict do nothing`, [ids.orgA]);
  await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'WAYNE', 'Wayne Ltd'), ($1, 'OTHER', 'Other Co') on conflict do nothing`, [ids.orgA]);
  const one = async (s: string) => (await admin.query(s, [ids.orgA])).rows[0].id as string;
  const acme = await one(`select id from public.suppliers where organisation_id = $1 and code = 'ACME'`);
  ctx.customer = await one(`select id from public.customers where organisation_id = $1 and code = 'WAYNE'`);
  const other = await one(`select id from public.customers where organisation_id = $1 and code = 'OTHER'`);
  await api().put(`/api/v1/ppap-customer-rules/${ctx.customer}`).set(h).send({ defaultLevel: 1 }).expect(200);
  for (const [key, n] of [['a', 'P4B-100'], ['b', 'P4B-200'], ['c', 'P4B-300'], ['d', 'P4B-400']]) {
    const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: n, name: `Part ${n}`, initialRevision: { revision: 'A' } }).expect(201)).body;
    ctx[`part_${key}`] = part.id;
    await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/release`).set(h).expect(200);
    await admin.query(`insert into public.part_customers (organisation_id, part_id, customer_id, customer_part_number, is_primary) values ($1, $2, $3, $4, true)`, [ids.orgA, part.id, ctx.customer, `W-${key}`]);
  }
  await api().put('/api/v1/external-access/settings').set(h).send({ enabled: true, requireMfa: false }).expect(200);
  const party = async (kind: 'supplier' | 'customer', partyId: string, name: string) =>
    (await api().put('/api/v1/external-access/parties').set(h).send({ kind, partyId, enabled: true }).expect(200)).body.parties.find((p: { name: string }) => p.name === name).partyId as string;
  const pA = await party('supplier', acme, 'Acme Castings');
  partyC = await party('customer', ctx.customer, 'Wayne Ltd');
  const pO = await party('customer', other, 'Other Co');
  for (const [p, email, user] of [[pA, 'sam@acme-pp4.test', sam], [partyC, 'cus@wayne-pp4.test', cus], [pO, 'cus2@other-pp4.test', cus2]] as const) {
    await api().post('/api/v1/external-access/people').set(h).send({ partyId: p, email, role: 'admin' }).expect(201);
    const inv = (await api().get('/api/v1/portal/invitations').set(await bare(user))).body.data[0];
    await api().post(`/api/v1/portal/invitations/${inv.id}/accept`).set(await bare(user)).expect(201);
  }
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('a customer answers a PPAP submission in the portal', () => {
  let requestId: string;

  it('refuses a submission that has not been sent, then lets staff ask once', async () => {
    const draft = (await api().post('/api/v1/ppaps').set(await staff(ELI)).send({ partId: ctx.part_d, customerId: ctx.customer, reason: 'new_part', ownerId: ELI }).expect(201)).body.id;
    await api().post(`/api/v1/ppaps/${draft}/customer-requests`).set(await staff(ELI)).send({}).expect(409);
    ctx.s1 = await sent(ctx.part_a);
    const before = await api().get(`/api/v1/ppaps/${ctx.s1}/customer-requests`).set(await staff()).expect(200);
    expect(before.body.customer).toMatchObject({ name: 'Wayne Ltd' });
    expect(before.body.data).toEqual([]);
    const asked = await api().post(`/api/v1/ppaps/${ctx.s1}/customer-requests`).set(await staff(ELI)).send({ note: 'Please approve the submission.' }).expect(201);
    requestId = asked.body.data[0].id;
    expect(asked.body.data[0]).toMatchObject({ status: 'pending', customer: 'Wayne Ltd', requestNote: 'Please approve the submission.' });
    await api().post(`/api/v1/ppaps/${ctx.s1}/customer-requests`).set(await staff(ELI)).send({}).expect(409);
  });

  it('keeps the staff routes to staff', async () => {
    await api().get(`/api/v1/ppaps/${ctx.s1}/customer-requests`).set(await external(cus)).expect(404);
    await api().post(`/api/v1/ppaps/${ctx.s1}/customer-requests`).set(await external(cus)).send({}).expect(404);
  });

  it('shows the customer the submission in named fields only', async () => {
    const list = await api().get('/api/v1/portal/ppaps').set(await external(cus)).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(Object.keys(list.body.data[0]).sort()).toEqual([
      'answeredAt', 'canDecide', 'id', 'level', 'partName', 'partNumber', 'reference', 'requestedAt', 'status', 'submissionStatus', 'theirPartNumber',
    ]);
    const one = await api().get(`/api/v1/portal/ppaps/${requestId}`).set(await external(cus)).expect(200);
    expect(Object.keys(one.body).sort()).toEqual([
      'answeredAt', 'answeredBy', 'canDecide', 'contact', 'decision', 'decisionExpiresOn', 'decisionNote', 'elements', 'id', 'interimExpiresOn', 'level', 'partName', 'partNumber', 'reason',
      'reference', 'requestNote', 'requestedAt', 'revision', 'sentOn', 'status', 'submissionStatus', 'theirPartNumber', 'warrant', 'yourReference',
    ]);
    expect(Object.keys(one.body.warrant).sort()).toEqual([
      'declaration', 'engineeringChangeLevel', 'partWeight', 'purchaseOrder', 'resultsMeetRequirements', 'signedOn', 'signerName', 'signerPhone', 'signerTitle', 'weightUnit',
    ]);
    expect(Object.keys(one.body.elements[0]).sort()).toEqual(['name', 'provided', 'requirement', 'waived']);
    expect(one.body).toMatchObject({ partNumber: 'P4B-100', theirPartNumber: 'W-a', revision: 'A', level: 1, canDecide: true, status: 'pending' });
    expect(one.body.warrant).toMatchObject({ partWeight: 1.25, weightUnit: 'kg', signerName: 'Quinn Manager' });
    const home = await api().get('/api/v1/portal/home').set(await external(cus)).expect(200);
    expect(home.body.ppapsToAnswer).toBe(1);
  });

  it('refuses a supplier and another customer', async () => {
    await api().get('/api/v1/portal/ppaps').set(await external(sam)).expect(404);
    await api().get(`/api/v1/portal/ppaps/${requestId}`).set(await external(sam)).expect(404);
    expect((await api().get('/api/v1/portal/ppaps').set(await external(cus2)).expect(200)).body.data).toEqual([]);
    await api().get(`/api/v1/portal/ppaps/${requestId}`).set(await external(cus2)).expect(404);
    await api().post(`/api/v1/portal/ppaps/${requestId}/decide`).set(await external(cus2)).send({ kind: 'approved' }).expect(404);
  });

  it('holds the decision\'s own rules for the customer', async () => {
    const h = await external(cus);
    await api().post(`/api/v1/portal/ppaps/${requestId}/decide`).set(h).send({ kind: 'withdrawn' }).expect(400);
    await api().post(`/api/v1/portal/ppaps/${requestId}/decide`).set(h).send({ kind: 'approved', nonsense: 1 }).expect(400);
    await api().post(`/api/v1/portal/ppaps/${requestId}/decide`).set(h).send({ kind: 'rejected' }).expect(409);
    await api().post(`/api/v1/portal/ppaps/${requestId}/decide`).set(h).send({ kind: 'interim_approved', note: 'Conditions apply' }).expect(409);
    await api().post(`/api/v1/portal/ppaps/${requestId}/decide`).set(h).send({ kind: 'approved', expiresOn: day(30) }).expect(409);
    const detail = await api().get(`/api/v1/ppaps/${ctx.s1}`).set(await staff()).expect(200);
    expect(detail.body.status).toBe('submitted');
  });

  it('records an interim approval as the submission\'s decision, then an approval', async () => {
    const h = await external(cus);
    const interim = await api().post(`/api/v1/portal/ppaps/${requestId}/decide`).set(h).send({ kind: 'interim_approved', note: 'Until our line trial is done.', reference: 'WAYNE-INT-1', expiresOn: day(60) }).expect(200);
    expect(interim.body).toMatchObject({ status: 'answered', decision: 'interim_approved', yourReference: 'WAYNE-INT-1', canDecide: false });
    await api().post(`/api/v1/portal/ppaps/${requestId}/decide`).set(h).send({ kind: 'approved' }).expect(409);
    const detail = await api().get(`/api/v1/ppaps/${ctx.s1}`).set(await staff()).expect(200);
    expect(detail.body.status).toBe('interim_approved');
    expect(detail.body.decisions.map((d: { kind: string }) => d.kind)).toEqual(['submitted', 'interim_approved']);
    // staff ask again; the customer approves with their own reference
    const again = await api().post(`/api/v1/ppaps/${ctx.s1}/customer-requests`).set(await staff(ELI)).send({}).expect(201);
    expect(again.body.data.map((r: { status: string }) => r.status)).toEqual(['pending', 'answered']);
    const second = again.body.data[0].id as string;
    await api().post(`/api/v1/portal/ppaps/${second}/decide`).set(h).send({ kind: 'approved', note: 'Fine after our trial.', reference: 'WAYNE-PPAP-9' }).expect(200);
    const done = await api().get(`/api/v1/ppaps/${ctx.s1}`).set(await staff()).expect(200);
    expect(done.body.status).toBe('approved');
    const requests = await api().get(`/api/v1/ppaps/${ctx.s1}/customer-requests`).set(await staff()).expect(200);
    expect(requests.body.data[0]).toMatchObject({ status: 'answered', decision: 'approved', customerReference: 'WAYNE-PPAP-9', answeredBy: expect.any(String) });
    await api().post(`/api/v1/ppaps/${ctx.s1}/customer-requests`).set(await staff(ELI)).send({}).expect(409);
  });

  it('records a rejection with a reason, and tells staff', async () => {
    const id = await sent(ctx.part_b);
    const asked = await api().post(`/api/v1/ppaps/${id}/customer-requests`).set(await staff(ELI)).send({}).expect(201);
    const rid = asked.body.data[0].id as string;
    await api().post(`/api/v1/portal/ppaps/${rid}/decide`).set(await external(cus)).send({ kind: 'rejected', note: 'The weight is wrong on the warrant.' }).expect(200);
    const detail = await api().get(`/api/v1/ppaps/${id}`).set(await staff()).expect(200);
    expect(detail.body.status).toBe('rejected');
    const told = await admin.query(`select count(*)::int as n from public.portal_activity where kind = 'ppap_rejected' and record_id = $1 and record_kind = 'ppap'`, [id]);
    expect(told.rows[0].n).toBe(1);
  });

  it('lets staff withdraw a waiting request, which the customer no longer sees', async () => {
    const id = await sent(ctx.part_c);
    const asked = await api().post(`/api/v1/ppaps/${id}/customer-requests`).set(await staff(ELI)).send({}).expect(201);
    const rid = asked.body.data[0].id as string;
    await api().post(`/api/v1/ppap-customer-requests/${rid}/withdraw`).set(await staff(ELI)).send({ reason: 'x' }).expect(400);
    const done = await api().post(`/api/v1/ppap-customer-requests/${rid}/withdraw`).set(await staff(ELI)).send({ reason: 'Raised too early' }).expect(200);
    expect(done.body.data[0]).toMatchObject({ status: 'withdrawn', withdrawnReason: 'Raised too early' });
    await api().post(`/api/v1/ppap-customer-requests/${rid}/withdraw`).set(await staff(ELI)).send({ reason: 'Again for no reason' }).expect(409);
    await api().get(`/api/v1/portal/ppaps/${rid}`).set(await external(cus)).expect(404);
    await api().post(`/api/v1/ppap-customer-requests/${ids.orgB}/withdraw`).set(await staff(ELI)).send({ reason: 'Not mine to withdraw' }).expect(404);
  });
});
