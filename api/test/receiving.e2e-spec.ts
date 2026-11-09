/**
 * Supplier quality SQ4a through the API: purchase orders (numbering, lines with a requested and an agreed date), goods receipts (idempotent, the received lot made from a lot number,
 * cancelled with a reason), quantities received / outstanding / late worked out on read, permissions and tenant isolation.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('fb');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const owner = () => as(ids.ownerA);
const viewerId = ids.ownerA.replace(/a1$/, 'a4');
const viewer = () => as(viewerId);
const other = () => as(ids.ownerB, ids.orgB);
const ctx: Record<string, string> = {};
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-rcv');
  await admin.query(`insert into auth.users (id, email) values ($1, 'viewer@example.test') on conflict do nothing`, [viewerId]);
  const mem = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status) values ($1, $2, 'active') returning id`, [ids.orgA, viewerId]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'viewer'`, [ids.orgA, mem.rows[0].id]);
  ctx.s1 = (await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ACME', 'Acme Metals') returning id`, [ids.orgA])).rows[0].id;
  ctx.s2 = (await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'BOLT', 'Bolt Co') returning id`, [ids.orgA])).rows[0].id;
  ctx.sb = (await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'BETA', 'Beta Ltd') returning id`, [ids.orgB])).rows[0].id;
  ctx.part = (await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'BRK-1', 'Bracket') returning id`, [ids.orgA])).rows[0].id;
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const LINES = () => [
  { partId: ctx.part, quantity: 100, unit: 'pcs', requestedOn: day(10) },
  { material: 'Steel bar 20mm', quantity: 50.5, requestedOn: day(-3), agreedOn: day(-1) },
];
const NEW = (over: Record<string, unknown> = {}) => ({ supplierId: ctx.s1, poNumber: 'PO-1', notes: 'First order', lines: LINES(), ...over });

describe('purchase orders', () => {
  it('are recorded by people who may manage, with validated lines', async () => {
    await api().post('/api/v1/purchase-orders').set(await viewer()).send(NEW()).expect(403);
    const h = await owner();
    await api().post('/api/v1/purchase-orders').set(h).send(NEW({ poNumber: '' })).expect(400);
    await api().post('/api/v1/purchase-orders').set(h).send(NEW({ lines: [] })).expect(400);
    await api().post('/api/v1/purchase-orders').set(h).send(NEW({ lines: [{ quantity: 1, requestedOn: day(1) }] })).expect(400);
    await api().post('/api/v1/purchase-orders').set(h).send(NEW({ lines: [{ material: 'x', quantity: 0, requestedOn: day(1) }] })).expect(400);
    await api().post('/api/v1/purchase-orders').set(h).send({ ...NEW(), price: 5 }).expect(400);
    await api().post('/api/v1/purchase-orders').set(h).send(NEW({ supplierId: '00000000-0000-0000-0000-000000000001' })).expect(404);
    const po = (await api().post('/api/v1/purchase-orders').set(h).send(NEW()).expect(201)).body;
    ctx.po = po.id;
    expect(po).toMatchObject({ poNumber: 'PO-1', status: 'open', lineCount: 2, supplier: { code: 'ACME' }, notes: 'First order' });
    expect(po.lines.map((l: { lineNumber: number }) => l.lineNumber)).toEqual([1, 2]);
    expect(po.lines[1]).toMatchObject({ material: 'Steel bar 20mm', requestedOn: day(-3), agreedOn: day(-1), dueOn: day(-1), late: true, daysLate: 1, quantityReceived: 0, quantityOutstanding: 50.5 });
    expect(po.lines[0]).toMatchObject({ part: { partNumber: 'BRK-1' }, late: false });
    expect(po).toMatchObject({ outstandingLines: 2, lateLines: 1, nextDueOn: day(-1) });
    ctx.l1 = po.lines[0].id;
    ctx.l2 = po.lines[1].id;
    expect((await api().post('/api/v1/purchase-orders').set(h).send(NEW({ poNumber: 'po-1', supplierId: ctx.s2 }))).status).toBe(409); // the number is taken
  });

  it('the agreed date moves and the requested date stays', async () => {
    const h = await owner();
    await api().patch(`/api/v1/purchase-order-lines/${ctx.l1}`).set(await viewer()).send({ agreedOn: day(20) }).expect(403);
    await api().patch(`/api/v1/purchase-order-lines/${ctx.l1}`).set(h).send({ agreedOn: 'soon' }).expect(400);
    const po = (await api().patch(`/api/v1/purchase-order-lines/${ctx.l1}`).set(h).send({ agreedOn: day(20) }).expect(200)).body;
    expect(po.lines[0]).toMatchObject({ requestedOn: day(10), agreedOn: day(20), dueOn: day(20) });
    await api().patch(`/api/v1/purchase-order-lines/00000000-0000-0000-0000-000000000001`).set(h).send({ agreedOn: day(20) }).expect(404);
  });
});

describe('goods receipts', () => {
  it('record what arrived, make the received lot, and update the order', async () => {
    const h = await owner();
    const rec = (b: Record<string, unknown>) => api().post('/api/v1/goods-receipts').set(h).send(b);
    const body = (over: Record<string, unknown> = {}) => ({
      supplierId: ctx.s1, purchaseOrderId: ctx.po, receivedOn: day(0), deliveryNote: 'DN-4412',
      lines: [{ poLineId: ctx.l1, quantity: 60, lotNumber: 'LOT-A' }, { poLineId: ctx.l2, quantity: 20 }], clientKey: 'client-key-0001', ...over,
    });
    await api().post('/api/v1/goods-receipts').set(await viewer()).send(body()).expect(403);
    await rec(body({ lines: [] })).expect(400);
    await rec(body({ receivedOn: 'yesterday' })).expect(400);
    expect((await rec(body({ receivedOn: day(2), clientKey: undefined }))).status).toBe(409); // the future
    expect((await rec(body({ supplierId: ctx.s2, clientKey: undefined }))).status).toBe(409); // another supplier's order
    expect((await rec(body({ lines: [{ material: 'Loose', quantity: 5, lotNumber: 'L-1' }], clientKey: undefined }))).status).toBe(409); // a lot needs a part
    expect((await api().get('/api/v1/goods-receipts?status=all').set(h).expect(200)).body.total).toBe(0); // nothing left behind
    const gr = (await rec(body()).expect(201)).body;
    ctx.gr = gr.id;
    expect(gr).toMatchObject({ status: 'received', deliveryNote: 'DN-4412', purchaseOrder: { poNumber: 'PO-1' }, supplier: { code: 'ACME' }, lineCount: 2 });
    expect(gr.reference).toMatch(/^GR-\d{2}-\d{4}$/);
    expect(gr.lines[0]).toMatchObject({ poLine: { lineNumber: 1 }, part: { partNumber: 'BRK-1' }, quantityReceived: 60, lot: { lotNumber: 'LOT-A' } });
    expect(gr.lines[1]).toMatchObject({ material: 'Steel bar 20mm', lot: null });
    ctx.lot = gr.lines[0].lot.id;
    const lot = (await admin.query(`select origin, supplier_id, quantity::float, received_on::text from public.lots where id = $1`, [ctx.lot])).rows[0];
    expect(lot).toMatchObject({ origin: 'received', supplier_id: ctx.s1, quantity: 60, received_on: day(0) });
    const again = (await rec(body()).expect(201)).body; // a retry
    expect(again.id).toBe(gr.id);
    expect((await api().get('/api/v1/goods-receipts?status=all').set(h).expect(200)).body.total).toBe(1);
    expect((await rec(body({ lines: [{ partId: ctx.part, quantity: 5, lotNumber: 'lot-a' }], clientKey: undefined }))).status).toBe(409); // lot number taken
    const po = (await api().get(`/api/v1/purchase-orders/${ctx.po}`).set(h).expect(200)).body;
    expect(po.lines[0]).toMatchObject({ quantityReceived: 60, quantityOutstanding: 40, firstReceivedOn: day(0), lastReceivedOn: day(0) });
    expect(po.lines[1]).toMatchObject({ quantityReceived: 20, quantityOutstanding: 30.5, late: true });
    expect(po.receipts).toEqual([expect.objectContaining({ id: gr.id, reference: gr.reference, lineCount: 2 })]);
  });

  it('are listed, filtered and searched, and cancelled with a reason (the order forgets them, the lot stays)', async () => {
    const h = await owner();
    expect((await api().get(`/api/v1/goods-receipts?supplierId=${ctx.s1}`).set(h).expect(200)).body.total).toBe(1);
    expect((await api().get(`/api/v1/goods-receipts?supplierId=${ctx.s2}`).set(h).expect(200)).body.total).toBe(0);
    expect((await api().get('/api/v1/goods-receipts?q=LOT-A').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/goods-receipts?q=DN-44').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get(`/api/v1/goods-receipts?lotId=${ctx.lot}`).set(h).expect(200)).body.total).toBe(1);
    expect((await api().get(`/api/v1/goods-receipts?purchaseOrderId=${ctx.po}`).set(h).expect(200)).body.total).toBe(1);
    expect((await api().get(`/api/v1/goods-receipts?from=${day(1)}`).set(h).expect(200)).body.total).toBe(0);
    await api().get('/api/v1/goods-receipts?sort=nonsense').set(h).expect(400);
    await api().get('/api/v1/goods-receipts').set(await viewer()).expect(200);
    await api().post(`/api/v1/goods-receipts/${ctx.gr}/cancel`).set(await viewer()).send({ reason: 'Wrong site' }).expect(403);
    await api().post(`/api/v1/goods-receipts/${ctx.gr}/cancel`).set(h).send({ reason: 'x' }).expect(400);
    const c = (await api().post(`/api/v1/goods-receipts/${ctx.gr}/cancel`).set(h).send({ reason: 'Delivered to the wrong site' }).expect(200)).body;
    expect(c).toMatchObject({ status: 'cancelled', cancelReason: 'Delivered to the wrong site' });
    expect((await api().post(`/api/v1/goods-receipts/${ctx.gr}/cancel`).set(h).send({ reason: 'Again please' })).status).toBe(409);
    expect((await api().get('/api/v1/goods-receipts').set(h).expect(200)).body.total).toBe(0); // received only by default
    const po = (await api().get(`/api/v1/purchase-orders/${ctx.po}`).set(h).expect(200)).body;
    expect(po.lines[0]).toMatchObject({ quantityReceived: 0, quantityOutstanding: 100, firstReceivedOn: null });
    expect((await admin.query(`select count(*)::int as n from public.lots where id = $1`, [ctx.lot])).rows[0].n).toBe(1);
  });
});

describe('the order register and closing', () => {
  it('lists, filters late orders, looks up open ones, closes and cancels', async () => {
    const h = await owner();
    const second = (await api().post('/api/v1/purchase-orders').set(h).send(NEW({ poNumber: 'PO-2', supplierId: ctx.s2, lines: [{ material: 'Bolts', quantity: 10, requestedOn: day(5) }] })).expect(201)).body;
    expect((await api().get('/api/v1/purchase-orders').set(h).expect(200)).body.total).toBe(2);
    expect((await api().get('/api/v1/purchase-orders?late=true').set(h).expect(200)).body.data.map((o: { poNumber: string }) => o.poNumber)).toEqual(['PO-1']);
    expect((await api().get('/api/v1/purchase-orders?q=Steel').set(h).expect(200)).body.data.map((o: { poNumber: string }) => o.poNumber)).toEqual(['PO-1']);
    expect((await api().get('/api/v1/purchase-orders?q=BRK-1').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get(`/api/v1/purchase-orders?supplierId=${ctx.s2}`).set(h).expect(200)).body.total).toBe(1);
    await api().get('/api/v1/purchase-orders?status=bogus').set(h).expect(400);
    expect((await api().get(`/api/v1/purchase-orders/lookup?supplierId=${ctx.s1}`).set(h).expect(200)).body.data.map((o: { poNumber: string }) => o.poNumber)).toEqual(['PO-1']);
    await api().post(`/api/v1/purchase-orders/${second.id}/cancel`).set(h).send({ reason: 'x' }).expect(400);
    const c = (await api().post(`/api/v1/purchase-orders/${second.id}/cancel`).set(h).send({ reason: 'Supplier cannot deliver' }).expect(200)).body;
    expect(c).toMatchObject({ status: 'cancelled', cancelReason: 'Supplier cannot deliver' });
    expect(c.lines.every((l: { status: string }) => l.status === 'cancelled')).toBe(true);
    expect((await api().post('/api/v1/goods-receipts').set(h).send({ supplierId: ctx.s2, purchaseOrderId: second.id, receivedOn: day(0), lines: [{ material: 'Bolts', quantity: 1 }] })).status).toBe(409);
    const closed = (await api().post(`/api/v1/purchase-orders/${ctx.po}/close`).set(h).expect(200)).body;
    expect(closed.status).toBe('closed');
    expect((await api().post(`/api/v1/purchase-orders/${ctx.po}/close`).set(h)).status).toBe(409);
    expect((await api().get('/api/v1/purchase-orders').set(h).expect(200)).body.total).toBe(0);
    expect((await api().get('/api/v1/purchase-orders?status=all').set(h).expect(200)).body.total).toBe(2);
  });
});

describe('another organisation', () => {
  it('sees nothing and can change nothing', async () => {
    const h = await other();
    expect((await api().get('/api/v1/purchase-orders?status=all').set(h).expect(200)).body.total).toBe(0);
    expect((await api().get('/api/v1/goods-receipts?status=all').set(h).expect(200)).body.total).toBe(0);
    await api().get(`/api/v1/purchase-orders/${ctx.po}`).set(h).expect(404);
    await api().get(`/api/v1/goods-receipts/${ctx.gr}`).set(h).expect(404);
    await api().post(`/api/v1/purchase-orders/${ctx.po}/cancel`).set(h).send({ reason: 'Foreign cancel' }).expect(404);
    await api().post(`/api/v1/goods-receipts/${ctx.gr}/cancel`).set(h).send({ reason: 'Foreign cancel' }).expect(404);
    await api().post('/api/v1/purchase-orders').set(h).send(NEW()).expect(404);
    await api().post('/api/v1/goods-receipts').set(h).send({ supplierId: ctx.s1, receivedOn: day(0), lines: [{ material: 'x', quantity: 1 }] }).expect(404);
    await api().patch(`/api/v1/purchase-order-lines/${ctx.l1}`).set(h).send({ agreedOn: day(30) }).expect(404);
  });
});
