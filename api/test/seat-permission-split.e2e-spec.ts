/**
 * The split of bundled permissions through the API (migration 20260466100000): an inspector records deliveries and shipments but does not manage orders or their
 * dates, adds files and containment only to non-conformances they raised, and does not acknowledge a failed reading; a manager does all of it.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { categoryId, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('5c01');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const manager = () => as(ids.ownerA);
const inspector = () => as(ids.inspectorA);
const ctx: Record<string, string> = {};
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-sps');
  ctx.supplier = (await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'SUP', 'Supply Co') returning id`, [ids.orgA])).rows[0].id;
  ctx.customer = (await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'ACME', 'Acme') returning id`, [ids.orgA])).rows[0].id;
  ctx.part = (await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'BRK-1', 'Bracket') returning id`, [ids.orgA])).rows[0].id;
  ctx.category = await categoryId(admin, ids.orgA);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('receiving', () => {
  it('lets an inspector record a delivery but not create, close, cancel or re-date an order, nor cancel a delivery', async () => {
    const m = await manager();
    const i = await inspector();
    const order = { supplierId: ctx.supplier, poNumber: 'PO-S1', lines: [{ partId: ctx.part, quantity: 100, requestedOn: day(5) }] };
    await api().post('/api/v1/purchase-orders').set(i).send(order).expect(403);
    const po = (await api().post('/api/v1/purchase-orders').set(m).send(order).expect(201)).body;
    const line = po.lines[0].id as string;

    await api().patch(`/api/v1/purchase-order-lines/${line}`).set(i).send({ agreedOn: day(30) }).expect(403);
    await api().post(`/api/v1/purchase-orders/${po.id}/close`).set(i).expect(403);
    await api().post(`/api/v1/purchase-orders/${po.id}/cancel`).set(i).send({ reason: 'No longer needed' }).expect(403);

    const receipt = (await api().post('/api/v1/goods-receipts').set(i).send({
      supplierId: ctx.supplier, purchaseOrderId: po.id, receivedOn: day(0), deliveryNote: 'DN-1', clientKey: 'sps-receipt-0001',
      lines: [{ poLineId: line, quantity: 40 }],
    }).expect(201)).body;
    await api().post(`/api/v1/goods-receipts/${receipt.id}/cancel`).set(i).send({ reason: 'Keyed twice' }).expect(403);

    await api().patch(`/api/v1/purchase-order-lines/${line}`).set(m).send({ agreedOn: day(30) }).expect(200);
    await api().post(`/api/v1/goods-receipts/${receipt.id}/cancel`).set(m).send({ reason: 'Keyed twice' }).expect(200);
  });
});

describe('shipping', () => {
  it('lets an inspector record a shipment but not create, close, cancel or re-date a customer order, nor cancel a shipment', async () => {
    const m = await manager();
    const i = await inspector();
    const order = { customerId: ctx.customer, orderNumber: 'CO-S1', lines: [{ partId: ctx.part, quantity: 50, requestedOn: day(5) }] };
    await api().post('/api/v1/customer-orders').set(i).send(order).expect(403);
    const co = (await api().post('/api/v1/customer-orders').set(m).send(order).expect(201)).body;
    const line = co.lines[0].id as string;

    await api().patch(`/api/v1/customer-order-lines/${line}`).set(i).send({ agreedOn: day(30) }).expect(403);
    await api().post(`/api/v1/customer-orders/${co.id}/close`).set(i).expect(403);
    await api().post(`/api/v1/customer-orders/${co.id}/cancel`).set(i).send({ reason: 'Customer withdrew it' }).expect(403);

    const shipment = (await api().post('/api/v1/shipments').set(i).send({
      customerId: ctx.customer, customerOrderId: co.id, shippedOn: day(0), deliveryNote: 'DN-S1', clientKey: 'sps-shipment-0001',
      lines: [{ orderLineId: line, quantity: 20 }],
    }).expect(201)).body;
    await api().post(`/api/v1/shipments/${shipment.id}/cancel`).set(i).send({ reason: 'Keyed twice' }).expect(403);
    await api().post(`/api/v1/shipments/${shipment.id}/cancel`).set(m).send({ reason: 'Keyed twice' }).expect(200);
  });
});

describe('non-conformances: contribute to your own', () => {
  const NC = () => ({ source: 'internal', title: 'Burr on edge', severity: 'minor', quantityAffected: 3, description: 'Found at the bench', categoryId: ctx.category, open: true });

  it('lets an inspector add a file and a containment action to an NC they raised, and not to a colleague\'s', async () => {
    const m = await manager();
    const i = await inspector();
    const mine = (await api().post('/api/v1/ncrs').set(i).send(NC()).expect(201)).body.id as string;
    const theirs = (await api().post('/api/v1/ncrs').set(m).send(NC()).expect(201)).body.id as string;
    for (const id of [mine, theirs]) await admin.query(`insert into storage.objects (bucket_id, name) values ('nc-files', $1)`, [`${ids.orgA}/ncr/${id}/a-photo.jpg`]).catch(() => undefined);

    const file = (id: string) => ({ storagePath: `${ids.orgA}/ncr/${id}/a-photo.jpg`, fileName: 'photo.jpg', contentType: 'image/jpeg', sizeBytes: 1000 });
    const attached = (await api().post(`/api/v1/ncrs/${mine}/attachments`).set(i).send(file(mine)).expect(201)).body;
    expect(attached.fileName).toBe('photo.jpg');
    await api().post(`/api/v1/ncrs/${theirs}/attachments`).set(i).send(file(theirs)).expect(403);

    const action = (await api().post(`/api/v1/ncrs/${mine}/containment-actions`).set(i).send({ kind: 'quarantine', description: 'Moved to the red cage' }).expect(201)).body;
    expect(action.status).toBe('open');
    await api().post(`/api/v1/ncrs/${theirs}/containment-actions`).set(i).send({ kind: 'quarantine', description: 'Moved to the red cage' }).expect(403);
    await api().post(`/api/v1/ncr-containment-actions/${action.id}/complete`).set(i).send({ note: 'Counted 3' }).expect(200);

    // contribute is not update: the NC itself, its stage and its costs stay with those who may update
    await api().patch(`/api/v1/ncrs/${mine}`).set(i).send({ title: 'Changed' }).expect(403);
    await api().put(`/api/v1/ncrs/${mine}/containment-reason`).set(i).send({ reason: 'None needed' }).expect(403);
  });
});

describe('acknowledging a failed reading', () => {
  it('is for those who hold inspection.acknowledge_failure, not for the person who measured', async () => {
    const unknownReading = '00000000-0000-4000-8000-0000000000aa';
    await api().post(`/api/v1/inspection-measurements/${unknownReading}/acknowledge`).set(await inspector()).send({ note: 'ok' }).expect(403);
    await api().post(`/api/v1/inspection-measurements/${unknownReading}/acknowledge`).set(await manager()).send({ note: 'ok' }).expect(404);
  });
});

describe('what the packages say', () => {
  it('lists the new permissions with the level they need', async () => {
    const list = (await api().get('/api/v1/permissions').set(await manager()).expect(200)).body.data as { code: string; needs: string | null }[];
    const needs = (code: string) => list.find((p) => p.code === code)?.needs;
    expect(needs('ncr.contribute')).toBe('operator'); // the Operator seat raises NCs, so it adds files to its own
    expect(needs('receiving.record')).toBe('contributor');
    expect(needs('shipping.record')).toBe('contributor');
    expect(needs('inspection.acknowledge_failure')).toBe('controller');
    expect(needs('receiving.manage')).toBe('controller');
    expect(needs('shipping.manage')).toBe('controller');
    expect(needs('change.approve')).toBe('controller');
    expect(needs('audit.read')).toBe('controller');
  });
});
