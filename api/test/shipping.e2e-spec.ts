/**
 * Orders and fulfilment SH2 through the API: customer orders (numbering, lines with a requested and an agreed date), shipments (idempotent, an existing lot only, over-shipment allowed,
 * cancelled with a reason), quantities shipped / outstanding / over / late worked out on read, permissions and tenant isolation.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('0a');
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
  await seed(admin, ids, '-shp');
  await admin.query(`insert into auth.users (id, email) values ($1, 'viewer@example.test') on conflict do nothing`, [viewerId]);
  const mem = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status) values ($1, $2, 'active') returning id`, [ids.orgA, viewerId]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'viewer'`, [ids.orgA, mem.rows[0].id]);
  ctx.c1 = (await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'ACME', 'Acme Motors') returning id`, [ids.orgA])).rows[0].id;
  ctx.c2 = (await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'BOLT', 'Bolt Autos') returning id`, [ids.orgA])).rows[0].id;
  ctx.cb = (await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'BETA', 'Beta Ltd') returning id`, [ids.orgB])).rows[0].id;
  ctx.part = (await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'BRK-1', 'Bracket') returning id`, [ids.orgA])).rows[0].id;
  ctx.part2 = (await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'BRK-2', 'Other') returning id`, [ids.orgA])).rows[0].id;
  ctx.lot = (await admin.query(`insert into public.lots (organisation_id, lot_number, part_id, origin, quantity) values ($1, 'L-100', $2, 'produced', 500) returning id`, [ids.orgA, ctx.part])).rows[0].id;
  ctx.lot2 = (await admin.query(`insert into public.lots (organisation_id, lot_number, part_id, origin, quantity) values ($1, 'L-200', $2, 'produced', 100) returning id`, [ids.orgA, ctx.part2])).rows[0].id;
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const LINES = () => [
  { partId: ctx.part, quantity: 100, unit: 'pcs', requestedOn: day(10) },
  { partId: ctx.part2, quantity: 50.5, requestedOn: day(-3), agreedOn: day(-1) },
];
const NEW = (over: Record<string, unknown> = {}) => ({ customerId: ctx.c1, orderNumber: 'CO-1', customerReference: 'PO-7788', notes: 'First order', lines: LINES(), ...over });

describe('customer orders', () => {
  it('are recorded by people who may manage, with validated lines', async () => {
    await api().post('/api/v1/customer-orders').set(await viewer()).send(NEW()).expect(403);
    const h = await owner();
    await api().post('/api/v1/customer-orders').set(h).send(NEW({ orderNumber: '' })).expect(400);
    await api().post('/api/v1/customer-orders').set(h).send(NEW({ lines: [] })).expect(400);
    await api().post('/api/v1/customer-orders').set(h).send(NEW({ lines: [{ quantity: 1, requestedOn: day(1) }] })).expect(400);
    await api().post('/api/v1/customer-orders').set(h).send(NEW({ lines: [{ partId: ctx.part, quantity: 0, requestedOn: day(1) }] })).expect(400);
    await api().post('/api/v1/customer-orders').set(h).send({ ...NEW(), price: 5 }).expect(400);
    await api().post('/api/v1/customer-orders').set(h).send(NEW({ customerId: '00000000-0000-0000-0000-000000000001' })).expect(404);
    await api().post('/api/v1/customer-orders').set(h).send(NEW({ customerId: ctx.cb })).expect(404);
    const order = (await api().post('/api/v1/customer-orders').set(h).send(NEW()).expect(201)).body;
    ctx.order = order.id;
    expect(order).toMatchObject({ orderNumber: 'CO-1', customerReference: 'PO-7788', status: 'open', lineCount: 2, customer: { code: 'ACME' }, notes: 'First order' });
    expect(order.lines.map((l: { lineNumber: number }) => l.lineNumber)).toEqual([1, 2]);
    expect(order.lines[1]).toMatchObject({ part: { partNumber: 'BRK-2' }, requestedOn: day(-3), agreedOn: day(-1), dueOn: day(-1), late: true, daysLate: 1, quantityShipped: 0, quantityOutstanding: 50.5, quantityOver: 0 });
    expect(order.lines[0]).toMatchObject({ late: false, dueOn: day(10) });
    expect(order).toMatchObject({ outstandingLines: 2, lateLines: 1, nextDueOn: day(-1) });
    ctx.line1 = order.lines[0].id;
    ctx.line2 = order.lines[1].id;
    const dup = await api().post('/api/v1/customer-orders').set(h).send(NEW({ orderNumber: 'co-1' })).expect(409);
    expect(dup.body.error.code).toBe('shipping_rule');
  });

  it('keep the requested date while the agreed date moves', async () => {
    const h = await owner();
    await api().patch(`/api/v1/customer-order-lines/${ctx.line1}`).set(await viewer()).send({ agreedOn: day(3) }).expect(403);
    const res = await api().patch(`/api/v1/customer-order-lines/${ctx.line1}`).set(h).send({ agreedOn: day(3) }).expect(200);
    expect(res.body.lines[0]).toMatchObject({ requestedOn: day(10), agreedOn: day(3), dueOn: day(3) });
    await api().patch(`/api/v1/customer-order-lines/${ctx.line1}`).set(h).send({ agreedOn: 'soon' }).expect(400);
    await api().patch(`/api/v1/customer-order-lines/00000000-0000-0000-0000-000000000001`).set(h).send({ agreedOn: day(3) }).expect(404);
  });

  it('are found in a list with filters and the late view', async () => {
    const h = await owner();
    const all = (await api().get('/api/v1/customer-orders').set(h).expect(200)).body;
    expect(all).toMatchObject({ page: 1, total: 1 });
    expect(all.data[0]).toMatchObject({ orderNumber: 'CO-1', lateLines: 1 });
    expect((await api().get('/api/v1/customer-orders?late=true').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/customer-orders?q=7788').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/customer-orders?q=BRK-2').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get(`/api/v1/customer-orders?customerId=${ctx.c2}`).set(h).expect(200)).body.total).toBe(0);
    expect((await api().get('/api/v1/customer-orders?status=closed').set(h).expect(200)).body.total).toBe(0);
    await api().get('/api/v1/customer-orders?status=nonsense').set(h).expect(400);
    expect((await api().get(`/api/v1/customer-orders/lookup?customerId=${ctx.c1}`).set(h).expect(200)).body.data).toHaveLength(1);
    await api().get('/api/v1/customer-orders').set(await viewer()).expect(200);
  });
});

describe('shipments', () => {
  const NEW_SHIP = (over: Record<string, unknown> = {}) => ({
    customerId: ctx.c1,
    customerOrderId: ctx.order,
    shippedOn: day(-1),
    deliveryNote: 'DN-1',
    lines: [{ orderLineId: ctx.line1, quantity: 60, lotNumber: 'l-100' }, { orderLineId: ctx.line2, quantity: 50 }],
    clientKey: 'ship-key-0001',
    ...over,
  });

  it('are recorded against an order line, of an existing lot, and numbered', async () => {
    await api().post('/api/v1/shipments').set(await viewer()).send(NEW_SHIP()).expect(403);
    const h = await owner();
    await api().post('/api/v1/shipments').set(h).send(NEW_SHIP({ shippedOn: day(1) })).expect(409);
    await api().post('/api/v1/shipments').set(h).send(NEW_SHIP({ lines: [] })).expect(400);
    await api().post('/api/v1/shipments').set(h).send(NEW_SHIP({ lines: [{ quantity: 5 }] })).expect(400);
    await api().post('/api/v1/shipments').set(h).send({ ...NEW_SHIP(), price: 1 }).expect(400);
    await api().post('/api/v1/shipments').set(h).send(NEW_SHIP({ customerId: ctx.c2, clientKey: 'other-key-9999' })).expect(409);
    await api().post('/api/v1/shipments').set(h).send(NEW_SHIP({ clientKey: 'other-key-0001', lines: [{ partId: ctx.part, quantity: 5, lotNumber: 'NOPE' }] })).expect(409);
    await api().post('/api/v1/shipments').set(h).send(NEW_SHIP({ clientKey: 'other-key-0002', lines: [{ partId: ctx.part, quantity: 5, lotId: ctx.lot2 }] })).expect(409);
    const shipment = (await api().post('/api/v1/shipments').set(h).send(NEW_SHIP()).expect(201)).body;
    ctx.shipment = shipment.id;
    expect(shipment.reference).toMatch(/^SH-\d{2}-0001$/);
    expect(shipment).toMatchObject({ status: 'shipped', customer: { code: 'ACME' }, customerOrder: { orderNumber: 'CO-1' }, deliveryNote: 'DN-1', lineCount: 2 });
    expect(shipment.lines[0]).toMatchObject({ part: { partNumber: 'BRK-1' }, quantityShipped: 60, lot: { lotNumber: 'L-100' }, lotStatus: 'open', orderLine: { lineNumber: 1 } });
    expect(shipment.lines[1]).toMatchObject({ part: { partNumber: 'BRK-2' }, lot: null });
    const lots = await admin.query(`select count(*)::int as n from public.lots where organisation_id = $1`, [ids.orgA]);
    expect(lots.rows[0].n).toBe(2);
  });

  it('are made once for one client key', async () => {
    const h = await owner();
    const again = (await api().post('/api/v1/shipments').set(h).send(NEW_SHIP()).expect(201)).body;
    expect(again.id).toBe(ctx.shipment);
    expect((await api().get('/api/v1/shipments?status=all').set(h).expect(200)).body.total).toBe(1);
  });

  it('show what has shipped on the order, allowing over-shipment', async () => {
    const h = await owner();
    let order = (await api().get(`/api/v1/customer-orders/${ctx.order}`).set(h).expect(200)).body;
    expect(order.lines[0]).toMatchObject({ quantityShipped: 60, quantityOutstanding: 40, quantityOver: 0, firstShippedOn: day(-1) });
    expect(order.lines[1]).toMatchObject({ quantityShipped: 50, quantityOutstanding: 0.5, late: true });
    const second = (await api().post('/api/v1/shipments').set(h).send(NEW_SHIP({ clientKey: undefined, deliveryNote: 'DN-2', shippedOn: day(0), lines: [{ orderLineId: ctx.line1, quantity: 80 }] })).expect(201)).body;
    expect(second.reference).toMatch(/-0002$/);
    order = (await api().get(`/api/v1/customer-orders/${ctx.order}`).set(h).expect(200)).body;
    expect(order.lines[0]).toMatchObject({ quantityShipped: 140, quantityOutstanding: 0, quantityOver: 40, lastShippedOn: day(0) });
    expect(order.shipments).toHaveLength(2);
    expect(order).toMatchObject({ outstandingLines: 1, lateLines: 1 });
  });

  it('are listed, found by lot or part, and cancelled with a reason', async () => {
    const h = await owner();
    expect((await api().get(`/api/v1/shipments?lotId=${ctx.lot}`).set(h).expect(200)).body.total).toBe(1);
    expect((await api().get(`/api/v1/shipments?partId=${ctx.part2}`).set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/shipments?q=DN-2').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get(`/api/v1/shipments?customerOrderId=${ctx.order}`).set(h).expect(200)).body.total).toBe(2);
    expect((await api().get(`/api/v1/shipments?from=${day(0)}&to=${day(0)}`).set(h).expect(200)).body.total).toBe(1);
    await api().get('/api/v1/shipments').set(await viewer()).expect(200);

    await api().post(`/api/v1/shipments/${ctx.shipment}/cancel`).set(await viewer()).send({ reason: 'Keyed in error' }).expect(403);
    await api().post(`/api/v1/shipments/${ctx.shipment}/cancel`).set(h).send({ reason: 'x' }).expect(400);
    const done = (await api().post(`/api/v1/shipments/${ctx.shipment}/cancel`).set(h).send({ reason: 'Keyed in error' }).expect(200)).body;
    expect(done).toMatchObject({ status: 'cancelled', cancelReason: 'Keyed in error' });
    await api().post(`/api/v1/shipments/${ctx.shipment}/cancel`).set(h).send({ reason: 'Again please' }).expect(409);
    // a cancelled shipment no longer counts on the order
    const order = (await api().get(`/api/v1/customer-orders/${ctx.order}`).set(h).expect(200)).body;
    expect(order.lines[0]).toMatchObject({ quantityShipped: 80, quantityOutstanding: 20 });
    expect((await api().get('/api/v1/shipments').set(h).expect(200)).body.total).toBe(1);
  });

  it('stop at a closed order, and an order closes or cancels with its lines', async () => {
    const h = await owner();
    await api().post(`/api/v1/customer-orders/${ctx.order}/close`).set(await viewer()).expect(403);
    const closed = (await api().post(`/api/v1/customer-orders/${ctx.order}/close`).set(h).expect(200)).body;
    expect(closed.status).toBe('closed');
    expect(closed.lines.every((l: { status: string }) => l.status === 'closed')).toBe(true);
    await api().post(`/api/v1/customer-orders/${ctx.order}/close`).set(h).expect(409);
    await api().post('/api/v1/shipments').set(h).send(NEW_SHIP({ clientKey: undefined, lines: [{ orderLineId: ctx.line1, quantity: 1 }] })).expect(409);
    const second = (await api().post('/api/v1/customer-orders').set(h).send(NEW({ orderNumber: 'CO-2', lines: [{ partId: ctx.part, quantity: 5, requestedOn: day(4) }] })).expect(201)).body;
    await api().post(`/api/v1/customer-orders/${second.id}/cancel`).set(h).send({ reason: 'no' }).expect(400);
    const cancelled = (await api().post(`/api/v1/customer-orders/${second.id}/cancel`).set(h).send({ reason: 'Customer withdrew it' }).expect(200)).body;
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Customer withdrew it' });
  });

  it('are private to their organisation', async () => {
    const b = await other();
    expect((await api().get('/api/v1/shipments?status=all').set(b).expect(200)).body.total).toBe(0);
    expect((await api().get('/api/v1/customer-orders?status=all').set(b).expect(200)).body.total).toBe(0);
    await api().get(`/api/v1/shipments/${ctx.shipment}`).set(b).expect(404);
    await api().get(`/api/v1/customer-orders/${ctx.order}`).set(b).expect(404);
    await api().post(`/api/v1/shipments/${ctx.shipment}/cancel`).set(b).send({ reason: 'Not yours to cancel' }).expect(404);
    await api().patch(`/api/v1/customer-order-lines/${ctx.line1}`).set(b).send({ agreedOn: day(3) }).expect(404);
  });
});
