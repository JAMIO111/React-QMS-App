/**
 * Integrations SH4 through the API: customer orders from a file with one row per order line, then shipments read from one inventory-transaction table
 * where only the rows of a chosen type are shipments (a record filter keeps them), grouped by document, linked to the order lines, with a lot that
 * already exists; a return is refused and a shipment never makes a lot. The same files again write nothing.
 */
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { strToU8 } from 'fflate';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { IntegrationFileStore } from '../src/integrations/core/file-store';
import { giveControllerSeats, makeIds, requireDb, seed, testEnv, token } from './helpers';

const ids = makeIds('7e');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const owner = () => as(ids.ownerA);
const base = '/api/v1/integrations';

const files = new Map<string, Uint8Array>();
class MemoryStore extends IntegrationFileStore {
  get enabled() {
    return true;
  }
  async download(path: string) {
    return files.get(path) ?? null;
  }
}

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-os');
  await giveControllerSeats(admin, ids.orgA, [ids.ownerA]);
  await giveControllerSeats(admin, ids.orgB, [ids.ownerB]);
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).overrideProvider(IntegrationFileStore).useValue(new MemoryStore()).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true });
  app = configureApp(nest, env);
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('customer orders and shipments from a file', () => {
  let connId: string;
  let orderTemplate: string;
  let shipTemplate: string;
  const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const upload = async (name: string, lines: string[]): Promise<string> => {
    const text = lines.join('\n');
    const path = `${ids.orgA}/integration/${connId}/${Math.random().toString(36).slice(2)}-${name}`;
    files.set(path, strToU8(text));
    return (await api().post(`${base}/connections/${connId}/files`).set(await owner()).send({ path, fileName: name, size: text.length }).expect(201)).body.id;
  };
  const run = async (entityType: string, fileId: string, templateId: string, kind: 'preview' | 'full' = 'full') =>
    (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType, kind, fileId, templateId }).expect(201)).body;

  it('offers customer orders and shipments as importable kinds', async () => {
    await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'BIGCO', 'Big Co')`, [ids.orgA]);
    const part = (await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'P-100', 'Bracket') returning id`, [ids.orgA])).rows[0].id;
    await admin.query(`insert into public.lots (organisation_id, part_id, lot_number, quantity, origin) values ($1, $2, 'LOT-7', 500, 'produced')`, [ids.orgA, part]);
    const c = (await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'csv', name: 'ERP export', externalSystem: 'erp' }).expect(201)).body;
    connId = c.id;
    expect(c.importable).toEqual(expect.arrayContaining(['customer_order', 'shipment']));
    expect(c.writable).toEqual(expect.arrayContaining(['customer_order', 'shipment']));
    const entities = (await api().get(`${base}/entities`).set(await owner()).expect(200)).body.data;
    const co = entities.find((e: { entityType: string }) => e.entityType === 'customer_order');
    expect(co.keyHint).toMatch(/adds the line number/);
    expect(co.fields.find((f: { key: string }) => f.key === 'requestedOn')).toMatchObject({ required: true });
  });

  it('imports order lines, grouping them into orders, and again with nothing written', async () => {
    orderTemplate = (await api().post(`${base}/templates`).set(await owner()).send({
      entityType: 'customer_order', name: 'ERP sales lines', keyField: 'SO', settings: { writeMode: 'add_update' },
      fields: [
        { target: 'orderNumber', source: 'SO' }, { target: 'lineNumber', source: 'Line' }, { target: 'customer', source: 'Cust' }, { target: 'part', source: 'Part' },
        { target: 'quantityOrdered', source: 'Qty' }, { target: 'requestedOn', source: 'Need by' }, { target: 'agreedOn', source: 'Promised' },
      ],
    }).expect(201)).body.id;
    const fileId = await upload('so.csv', ['SO,Line,Cust,Part,Qty,Need by,Promised', `SO-1,1,BIGCO,P-100,100,${day(20)},`, `SO-1,2,BIGCO,P-100,200,${day(10)},`]);
    expect(await run('customer_order', fileId, orderTemplate, 'preview')).toMatchObject({ status: 'succeeded', counts: { total: 2, created: 2 } });
    expect(await run('customer_order', fileId, orderTemplate)).toMatchObject({ status: 'succeeded', counts: { created: 2 } });
    const map = (await admin.query(`select external_id from public.integration_external_records where connection_id = $1 order by 1`, [connId])).rows.map((r) => r.external_id);
    expect(map).toEqual(['SO-1/1', 'SO-1/2']);
    expect(await run('customer_order', fileId, orderTemplate)).toMatchObject({ counts: { unchanged: 2, created: 0, updated: 0 } });
  });

  it('reads shipments from an inventory table through a filter; one document is one shipment; a return is refused; no lot is made', async () => {
    shipTemplate = (await api().post(`${base}/templates`).set(await owner()).send({
      entityType: 'shipment', name: 'ERP inventory shipments', keyField: 'Tx',
      settings: { filters: { mode: 'keep', match: 'all', rules: [{ column: 'Type', test: 'equals', value: 'SHP' }] } },
      fields: [
        { target: 'documentNumber', source: 'Doc' }, { target: 'orderNumber', source: 'SO' }, { target: 'orderLine', source: 'Line' }, { target: 'customer', source: 'Cust' },
        { target: 'part', source: 'Part' }, { target: 'shippedOn', source: 'Date' }, { target: 'quantity', source: 'Qty' }, { target: 'lotNumber', source: 'Lot' },
        { target: 'movement', source: 'Move' },
      ],
    }).expect(201)).body.id;
    const header = 'Tx,Type,Doc,SO,Line,Cust,Part,Date,Qty,Lot,Move';
    const fileId = await upload('inventory.csv', [
      header,
      `8001,SHP,DN-1,SO-1,1,BIGCO,P-100,${day(8)},60,LOT-7,shipment`,
      `8002,SHP,DN-1,SO-1,2,BIGCO,P-100,${day(8)},120,,shipment`,
      `8003,RCV,GRN-9,,,,P-100,${day(8)},500,,`,
      `8004,SHP,DN-2,SO-1,2,BIGCO,P-100,${day(3)},-10,,return`,
      `8005,SHP,DN-3,,,BIGCO,P-100,${day(2)},5,,shipment`,
    ]);
    const first = await run('shipment', fileId, shipTemplate);
    expect(first.counts).toMatchObject({ total: 5, filtered: 1, rejected: 1, created: 3 });

    const ships = (await admin.query(
      `select s.source_document as doc, s.shipped_on::text as on, count(l.*)::int as lines, sum(l.quantity_shipped)::float as qty, bool_or(l.lot_id is not null) as has_lot
         from public.shipments s join public.shipment_lines l on l.shipment_id = s.id where s.organisation_id = $1 group by 1, 2 order by 1`, [ids.orgA])).rows;
    expect(ships).toEqual([
      { doc: 'DN-1', on: day(8), lines: 2, qty: 180, has_lot: true },
      { doc: 'DN-3', on: day(2), lines: 1, qty: 5, has_lot: false },
    ]);
    expect((await admin.query(`select count(*)::int as n from public.lots where organisation_id = $1`, [ids.orgA])).rows[0].n).toBe(1);

    const rejected = (await api().get(`${base}/runs/${first.id}/rows?status=rejected`).set(await owner()).expect(200)).body.data;
    expect(rejected[0].errors[0].message).toMatch(/more than 0|return/i);

    const again = await run('shipment', fileId, shipTemplate);
    expect(again.counts).toMatchObject({ unchanged: 3, created: 0 });
    expect((await admin.query(`select count(*)::int as n from public.shipment_lines where organisation_id = $1`, [ids.orgA])).rows[0].n).toBe(3);
  });

  it('what shipped shows against the order lines', async () => {
    const order = (await admin.query(`select id from public.customer_orders where organisation_id = $1 and order_number = 'SO-1'`, [ids.orgA])).rows[0].id;
    const detail = (await api().get(`/api/v1/customer-orders/${order}`).set(await owner()).expect(200)).body;
    const byLine = Object.fromEntries(detail.lines.map((l: { lineNumber: number; quantityShipped: number }) => [l.lineNumber, l.quantityShipped]));
    expect(byLine).toEqual({ 1: 60, 2: 120 });
    await api().get(`${base}/connections/${connId}`).set(await as(ids.ownerB, ids.orgB)).expect(404);
  });
});
