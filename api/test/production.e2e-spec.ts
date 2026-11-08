/**
 * Production orders, operations, lots and serial numbers through the API: create and validate, list (search, filters, sort, pages), pickers, the database's
 * status rules answering 409 production_rule, part / lot / order agreement, serial batches (all or nothing), and permissions. Tenancy of every route is also
 * covered by the tenancy sweep.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('f3');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-production');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  ctx.siteB = (await api().post('/api/v1/sites').set(h).send({ code: 'PLB', name: 'Plant B' }).expect(201)).body.id;
  const rod = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'ROD-100', name: 'Rod', initialRevision: { revision: 'A' } }).expect(201)).body;
  ctx.rod = rod.id;
  ctx.rodRev = rod.revisions[0].id;
  const pin = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'PIN-200', name: 'Pin', initialRevision: { revision: 'A' } }).expect(201)).body;
  ctx.pin = pin.id;
  ctx.pinRev = pin.revisions[0].id;
  ctx.customer = (await api().post('/api/v1/customers').set(h).send({ code: 'ACME', name: 'Acme Hydraulics' }).expect(201)).body.id;
  ctx.supplier = (await api().post('/api/v1/suppliers').set(h).send({ code: 'STEEL', name: 'Steel Co' }).expect(201)).body.id;
  ctx.machineA = (await api().post('/api/v1/machines').set(h).send({ code: 'LATHE-1', name: 'Lathe', siteId: ids.siteA }).expect(201)).body.id;
  ctx.machineB = (await api().post('/api/v1/machines').set(h).send({ code: 'MILL-B', name: 'Mill at B', siteId: ctx.siteB }).expect(201)).body.id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('production orders', () => {
  it('creates an order planned, takes the only site, and reads it back with its part, revision and customer', async () => {
    // Two sites exist now, so name the site; an organisation with one site gets it by default (checked in the organisation of the sweep).
    const h = await as(ids.ownerA);
    const res = await api()
      .post('/api/v1/production-orders')
      .set(h)
      .send({ orderNumber: 'WO-1001', partId: ctx.rod, partRevisionId: ctx.rodRev, customerId: ctx.customer, siteId: ids.siteA, quantityPlanned: 500, dueDate: '2026-12-01', notes: 'First batch' })
      .expect(201);
    ctx.wo = res.body.id;
    expect(res.body).toMatchObject({
      orderNumber: 'WO-1001', status: 'planned', quantityPlanned: 500, dueDate: '2026-12-01', notes: 'First batch', external: null,
      part: { id: ctx.rod, partNumber: 'ROD-100' }, partRevision: { id: ctx.rodRev, revision: 'A', version: 1 }, customer: { code: 'ACME' }, site: { id: ids.siteA },
      lotCount: 0, serialCount: 0, operationCount: 0, operations: [],
    });
    expect((await api().get(`/api/v1/production-orders/${ctx.wo}`).set(h).expect(200)).body.orderNumber).toBe('WO-1001');
  });

  it('validates the body, refuses unknown fields and an order number already used (any case), and a revision of another part', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/production-orders').set(h).send({ orderNumber: '', partId: ctx.rod, quantityPlanned: 1 }).expect(400);
    await api().post('/api/v1/production-orders').set(h).send({ orderNumber: 'WO-X', partId: ctx.rod, quantityPlanned: 0 }).expect(400);
    await api().post('/api/v1/production-orders').set(h).send({ orderNumber: 'WO-X', partId: ctx.rod, quantityPlanned: 1, dueDate: '01/12/2026' }).expect(400);
    await api().post('/api/v1/production-orders').set(h).send({ orderNumber: 'WO-X', partId: ctx.rod, quantityPlanned: 1, status: 'closed' }).expect(400);
    const dup = await api().post('/api/v1/production-orders').set(h).send({ orderNumber: 'wo-1001', partId: ctx.rod, quantityPlanned: 1, siteId: ids.siteA }).expect(409);
    expect(dup.body.error).toMatchObject({ code: 'conflict', message: 'A production order with this number already exists' });
    const wrong = await api().post('/api/v1/production-orders').set(h).send({ orderNumber: 'WO-BAD', partId: ctx.rod, partRevisionId: ctx.pinRev, quantityPlanned: 1, siteId: ids.siteA }).expect(409);
    expect(wrong.body.error.code).toBe('production_rule');
  });

  it('lists with search, filters, sort and pages, and offers open orders to pickers', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/production-orders').set(h).send({ orderNumber: 'WO-1002', partId: ctx.pin, quantityPlanned: 20, siteId: ids.siteA, dueDate: '2026-11-20' }).expect(201);
    const closedLater = (await api().post('/api/v1/production-orders').set(h).send({ orderNumber: 'WO-1003', partId: ctx.pin, quantityPlanned: 5, siteId: ids.siteA }).expect(201)).body.id;
    await api().patch(`/api/v1/production-orders/${closedLater}`).set(h).send({ status: 'cancelled', statusReason: 'Test' }).expect(200);

    const all = (await api().get('/api/v1/production-orders?sort=orderNumber&order=asc').set(h).expect(200)).body;
    expect(all.total).toBe(3);
    expect(all.data.map((o: { orderNumber: string }) => o.orderNumber)).toEqual(['WO-1001', 'WO-1002', 'WO-1003']);
    expect((await api().get('/api/v1/production-orders?partId=' + ctx.pin).set(h).expect(200)).body.total).toBe(2);
    expect((await api().get('/api/v1/production-orders?status=cancelled').set(h).expect(200)).body.data.map((o: { orderNumber: string }) => o.orderNumber)).toEqual(['WO-1003']);
    expect((await api().get('/api/v1/production-orders?status=planned,cancelled').set(h).expect(200)).body.total).toBe(3);
    expect((await api().get('/api/v1/production-orders?q=acme').set(h).expect(200)).body.total).toBe(1); // customer name
    expect((await api().get('/api/v1/production-orders?q=PIN-2').set(h).expect(200)).body.total).toBe(2); // part number
    const page2 = (await api().get('/api/v1/production-orders?sort=orderNumber&pageSize=2&page=2').set(h).expect(200)).body;
    expect(page2).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(page2.data).toHaveLength(1);
    await api().get('/api/v1/production-orders?sort=bogus').set(h).expect(400);

    const pick = (await api().get('/api/v1/production-orders/lookup').set(h).expect(200)).body.data;
    expect(pick.map((o: { orderNumber: string }) => o.orderNumber).sort()).toEqual(['WO-1001', 'WO-1002']); // the cancelled one is left out
    expect((await api().get('/api/v1/production-orders/lookup?includeClosed=true').set(h).expect(200)).body.data).toHaveLength(3);
    expect((await api().get('/api/v1/production-orders/lookup?partId=' + ctx.rod).set(h).expect(200)).body.data.map((o: { orderNumber: string }) => o.orderNumber)).toEqual(['WO-1001']);
  });

  it('adds operations (the sequence defaults to the next ten), refuses a machine at another site, and changes them', async () => {
    const h = await as(ids.ownerA);
    let res = await api().post(`/api/v1/production-orders/${ctx.wo}/operations`).set(h).send({ operationCode: 'OP-10', description: 'Turning', machineId: ctx.machineA }).expect(201);
    expect(res.body.operations).toMatchObject([{ sequence: 10, operationCode: 'OP-10', description: 'Turning', machine: { code: 'LATHE-1' }, status: 'pending' }]);
    res = await api().post(`/api/v1/production-orders/${ctx.wo}/operations`).set(h).send({ operationCode: 'OP-20' }).expect(201);
    expect(res.body.operations.map((o: { sequence: number }) => o.sequence)).toEqual([10, 20]);
    expect(res.body.operationCount).toBe(2);
    ctx.op10 = res.body.operations[0].id;
    ctx.op20 = res.body.operations[1].id;
    const other = await api().post(`/api/v1/production-orders/${ctx.wo}/operations`).set(h).send({ operationCode: 'OP-30', machineId: ctx.machineB }).expect(409);
    expect(other.body.error).toMatchObject({ code: 'production_rule', message: expect.stringContaining('another site') });
    const dup = await api().post(`/api/v1/production-orders/${ctx.wo}/operations`).set(h).send({ operationCode: 'OP-X', sequence: 10 }).expect(409);
    expect(dup.body.error.code).toBe('conflict');
    res = await api().patch(`/api/v1/production-operations/${ctx.op10}`).set(h).send({ description: 'Rough turning', status: 'in_progress' }).expect(200);
    expect(res.body.operations[0]).toMatchObject({ description: 'Rough turning', status: 'in_progress' });
    await api().patch(`/api/v1/production-operations/${ctx.op10}`).set(h).send({}).expect(400);
  });

  it('moves an order through its statuses with the database deciding: no jumps, cancelling needs a reason, completing needs the operations done', async () => {
    const h = await as(ids.ownerA);
    const jump = await api().patch(`/api/v1/production-orders/${ctx.wo}`).set(h).send({ status: 'completed' }).expect(409);
    expect(jump.body.error.code).toBe('production_rule');
    await api().patch(`/api/v1/production-orders/${ctx.wo}`).set(h).send({ status: 'released' }).expect(200);
    await api().patch(`/api/v1/production-orders/${ctx.wo}`).set(h).send({ status: 'in_progress' }).expect(200);
    const open = await api().patch(`/api/v1/production-orders/${ctx.wo}`).set(h).send({ status: 'completed' }).expect(409);
    expect(open.body.error.message).toContain('OP-10, OP-20');
    await api().patch(`/api/v1/production-operations/${ctx.op10}`).set(h).send({ status: 'completed' }).expect(200);
    await api().patch(`/api/v1/production-operations/${ctx.op20}`).set(h).send({ status: 'skipped' }).expect(200);
    const done = await api().patch(`/api/v1/production-orders/${ctx.wo}`).set(h).send({ status: 'completed' }).expect(200);
    expect(done.body.status).toBe('completed');
    const frozen = await api().post(`/api/v1/production-orders/${ctx.wo}/operations`).set(h).send({ operationCode: 'OP-40' }).expect(409);
    expect(frozen.body.error.code).toBe('production_rule');
    await api().patch(`/api/v1/production-orders/${ctx.wo}`).set(h).send({ status: 'closed' }).expect(200);
    const closed = await api().patch(`/api/v1/production-orders/${ctx.wo}`).set(h).send({ notes: 'late' }).expect(409);
    expect(closed.body.error.message).toContain('closed');

    const spare = (await api().post('/api/v1/production-orders').set(h).send({ orderNumber: 'WO-SPARE', partId: ctx.rod, quantityPlanned: 1, siteId: ids.siteA }).expect(201)).body.id;
    const noReason = await api().patch(`/api/v1/production-orders/${spare}`).set(h).send({ status: 'cancelled' }).expect(409);
    expect(noReason.body.error.code).toBe('production_rule');
    const cancelled = await api().patch(`/api/v1/production-orders/${spare}`).set(h).send({ status: 'cancelled', statusReason: 'Customer withdrew' }).expect(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', statusReason: 'Customer withdrew' });
  });

  it('answers 404 for an order that does not exist', async () => {
    const h = await as(ids.ownerA);
    const res = await api().get('/api/v1/production-orders/00000000-0000-0000-0000-000000000000').set(h).expect(404);
    expect(res.body.error.code).toBe('production_order_not_found');
    await api().get('/api/v1/production-orders/not-a-uuid').set(h).expect(400);
  });
});

describe('lots', () => {
  it('creates produced and received lots, checks the order and part agree, and keeps numbers unique per part', async () => {
    const h = await as(ids.ownerA);
    const open = (await api().get('/api/v1/production-orders?q=WO-1002').set(h).expect(200)).body.data[0];
    ctx.pinOrder = open.id;
    const produced = await api().post('/api/v1/lots').set(h).send({ lotNumber: 'LOT-1', partId: ctx.pin, origin: 'produced', productionOrderId: ctx.pinOrder, quantity: 20 }).expect(201);
    ctx.lot1 = produced.body.id;
    expect(produced.body).toMatchObject({ lotNumber: 'LOT-1', status: 'open', origin: 'produced', quantity: 20, productionOrder: { orderNumber: 'WO-1002' }, supplier: null, site: { id: ids.siteA }, serialCount: 0 });
    const received = await api().post('/api/v1/lots').set(h).send({ lotNumber: 'HEAT-77', partId: ctx.rod, origin: 'received', supplierId: ctx.supplier, receivedOn: '2026-11-01', quantity: 1000 }).expect(201);
    ctx.lotRecv = received.body.id;
    expect(received.body).toMatchObject({ origin: 'received', supplier: { code: 'STEEL' }, receivedOn: '2026-11-01', productionOrder: null });

    const wrongPart = await api().post('/api/v1/lots').set(h).send({ lotNumber: 'LOT-9', partId: ctx.rod, origin: 'produced', productionOrderId: ctx.pinOrder }).expect(409);
    expect(wrongPart.body.error).toMatchObject({ code: 'production_rule', message: expect.stringContaining('another part') });
    await api().post('/api/v1/lots').set(h).send({ lotNumber: 'LOT-8', partId: ctx.pin, origin: 'produced', supplierId: ctx.supplier }).expect(400);
    await api().post('/api/v1/lots').set(h).send({ lotNumber: 'LOT-7', partId: ctx.pin, origin: 'received', productionOrderId: ctx.pinOrder }).expect(400);
    const dup = await api().post('/api/v1/lots').set(h).send({ lotNumber: 'lot-1', partId: ctx.pin, origin: 'produced' }).expect(409);
    expect(dup.body.error.message).toBe('This part already has a lot with that number');
    await api().post('/api/v1/lots').set(h).send({ lotNumber: 'LOT-1', partId: ctx.rod, origin: 'produced' }).expect(201); // same number, another part
    await api().post('/api/v1/lots').set(h).send({ lotNumber: 'X', partId: ctx.pin, origin: 'borrowed' }).expect(400);
  });

  it('holds with a reason, releases, closes and then freezes a lot', async () => {
    const h = await as(ids.ownerA);
    const noReason = await api().patch(`/api/v1/lots/${ctx.lot1}`).set(h).send({ status: 'on_hold' }).expect(409);
    expect(noReason.body.error.code).toBe('production_rule');
    const held = await api().patch(`/api/v1/lots/${ctx.lot1}`).set(h).send({ status: 'on_hold', statusReason: 'Suspect material' }).expect(200);
    expect(held.body).toMatchObject({ status: 'on_hold', statusReason: 'Suspect material' });
    const released = await api().patch(`/api/v1/lots/${ctx.lot1}`).set(h).send({ status: 'released' }).expect(200);
    expect(released.body).toMatchObject({ status: 'released', statusReason: null });
    await api().patch(`/api/v1/lots/${ctx.lot1}`).set(h).send({ quantity: 25, notes: 'Recounted' }).expect(200);
    await api().patch(`/api/v1/lots/${ctx.lotRecv}`).set(h).send({ status: 'closed' }).expect(200);
    const frozen = await api().patch(`/api/v1/lots/${ctx.lotRecv}`).set(h).send({ quantity: 5 }).expect(409);
    expect(frozen.body.error.message).toContain('closed');
    await api().patch(`/api/v1/lots/${ctx.lot1}`).set(h).send({ supplierId: ctx.supplier }).expect(409); // only a received lot has a supplier
  });

  it('lists with filters and offers open lots to pickers', async () => {
    const h = await as(ids.ownerA);
    const all = (await api().get('/api/v1/lots?sort=lotNumber&order=asc').set(h).expect(200)).body;
    expect(all.total).toBe(3);
    expect((await api().get('/api/v1/lots?origin=received').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/lots?productionOrderId=' + ctx.pinOrder).set(h).expect(200)).body.data.map((l: { lotNumber: string }) => l.lotNumber)).toEqual(['LOT-1']);
    expect((await api().get('/api/v1/lots?supplierId=' + ctx.supplier).set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/lots?status=closed').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/lots?q=heat').set(h).expect(200)).body.total).toBe(1);
    const pick = (await api().get('/api/v1/lots/lookup?partId=' + ctx.pin).set(h).expect(200)).body.data;
    expect(pick).toMatchObject([{ lotNumber: 'LOT-1', status: 'released', part: { partNumber: 'PIN-200' }, productionOrder: { orderNumber: 'WO-1002' } }]);
    expect((await api().get('/api/v1/lots/lookup?includeClosed=true').set(h).expect(200)).body.data).toHaveLength(3);
    expect((await api().get('/api/v1/lots/lookup').set(h).expect(200)).body.data.map((l: { lotNumber: string }) => l.lotNumber)).not.toContain('HEAT-77'); // closed
  });
});

describe('serial numbers', () => {
  it('creates one, takes the lot’s order and site, and refuses a lot of another part', async () => {
    const h = await as(ids.ownerA);
    const one = await api().post('/api/v1/serial-numbers').set(h).send({ partId: ctx.pin, lotId: ctx.lot1, serialNumber: 'SN-0001' }).expect(201);
    expect(one.body.data).toMatchObject([{ serialNumber: 'SN-0001', status: 'in_production', lot: { lotNumber: 'LOT-1' }, productionOrder: { orderNumber: 'WO-1002' }, site: { id: ids.siteA } }]);
    ctx.sn1 = one.body.data[0].id;
    const wrong = await api().post('/api/v1/serial-numbers').set(h).send({ partId: ctx.rod, lotId: ctx.lot1, serialNumber: 'SN-X' }).expect(409);
    expect(wrong.body.error).toMatchObject({ code: 'production_rule', message: expect.stringContaining('another part') });
    const dup = await api().post('/api/v1/serial-numbers').set(h).send({ partId: ctx.pin, serialNumber: 'sn-0001' }).expect(409);
    expect(dup.body.error.message).toBe('This part already has a serial number like that');
    await api().post('/api/v1/serial-numbers').set(h).send({ partId: ctx.pin }).expect(400); // none of serialNumber, serials, range
    await api().post('/api/v1/serial-numbers').set(h).send({ partId: ctx.pin, serialNumber: 'A', serials: ['B'] }).expect(400); // two of them
  });

  it('creates a list and a numbered range, all or nothing', async () => {
    const h = await as(ids.ownerA);
    const list = await api().post('/api/v1/serial-numbers').set(h).send({ partId: ctx.pin, lotId: ctx.lot1, serials: ['SN-0100', 'SN-0101'] }).expect(201);
    expect(list.body.data.map((s: { serialNumber: string }) => s.serialNumber)).toEqual(['SN-0100', 'SN-0101']);
    const range = await api().post('/api/v1/serial-numbers').set(h).send({ partId: ctx.pin, lotId: ctx.lot1, range: { prefix: 'SN-', from: 2, to: 6, pad: 4 } }).expect(201);
    expect(range.body.data.map((s: { serialNumber: string }) => s.serialNumber)).toEqual(['SN-0002', 'SN-0003', 'SN-0004', 'SN-0005', 'SN-0006']);
    // Made together they share a timestamp: newest first still lists them in number order.
    const listed = (await api().get('/api/v1/serial-numbers?lotId=' + ctx.lot1 + '&sort=createdAt&order=desc&pageSize=200').set(h).expect(200)).body.data.map((s: { serialNumber: string }) => s.serialNumber);
    const batch = listed.filter((n: string) => ['SN-0002', 'SN-0003', 'SN-0004', 'SN-0005', 'SN-0006'].includes(n));
    expect(batch).toEqual(['SN-0002', 'SN-0003', 'SN-0004', 'SN-0005', 'SN-0006']);

    // A range with no lot, then a range that runs into SN-0009: none of the second is created.
    const clash = await api().post('/api/v1/serial-numbers').set(h).send({ partId: ctx.pin, range: { prefix: 'SN-', from: 7, to: 9, pad: 4 } }).expect(201);
    expect(clash.body.data).toHaveLength(3);
    const before = (await api().get('/api/v1/serial-numbers?partId=' + ctx.pin).set(h).expect(200)).body.total;
    await api().post('/api/v1/serial-numbers').set(h).send({ partId: ctx.pin, range: { prefix: 'SN-', from: 9, to: 12, pad: 4 } }).expect(409);
    expect((await api().get('/api/v1/serial-numbers?partId=' + ctx.pin).set(h).expect(200)).body.total).toBe(before);
    const twice = await api().post('/api/v1/serial-numbers').set(h).send({ partId: ctx.pin, serials: ['DUP', 'dup'] }).expect(409);
    expect(twice.body.error.message).toBe('The list names the same serial number twice');
    await api().post('/api/v1/serial-numbers').set(h).send({ partId: ctx.pin, range: { from: 5, to: 1 } }).expect(400);
    await api().post('/api/v1/serial-numbers').set(h).send({ partId: ctx.pin, range: { from: 1, to: 501 } }).expect(400);
    await api().post('/api/v1/serial-numbers').set(h).send({ partId: ctx.pin, serials: Array.from({ length: 501 }, (_, i) => `S${i}`) }).expect(400);
  });

  it('lists with filters, offers serials to pickers, and scraps with a reason (then freezes)', async () => {
    const h = await as(ids.ownerA);
    const inLot = (await api().get('/api/v1/serial-numbers?lotId=' + ctx.lot1 + '&sort=serialNumber&order=asc&pageSize=3').set(h).expect(200)).body;
    expect(inLot.total).toBe(8);
    expect(inLot.data.map((s: { serialNumber: string }) => s.serialNumber)).toEqual(['SN-0001', 'SN-0002', 'SN-0003']);
    expect((await api().get('/api/v1/serial-numbers?q=0100').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/lots/' + ctx.lot1).set(h).expect(200)).body.serialCount).toBe(8);
    expect((await api().get('/api/v1/production-orders/' + ctx.pinOrder).set(h).expect(200)).body).toMatchObject({ lotCount: 1, serialCount: 8 });

    const noReason = await api().patch(`/api/v1/serial-numbers/${ctx.sn1}`).set(h).send({ status: 'scrapped' }).expect(409);
    expect(noReason.body.error.code).toBe('production_rule');
    await api().patch(`/api/v1/serial-numbers/${ctx.sn1}`).set(h).send({ status: 'completed' }).expect(200);
    const scrapped = await api().patch(`/api/v1/serial-numbers/${ctx.sn1}`).set(h).send({ status: 'scrapped', statusReason: 'Cracked' }).expect(200);
    expect(scrapped.body).toMatchObject({ status: 'scrapped', statusReason: 'Cracked' });
    const frozen = await api().patch(`/api/v1/serial-numbers/${ctx.sn1}`).set(h).send({ notes: 'late' }).expect(409);
    expect(frozen.body.error.message).toContain('scrapped');
    const pick = (await api().get('/api/v1/serial-numbers/lookup?lotId=' + ctx.lot1).set(h).expect(200)).body.data;
    expect(pick).toHaveLength(7); // the scrapped one is left out
    expect((await api().get('/api/v1/serial-numbers/lookup?includeClosed=true&lotId=' + ctx.lot1).set(h).expect(200)).body.data).toHaveLength(8);
  });
});

describe('permissions and tenancy', () => {
  it('lets a reader (inspector) read and pick but not create or change anything', async () => {
    const h = await as(ids.inspectorA);
    expect((await api().get('/api/v1/production-orders').set(h).expect(200)).body.total).toBeGreaterThan(0);
    await api().get('/api/v1/lots/lookup').set(h).expect(200);
    await api().get('/api/v1/serial-numbers/lookup').set(h).expect(200);
    await api().post('/api/v1/production-orders').set(h).send({ orderNumber: 'WO-NOPE', partId: ctx.rod, quantityPlanned: 1 }).expect(403);
    await api().post('/api/v1/lots').set(h).send({ lotNumber: 'NOPE', partId: ctx.rod, origin: 'produced' }).expect(403);
    await api().post('/api/v1/serial-numbers').set(h).send({ partId: ctx.rod, serialNumber: 'NOPE' }).expect(403);
    await api().patch(`/api/v1/lots/${ctx.lot1}`).set(h).send({ notes: 'x' }).expect(403);
    await api().patch(`/api/v1/production-orders/${ctx.pinOrder}`).set(h).send({ notes: 'x' }).expect(403);
  });

  it('shows another organisation none of it and refuses linking its records', async () => {
    const h = await as(ids.ownerB, ids.orgB);
    expect((await api().get('/api/v1/production-orders').set(h).expect(200)).body.total).toBe(0);
    expect((await api().get('/api/v1/lots').set(h).expect(200)).body.total).toBe(0);
    expect((await api().get('/api/v1/serial-numbers').set(h).expect(200)).body.total).toBe(0);
    await api().get(`/api/v1/lots/${ctx.lot1}`).set(h).expect(404);
    const second = await api().post('/api/v1/parts').set(h).send({ partNumber: 'B-1', name: 'B', initialRevision: { revision: 'A' } }).expect(201);
    // A lot cannot be made for another organisation's part or order.
    const res = await api().post('/api/v1/lots').set(h).send({ lotNumber: 'X', partId: ctx.pin, origin: 'produced' });
    expect([400, 403, 409]).toContain(res.status);
    const res2 = await api().post('/api/v1/lots').set(h).send({ lotNumber: 'X', partId: second.body.id, origin: 'produced', productionOrderId: ctx.pinOrder });
    expect([400, 403, 409]).toContain(res2.status);
  });

  it('gives an order the only site an organisation has when none is named', async () => {
    const h = await as(ids.ownerB, ids.orgB);
    const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'B-2', name: 'B two', initialRevision: { revision: 'A' } }).expect(201)).body;
    const order = await api().post('/api/v1/production-orders').set(h).send({ orderNumber: 'B-WO-1', partId: part.id, quantityPlanned: 3 }).expect(201);
    expect(order.body.site).toMatchObject({ id: ids.siteB });
  });

  it('keeps the audit trail of what changed', async () => {
    const { rows } = await admin.query(`select count(*)::int as n from public.audit_events where organisation_id = $1 and entity_type = 'lots' and action = 'update'`, [ids.orgA]);
    expect(rows[0].n).toBeGreaterThan(0);
  });
});
