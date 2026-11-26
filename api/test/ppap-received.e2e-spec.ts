/**
 * PPAP (PP5a) through the API: a package a supplier sent, recorded by staff. It names a supplier and no customer, has no warrant of ours (the supplier's own is a file),
 * is recorded as received, and our decision is recorded like a customer's. The rules are in supabase/tests/ppap_received.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('f5a');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': ids.orgA });
const ctx: Record<string, string> = {};
const day = (offset = 0) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pr');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  ctx.supplier = (await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'PR-S1', 'Acme Castings') returning id`, [ids.orgA])).rows[0].id;
  ctx.customer = (await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'PR-C1', 'Wayne Ltd') returning id`, [ids.orgA])).rows[0].id;
  for (const [key, n] of [['a', 'PR-100'], ['b', 'PR-200']]) {
    const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: n, name: `Part ${n}`, initialRevision: { revision: 'A' } }).expect(201)).body;
    ctx[`part_${key}`] = part.id;
    await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/release`).set(h).expect(200);
  }
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('a package received from a supplier', () => {
  it('names a supplier and no customer, whichever way it is mixed up', async () => {
    const h = await as(ids.ownerA);
    const base = { partId: ctx.part_a, reason: 'new_part' };
    await api().post('/api/v1/ppaps').set(h).send({ ...base, direction: 'received' }).expect(400);
    await api().post('/api/v1/ppaps').set(h).send({ ...base, direction: 'received', supplierId: ctx.supplier, customerId: ctx.customer }).expect(400);
    await api().post('/api/v1/ppaps').set(h).send({ ...base, customerId: ctx.customer, supplierId: ctx.supplier }).expect(400);
    await api().post('/api/v1/ppaps').set(h).send({ ...base, direction: 'received', supplierId: ids.orgB }).expect(409);
  });

  it('starts at level 1 with a supplier and its 18 elements, and needs the supplier\'s warrant as a file', async () => {
    const h = await as(ids.ownerA);
    const made = await api().post('/api/v1/ppaps').set(h).send({ partId: ctx.part_a, direction: 'received', supplierId: ctx.supplier, reason: 'new_part', level: 1 }).expect(201);
    ctx.p1 = made.body.id;
    expect(made.body).toMatchObject({ direction: 'received', level: 1, customer: null, supplier: { name: 'Acme Castings' } });
    expect(made.body.elements).toHaveLength(18);
    expect(made.body.problems).toEqual(['Part Submission Warrant: add evidence, or ask an approver to waive it']);
    const warrant = made.body.elements.find((e: { key: string }) => e.key === 'part_submission_warrant');
    const refused = await api().put(`/api/v1/ppaps/${ctx.p1}/psw`).set(h).send({ partWeight: 1 }).expect(409);
    expect(refused.body.error.code).toBe('ppap_rule');
    await api().post(`/api/v1/ppap-elements/${warrant.id}/files`).set(h).send({ storagePath: `${ids.orgA}/ppap/${ctx.p1}/warrant.pdf`, fileName: 'warrant.pdf', sizeBytes: 1000 }).expect(201);
    const ready = await api().patch(`/api/v1/ppap-elements/${warrant.id}`).set(h).send({ status: 'ready' }).expect(200);
    expect(ready.body.problems).toEqual([]);
  });

  it('is recorded as received, then decided by us', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/ppaps/${ctx.p1}/ready`).set(h).expect(200);
    const sent = await api().post(`/api/v1/ppaps/${ctx.p1}/submit`).set(h).send({ sentOn: day(-2), how: 'Emailed' }).expect(200);
    expect(sent.body.status).toBe('submitted');
    const decided = await api().post(`/api/v1/ppaps/${ctx.p1}/decisions`).set(h).send({ kind: 'approved', decidedOn: day(), theirReference: 'OUR-OK-1' }).expect(200);
    expect(decided.body.status).toBe('approved');
    expect(decided.body.decisions.map((d: { kind: string }) => d.kind)).toEqual(['submitted', 'approved']);
  });

  it('lists both directions, and filters by direction and by supplier', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/ppaps').set(h).send({ partId: ctx.part_b, customerId: ctx.customer, reason: 'new_part' }).expect(201);
    const all = await api().get('/api/v1/ppaps?status=all').set(h).expect(200);
    expect(all.body.data.map((p: { direction: string }) => p.direction).sort()).toEqual(['received', 'submitted']);
    const received = await api().get('/api/v1/ppaps?status=all&direction=received').set(h).expect(200);
    expect(received.body.data).toHaveLength(1);
    expect(received.body.data[0].supplier).toMatchObject({ name: 'Acme Castings', code: 'PR-S1' });
    const bySupplier = await api().get(`/api/v1/ppaps?status=all&supplierId=${ctx.supplier}`).set(h).expect(200);
    expect(bySupplier.body.data).toHaveLength(1);
    const search = await api().get('/api/v1/ppaps?status=all&q=Acme').set(h).expect(200);
    expect(search.body.data).toHaveLength(1);
  });

  it('is replaced by a new package from the same supplier', async () => {
    const h = await as(ids.ownerA);
    const again = await api().post(`/api/v1/ppaps/${ctx.p1}/resubmission`).set(h).send({ reason: 'process_change' }).expect(201);
    expect(again.body).toMatchObject({ direction: 'received', supplier: { name: 'Acme Castings' }, customer: null, replacesId: ctx.p1 });
  });
});
