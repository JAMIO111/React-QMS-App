/**
 * A customer sends a change request and a supplier notifies a process change through the portal (docs/change-management-plan.md CH6a): each becomes a draft
 * change that staff see with where it came from; only the party's own parts can be named; retries are safe; strangers are refused. The rules are in
 * supabase/tests/portal_change_requests.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('9c80');
const u = (tail: string) => `${'9c80'.padEnd(8, '0')}-0000-0000-0000-${tail.padStart(12, '0')}`;
const sam = u('e1');
const cus = u('e4');
let app: INestApplication;
let admin: Pool;
let customerPart: string;
let supplierPart: string;
let otherPart: string;
const wanted = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const api = () => request(app.getHttpServer());
const staff = async () => ({ Authorization: `Bearer ${await token(ids.ownerA)}`, 'X-Organisation-Id': ids.orgA });
const external = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}`, 'X-Organisation-Id': ids.orgA });
const bare = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}` });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ch6');
  for (const [id, email] of [[sam, 'sam@acme-ch6.test'], [cus, 'cus@wayne-ch6.test']]) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now()) on conflict do nothing`, [id, email]);
  }
  await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ACME', 'Acme Castings') on conflict do nothing`, [ids.orgA]);
  await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'WAYNE', 'Wayne Ltd'), ($1, 'OTHER', 'Other Co') on conflict do nothing`, [ids.orgA]);
  await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'C6-100', 'Bracket'), ($1, 'C6-200', 'Housing'), ($1, 'C6-300', 'Casting') on conflict do nothing`, [ids.orgA]);
  const one = async (sql: string) => (await admin.query(sql, [ids.orgA])).rows[0].id as string;
  const acme = await one(`select id from public.suppliers where organisation_id = $1 and code = 'ACME'`);
  const wayne = await one(`select id from public.customers where organisation_id = $1 and code = 'WAYNE'`);
  const other = await one(`select id from public.customers where organisation_id = $1 and code = 'OTHER'`);
  customerPart = await one(`select id from public.parts where organisation_id = $1 and part_number = 'C6-100'`);
  otherPart = await one(`select id from public.parts where organisation_id = $1 and part_number = 'C6-200'`);
  supplierPart = await one(`select id from public.parts where organisation_id = $1 and part_number = 'C6-300'`);
  await admin.query(`insert into public.part_customers (organisation_id, part_id, customer_id, customer_part_number, is_primary) values ($1, $2, $3, 'W-1', true), ($1, $4, $5, null, true)`, [ids.orgA, customerPart, wayne, otherPart, other]);
  await admin.query(`insert into public.supplier_product_links (organisation_id, supplier_id, kind, part_id, supplier_part_number) values ($1, $2, 'part', $3, 'AC-3')`, [ids.orgA, acme, supplierPart]);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  await api().put('/api/v1/external-access/settings').set(await staff()).send({ enabled: true, requireMfa: false }).expect(200);
  const a = await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: acme, enabled: true }).expect(200);
  const c = await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'customer', partyId: wayne, enabled: true }).expect(200);
  const partyA = a.body.parties.find((p: { name: string }) => p.name === 'Acme Castings').partyId;
  const partyC = c.body.parties.find((p: { name: string }) => p.name === 'Wayne Ltd').partyId;
  for (const [party, email, user] of [[partyA, 'sam@acme-ch6.test', sam], [partyC, 'cus@wayne-ch6.test', cus]] as const) {
    await api().post('/api/v1/external-access/people').set(await staff()).send({ partyId: party, email, role: 'admin' }).expect(201);
    const inv = (await api().get('/api/v1/portal/invitations').set(await bare(user))).body.data[0];
    await api().post(`/api/v1/portal/invitations/${inv.id}/accept`).set(await bare(user)).expect(201);
  }
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('portal change requests', () => {
  it('offers a customer the parts we make for them and a supplier the parts they supply', async () => {
    const c = await api().get('/api/v1/portal/change-request-parts').set(await external(cus)).expect(200);
    expect(c.body.data.map((p: { partNumber: string }) => p.partNumber)).toEqual(['C6-100']);
    expect(c.body.data[0].theirPartNumber).toBe('W-1');
    const s = await api().get('/api/v1/portal/change-request-parts').set(await external(sam)).expect(200);
    expect(s.body.data.map((p: { partNumber: string }) => p.partNumber)).toEqual(['C6-300']);
  });

  it('turns a customer’s request into a draft change, and a retry gives the same one', async () => {
    const body = { title: 'Tighten the bend radius', description: 'Please reduce the bend radius from 3 mm to 2 mm.', reason: 'Fits our new assembly', partId: customerPart, wantedOn: wanted, clientKey: 'client-key-ch6-1' };
    const first = await api().post('/api/v1/portal/change-requests').set(await external(cus)).send(body).expect(201);
    expect(first.body.created).toBe(true);
    const again = await api().post('/api/v1/portal/change-requests').set(await external(cus)).send(body).expect(201);
    expect(again.body).toEqual({ id: first.body.id, created: false });
    const list = await api().get('/api/v1/portal/change-requests').set(await external(cus)).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ kind: 'customer_request', status: 'received', partNumber: 'C6-100', wantedOn: wanted, raisedByMe: true });
    expect(Object.keys(list.body.data[0]).sort()).toEqual(['description', 'id', 'kind', 'partName', 'partNumber', 'raisedAt', 'raisedByMe', 'reference', 'status', 'title', 'wantedOn']);
    const change = await admin.query(`select stage, origin_kind from public.change_requests where reference = $1 and organisation_id = $2`, [list.body.data[0].reference, ids.orgA]);
    expect(change.rows[0]).toMatchObject({ stage: 'draft', origin_kind: 'portal_request' });
  });

  it('shows staff where the change came from, and a supplier a request of its own', async () => {
    await api().post('/api/v1/portal/change-requests').set(await external(sam)).send({ title: 'New furnace', description: 'We are moving this casting to a new furnace in March.', partId: supplierPart }).expect(201);
    const mine = await api().get('/api/v1/portal/change-requests').set(await external(sam)).expect(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].kind).toBe('supplier_notice');
    const list = await api().get('/api/v1/changes?originKind=portal_request&stage=all').set(await staff()).expect(200);
    expect(list.body.data.length).toBeGreaterThanOrEqual(2);
    const one = list.body.data.find((c: { title: string }) => c.title === 'Tighten the bend radius');
    const detail = await api().get(`/api/v1/changes/${one.id}`).set(await staff()).expect(200);
    expect(detail.body.origin).toMatchObject({ kind: 'portal_request', reference: 'Customer request', readable: true });
    expect(detail.body.origin.name).toContain('Wayne Ltd');
    expect(detail.body.links.map((l: { kind: string }) => l.kind).sort()).toEqual(['customer', 'part']);
  });

  it('refuses a part that is not theirs, a malformed request and an unknown field', async () => {
    await api().post('/api/v1/portal/change-requests').set(await external(cus)).send({ title: 'Not mine', description: 'This is another customer’s part.', partId: otherPart }).expect(409);
    await api().post('/api/v1/portal/change-requests').set(await external(sam)).send({ title: 'Not supplied', description: 'A part this supplier does not supply.', partId: customerPart }).expect(409);
    await api().post('/api/v1/portal/change-requests').set(await external(cus)).send({ title: 'xx', description: 'short' }).expect(400);
    await api().post('/api/v1/portal/change-requests').set(await external(cus)).send({ title: 'Extra field', description: 'A long enough description.', urgency: 'expedited' }).expect(400);
  });

  it('is for people with portal access only', async () => {
    await api().get('/api/v1/portal/change-requests').set(await staff()).expect(404);
    await api().get('/api/v1/portal/change-requests').set(await external(u('ff'))).expect(404);
  });

  it('tells staff when one is sent, and can be stopped for a customer with the tile', async () => {
    const told = await admin.query(`select count(*)::int as n from public.portal_activity where kind = 'change_requested' and organisation_id = $1`, [ids.orgA]);
    expect(told.rows[0].n).toBeGreaterThanOrEqual(2);
    const wayne = (await admin.query(`select id from public.customers where organisation_id = $1 and code = 'WAYNE'`, [ids.orgA])).rows[0].id as string;
    await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'customer', partyId: wayne, enabled: true, tiles: { changes: false } }).expect(200);
    await api().post('/api/v1/portal/change-requests').set(await external(cus)).send({ title: 'Blocked request', description: 'The tile has been switched off for us.' }).expect(409);
  });
});
