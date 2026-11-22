/**
 * The portal's NC and 8D registers (docs/external-portal-plan.md PT6) through the API: one row per record shared with the caller's own party, with
 * named fields only; another customer, an unshared record and a withdrawn share are never listed. The rules are in supabase/tests/portal_registers.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { categoryId, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('9c7d');
const u = (tail: string) => `${'9c7d'.padEnd(8, '0')}-0000-0000-0000-${tail.padStart(12, '0')}`;
const sam = u('e1');
const cus = u('e4');
const cus2 = u('e5');
let app: INestApplication;
let admin: Pool;
let shareS: string;
let shareCapa: string;
const api = () => request(app.getHttpServer());
const staff = async () => ({ Authorization: `Bearer ${await token(ids.ownerA)}`, 'X-Organisation-Id': ids.orgA });
const external = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}`, 'X-Organisation-Id': ids.orgA });
const bare = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}` });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pt6');
  for (const [id, email] of [[sam, 'sam@acme-pt6.test'], [cus, 'cus@wayne-pt6.test'], [cus2, 'cus2@other-pt6.test']]) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now()) on conflict do nothing`, [id, email]);
  }
  await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ACME', 'Acme Castings') on conflict do nothing`, [ids.orgA]);
  await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'WAYNE', 'Wayne Ltd'), ($1, 'OTHER', 'Other Co') on conflict do nothing`, [ids.orgA]);
  const one = async (s: string) => (await admin.query(s, [ids.orgA])).rows[0].id as string;
  const acme = await one(`select id from public.suppliers where organisation_id = $1 and code = 'ACME'`);
  const wayne = await one(`select id from public.customers where organisation_id = $1 and code = 'WAYNE'`);
  const other = await one(`select id from public.customers where organisation_id = $1 and code = 'OTHER'`);
  const cat = await categoryId(admin, ids.orgA);
  const nc = async (ref: string, source: string, col: 'supplier_id' | 'customer_id', party: string, title: string) =>
    (await admin.query(
      `insert into public.nonconformances (organisation_id, reference, source, stage, category_id, title, severity, quantity_affected, site_id, ${col}, lot_number)
       values ($1, $2, $3, 'open', $4, $5, 'major', 4, $6, $7, 'L-77') returning id`, [ids.orgA, ref, source, cat, title, ids.siteA, party])).rows[0].id as string;
  const ncS = await nc('PT6-E2E-1', 'supplier', 'supplier_id', acme, 'Bar stock out of size');
  await nc('PT6-E2E-2', 'supplier', 'supplier_id', acme, 'Not shared');
  const ncC = await nc('PT6-E2E-3', 'customer', 'customer_id', wayne, 'Bracket cracked');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  await api().put('/api/v1/external-access/settings').set(await staff()).send({ enabled: true, requireMfa: false }).expect(200);
  const party = async (kind: 'supplier' | 'customer', partyId: string, name: string) =>
    (await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind, partyId, enabled: true }).expect(200)).body.parties.find((p: { name: string }) => p.name === name).partyId as string;
  const pA = await party('supplier', acme, 'Acme Castings');
  const pC = await party('customer', wayne, 'Wayne Ltd');
  const pO = await party('customer', other, 'Other Co');
  for (const [p, email, user] of [[pA, 'sam@acme-pt6.test', sam], [pC, 'cus@wayne-pt6.test', cus], [pO, 'cus2@other-pt6.test', cus2]] as const) {
    await api().post('/api/v1/external-access/people').set(await staff()).send({ partyId: p, email, role: 'admin' }).expect(201);
    const inv = (await api().get('/api/v1/portal/invitations').set(await bare(user))).body.data[0];
    await api().post(`/api/v1/portal/invitations/${inv.id}/accept`).set(await bare(user)).expect(201);
  }
  shareS = (await api().post('/api/v1/external-access/shares').set(await staff()).send({ kind: 'ncr', recordId: ncS, partyId: pA }).expect(201)).body.data[0].id;
  await api().post('/api/v1/external-access/shares').set(await staff()).send({ kind: 'ncr', recordId: ncC, partyId: pC }).expect(201);
  const capa = (await api().post('/api/v1/capas').set(await staff()).send({ fromNcrId: ncS }).expect(201)).body.data?.id ?? (await admin.query(`select id from public.capas where organisation_id = $1`, [ids.orgA])).rows[0].id;
  shareCapa = (await api().post('/api/v1/external-access/shares').set(await staff()).send({ kind: 'capa', recordId: capa, partyId: pA }).expect(201)).body.data[0].id;
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('portal registers', () => {
  it('lists the supplier its own shared NC with named fields only', async () => {
    const r = await api().get('/api/v1/portal/ncrs').set(await external(sam)).expect(200);
    expect(r.body.data).toHaveLength(1);
    expect(Object.keys(r.body.data[0]).sort()).toEqual([
      'closurePending', 'comments', 'customerReference', 'detectedAt', 'id', 'lastCommentAt', 'lotNumber', 'newComments', 'partName', 'partNumber',
      'purchaseOrder', 'quantityAffected', 'reference', 'severity', 'sharedAt', 'stage', 'title', 'viewed',
    ]);
    expect(r.body.data[0]).toMatchObject({ id: shareS, reference: 'PT6-E2E-1', lotNumber: 'L-77', quantityAffected: 4, viewed: false });
  });

  it('lists the supplier its shared 8D, and the customer none', async () => {
    const r = await api().get('/api/v1/portal/capas').set(await external(sam)).expect(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].id).toBe(shareCapa);
    expect(Object.keys(r.body.data[0]).sort()).toEqual(['closedAt', 'closurePending', 'comments', 'id', 'lastCommentAt', 'newComments', 'reference', 'severity', 'sharedAt', 'stage', 'startedAt', 'title', 'viewed']);
    expect((await api().get('/api/v1/portal/capas').set(await external(cus)).expect(200)).body.data).toHaveLength(0);
  });

  it('lists a customer only its own NC, and another customer nothing', async () => {
    expect((await api().get('/api/v1/portal/ncrs').set(await external(cus)).expect(200)).body.data.map((n: { reference: string }) => n.reference)).toEqual(['PT6-E2E-3']);
    expect((await api().get('/api/v1/portal/ncrs').set(await external(cus2)).expect(200)).body.data).toHaveLength(0);
  });

  it('refuses a staff member without portal access and a missing organisation', async () => {
    await api().get('/api/v1/portal/ncrs').set(await staff()).expect(404);
    await api().get('/api/v1/portal/ncrs').set(await bare(sam)).expect(400);
  });

  it('drops a record from the register the moment sharing stops', async () => {
    await api().post(`/api/v1/external-access/shares/${shareS}/withdraw`).set(await staff()).send({ reason: 'No longer needed' }).expect(201);
    expect((await api().get('/api/v1/portal/ncrs').set(await external(sam)).expect(200)).body.data).toHaveLength(0);
  });
});
