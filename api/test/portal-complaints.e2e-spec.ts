/**
 * A customer raises a complaint in the portal (docs/external-portal-plan.md PT5a) through the API: it becomes a draft non-conformance, only the
 * customer's own parts can be named, retries are safe, suppliers and strangers are refused. The rules are in supabase/tests/portal_complaints.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('9c78');
const u = (tail: string) => `${'9c78'.padEnd(8, '0')}-0000-0000-0000-${tail.padStart(12, '0')}`;
const sam = u('e1');
const cus = u('e4');
let app: INestApplication;
let admin: Pool;
let partId: string;
let otherPartId: string;
const api = () => request(app.getHttpServer());
const staff = async () => ({ Authorization: `Bearer ${await token(ids.ownerA)}`, 'X-Organisation-Id': ids.orgA });
const external = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}`, 'X-Organisation-Id': ids.orgA });
const bare = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}` });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pt5');
  for (const [id, email] of [[sam, 'sam@acme-pt5.test'], [cus, 'cus@wayne-pt5.test']]) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now()) on conflict do nothing`, [id, email]);
  }
  await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ACME', 'Acme Castings') on conflict do nothing`, [ids.orgA]);
  await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'WAYNE', 'Wayne Ltd'), ($1, 'OTHER', 'Other Co') on conflict do nothing`, [ids.orgA]);
  await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'P5-100', 'Bracket'), ($1, 'P5-200', 'Housing') on conflict do nothing`, [ids.orgA]);
  const one = async (sql: string) => (await admin.query(sql, [ids.orgA])).rows[0].id as string;
  const acme = await one(`select id from public.suppliers where organisation_id = $1 and code = 'ACME'`);
  const wayne = await one(`select id from public.customers where organisation_id = $1 and code = 'WAYNE'`);
  const other = await one(`select id from public.customers where organisation_id = $1 and code = 'OTHER'`);
  partId = await one(`select id from public.parts where organisation_id = $1 and part_number = 'P5-100'`);
  otherPartId = await one(`select id from public.parts where organisation_id = $1 and part_number = 'P5-200'`);
  await admin.query(`insert into public.part_customers (organisation_id, part_id, customer_id, customer_part_number, is_primary) values ($1, $2, $3, 'W-1', true), ($1, $4, $5, null, true)`, [ids.orgA, partId, wayne, otherPartId, other]);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  await api().put('/api/v1/external-access/settings').set(await staff()).send({ enabled: true, requireMfa: false }).expect(200);
  const a = await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: acme, enabled: true }).expect(200);
  const c = await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'customer', partyId: wayne, enabled: true }).expect(200);
  const partyA = a.body.parties.find((p: { name: string }) => p.name === 'Acme Castings').partyId;
  const partyC = c.body.parties.find((p: { name: string }) => p.name === 'Wayne Ltd').partyId;
  for (const [party, email, user] of [[partyA, 'sam@acme-pt5.test', sam], [partyC, 'cus@wayne-pt5.test', cus]] as const) {
    await api().post('/api/v1/external-access/people').set(await staff()).send({ partyId: party, email, role: 'admin' }).expect(201);
    const inv = (await api().get('/api/v1/portal/invitations').set(await bare(user))).body.data[0];
    await api().post(`/api/v1/portal/invitations/${inv.id}/accept`).set(await bare(user)).expect(201);
  }
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('portal complaints', () => {
  it('offers only the customer’s own parts', async () => {
    const r = await api().get('/api/v1/portal/complaint-parts').set(await external(cus)).expect(200);
    expect(r.body.data.map((p: { partNumber: string }) => p.partNumber)).toEqual(['P5-100']);
    expect(r.body.data[0].customerPartNumber).toBe('W-1');
  });

  it('turns a complaint into a draft customer non-conformance, and a retry gives the same one', async () => {
    const body = { title: 'Bracket cracked on arrival', description: 'Three brackets had cracks at the bend.', partId, quantity: 3, lot: 'LOT-9', customerReference: 'RMA-1', clientKey: 'client-key-e2e-1' };
    const first = await api().post('/api/v1/portal/complaints').set(await external(cus)).send(body).expect(201);
    expect(first.body.created).toBe(true);
    const again = await api().post('/api/v1/portal/complaints').set(await external(cus)).send(body).expect(201);
    expect(again.body).toEqual({ id: first.body.id, created: false });
    const list = await api().get('/api/v1/portal/complaints').set(await external(cus)).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ status: 'received', partNumber: 'P5-100', quantity: 3, lot: 'LOT-9', raisedByMe: true });
    expect(Object.keys(list.body.data[0]).sort()).toEqual(['customerReference', 'description', 'detectedOn', 'files', 'id', 'lot', 'partName', 'partNumber', 'quantity', 'raisedAt', 'raisedByMe', 'reference', 'shareId', 'status', 'title']);
    const nc = await admin.query(`select stage, source, severity, category_id from public.nonconformances where reference = $1 and organisation_id = $2`, [list.body.data[0].reference, ids.orgA]);
    expect(nc.rows[0]).toMatchObject({ stage: 'draft', source: 'customer', severity: null, category_id: null });
  });

  it('refuses a part that is not theirs and a malformed complaint', async () => {
    await api().post('/api/v1/portal/complaints').set(await external(cus)).send({ title: 'Not mine', description: 'This is another customer’s part.', partId: otherPartId }).expect(409);
    await api().post('/api/v1/portal/complaints').set(await external(cus)).send({ title: 'xx', description: 'short' }).expect(400);
    await api().post('/api/v1/portal/complaints').set(await external(cus)).send({ title: 'Extra field', description: 'A long enough description.', severity: 'critical' }).expect(400);
  });

  it('is for customers only', async () => {
    await api().get('/api/v1/portal/complaints').set(await external(sam)).expect(404);
    await api().post('/api/v1/portal/complaints').set(await external(sam)).send({ title: 'From a supplier', description: 'A long enough description.' }).expect(404);
    await api().get('/api/v1/portal/complaint-parts').set(await external(ids.ownerB)).expect(404);
  });

  it('gives a customer their own quality figures as counts only, and a supplier none', async () => {
    const r = await api().get('/api/v1/portal/figures').set(await external(cus)).expect(200);
    expect(Object.keys(r.body).sort()).toEqual(['available', 'capas', 'ncs', 'period']);
    expect(Object.keys(r.body.ncs).sort()).toEqual(['averageDaysToClose', 'averageOpenDays', 'closedInPeriod', 'critical', 'major', 'minor', 'oldestOpenDays', 'open', 'raised']);
    expect(r.body.period.days).toBe(90);
    await api().get('/api/v1/portal/figures?days=45').set(await external(cus)).expect(400);
    await api().get('/api/v1/portal/figures').set(await external(sam)).expect(404);
  });
});
