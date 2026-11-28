/**
 * Client keys on the NC creates that must not repeat (docs/audit-nc-2026-11.md API-13): a non-conformance, a cost line, a disposition and an RMA number. The same key
 * answers the record already made; a key used for another record is refused; two retries that arrive together make one record; with no key a record is made each time.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { categoryId, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('b4');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const count = async (sqlText: string, params: unknown[]) => Number((await admin.query(sqlText, params)).rows[0].n);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-nck');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  const cat = await categoryId(admin, ids.orgA);
  ctx.customer = (await api().post('/api/v1/customers').set(h).send({ code: 'KEY-C', name: 'Keyed Customer' }).expect(201)).body.id;
  const body = { source: 'customer', customerId: ctx.customer, severity: 'major', quantityAffected: 20, description: 'x', siteId: ids.siteA, open: true, categoryId: cat };
  ctx.nc = (await api().post('/api/v1/ncrs').set(h).send({ ...body, title: 'First' }).expect(201)).body.id;
  ctx.nc2 = (await api().post('/api/v1/ncrs').set(h).send({ ...body, title: 'Second' }).expect(201)).body.id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('a non-conformance', () => {
  it('is made once for a key, however many times it is sent', async () => {
    const h = await as(ids.ownerA);
    const body = { source: 'internal', title: 'Double click', clientKey: 'nc-create-0001' };
    const first = (await api().post('/api/v1/ncrs').set(h).send(body).expect(201)).body;
    const again = (await api().post('/api/v1/ncrs').set(h).send(body).expect(201)).body;
    expect(again.id).toBe(first.id);
    expect(again.reference).toBe(first.reference);
    expect(await count(`select count(*)::int as n from public.nonconformances where organisation_id = $1 and client_key = 'nc-create-0001'`, [ids.orgA])).toBe(1);
  });

  it('is made once when two retries arrive together', async () => {
    const h = await as(ids.ownerA);
    const body = { source: 'internal', title: 'Together', clientKey: 'nc-create-0002' };
    const [a, b] = await Promise.all([api().post('/api/v1/ncrs').set(h).send(body), api().post('/api/v1/ncrs').set(h).send(body)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect(await count(`select count(*)::int as n from public.nonconformances where organisation_id = $1 and client_key = 'nc-create-0002'`, [ids.orgA])).toBe(1);
  });

  it('is made each time with no key, refuses a short key, and does not share a key with another organisation', async () => {
    const h = await as(ids.ownerA);
    const a = (await api().post('/api/v1/ncrs').set(h).send({ source: 'internal', title: 'No key' }).expect(201)).body.id;
    const b = (await api().post('/api/v1/ncrs').set(h).send({ source: 'internal', title: 'No key' }).expect(201)).body.id;
    expect(a).not.toBe(b);
    await api().post('/api/v1/ncrs').set(h).send({ source: 'internal', title: 'Short', clientKey: 'short' }).expect(400);
    // the same key in another organisation is its own record (the key is unique per organisation)
    await api().post('/api/v1/ncrs').set(await as(ids.ownerB, ids.orgB)).send({ source: 'internal', title: 'Elsewhere', clientKey: 'nc-create-0001' }).expect(201);
    expect(await count(`select count(*)::int as n from public.nonconformances where client_key = 'nc-create-0001'`, [])).toBe(2);
  });
});

describe('a cost line', () => {
  it('is made once for a key, answers the same line, and is refused on another non-conformance', async () => {
    const h = await as(ids.ownerA);
    const body = { costType: 'scrap', currency: 'GBP', unitCost: 12.5, quantity: 2, clientKey: 'cost-create-001' };
    const first = (await api().post(`/api/v1/ncrs/${ctx.nc}/costs`).set(h).send(body).expect(201)).body;
    const again = (await api().post(`/api/v1/ncrs/${ctx.nc}/costs`).set(h).send(body).expect(201)).body;
    expect(again.id).toBe(first.id);
    expect(again.amount).toBe(25);
    expect((await api().get(`/api/v1/ncrs/${ctx.nc}/costs`).set(h).expect(200)).body.data).toHaveLength(1);
    const other = await api().post(`/api/v1/ncrs/${ctx.nc2}/costs`).set(h).send(body).expect(409);
    expect(other.body.error.code).toBe('client_key_in_use');
    expect((await api().get(`/api/v1/ncrs/${ctx.nc2}/costs`).set(h).expect(200)).body.data).toHaveLength(0);
    // the key cannot be changed afterwards
    await api().patch(`/api/v1/ncr-costs/${first.id}`).set(h).send({ clientKey: 'cost-create-002' }).expect(400);
  });

  it('counts together retries once', async () => {
    const h = await as(ids.ownerA);
    const body = { costType: 'sorting', currency: 'GBP', unitCost: 3, clientKey: 'cost-create-003' };
    const [a, b] = await Promise.all([api().post(`/api/v1/ncrs/${ctx.nc2}/costs`).set(h).send(body), api().post(`/api/v1/ncrs/${ctx.nc2}/costs`).set(h).send(body)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.id).toBe(b.body.id);
  });
});

describe('a disposition', () => {
  it('is proposed once for a key; the quantity is counted once', async () => {
    const h = await as(ids.ownerA);
    const body = { decision: 'scrap', quantity: 15, instructions: 'Scrap them', clientKey: 'disp-create-001' };
    const first = (await api().post(`/api/v1/ncrs/${ctx.nc}/dispositions`).set(h).send(body).expect(201)).body;
    const again = (await api().post(`/api/v1/ncrs/${ctx.nc}/dispositions`).set(h).send(body).expect(201)).body;
    expect(again.id).toBe(first.id);
    // 15 + 15 would be over the 20 affected, so a second would have been refused: it was answered, not made
    expect((await api().get(`/api/v1/ncrs/${ctx.nc}/dispositions`).set(h).expect(200)).body.data.filter((d: { decision: string }) => d.decision === 'scrap')).toHaveLength(1);
    const other = await api().post(`/api/v1/ncrs/${ctx.nc2}/dispositions`).set(h).send(body).expect(409);
    expect(other.body.error.code).toBe('client_key_in_use');
    await api().patch(`/api/v1/ncr-dispositions/${first.id}`).set(h).send({ clientKey: 'disp-create-002' }).expect(400);
  });
});

describe('an RMA number', () => {
  it('is taken once for a key: a retry answers the same disposition and burns no number', async () => {
    const h = await as(ids.ownerA);
    const yy = String(new Date().getFullYear()).slice(2);
    const url = `/api/v1/ncrs/${ctx.nc2}/rma`;
    const first = (await api().post(url).set(h).send({ quantity: 4, clientKey: 'rma-create-0001' }).expect(201)).body;
    const again = (await api().post(url).set(h).send({ quantity: 4, clientKey: 'rma-create-0001' }).expect(201)).body;
    expect(again.id).toBe(first.id);
    expect(first.reference).toBe(`RMA-${yy}-0001`);
    const next = (await api().post(url).set(h).send({ quantity: 2 }).expect(201)).body;
    expect(next.reference).toBe(`RMA-${yy}-0002`);
    // together
    const [a, b] = await Promise.all([api().post(url).set(h).send({ quantity: 1, clientKey: 'rma-create-0002' }), api().post(url).set(h).send({ quantity: 1, clientKey: 'rma-create-0002' })]);
    expect([a.status, b.status].sort()).toEqual([201, 201]);
    expect(a.body.id).toBe(b.body.id);
    const last = (await api().post(url).set(h).send({ quantity: 1 }).expect(201)).body;
    expect(last.reference).toBe(`RMA-${yy}-0004`);
    // a key used for another non-conformance is refused
    await api().post(`/api/v1/ncrs/${ctx.nc}/rma`).set(h).send({ quantity: 1, clientKey: 'rma-create-0001' }).expect(409);
  });
});
