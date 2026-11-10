/**
 * Integrations IN6 through the API: purchase orders from a file with one row per order line (the key column is the order number; Fortress adds the line
 * number), the same file again writing nothing, and a later file changing what the source owns while the requested date stays as it was.
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

const ids = makeIds('5f');
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
  await seed(admin, ids, '-pu');
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

describe('purchase orders from a file', () => {
  let connId: string;
  let templateId: string;
  const upload = async (name: string, lines: string[]): Promise<string> => {
    const text = lines.join('\n');
    const path = `${ids.orgA}/integration/${connId}/${Math.random().toString(36).slice(2)}-${name}`;
    files.set(path, strToU8(text));
    return (await api().post(`${base}/connections/${connId}/files`).set(await owner()).send({ path, fileName: name, size: text.length }).expect(201)).body.id;
  };
  const run = async (entityType: string, fileId: string, kind: 'preview' | 'full' = 'full') =>
    (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType, kind, fileId, templateId }).expect(201)).body;
  const lines = async () =>
    (
      await admin.query(
        `select o.po_number, l.line_number, o.status as order_status, l.status, l.quantity_ordered::float as qty, l.requested_on::text as requested, l.agreed_on::text as agreed
           from public.purchase_order_lines l join public.purchase_orders o on o.id = l.purchase_order_id where o.organisation_id = $1 order by 1, 2`,
        [ids.orgA],
      )
    ).rows;

  it('offers purchase orders, keyed by order number and line', async () => {
    await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ACME', 'Acme Ltd')`, [ids.orgA]);
    const c = (await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'csv', name: 'ERP export', externalSystem: 'erp' }).expect(201)).body;
    connId = c.id;
    expect(c.importable).toContain('purchase_order');
    expect(c.writable).toContain('purchase_order');
    const entities = (await api().get(`${base}/entities`).set(await owner()).expect(200)).body.data;
    const po = entities.find((e: { entityType: string }) => e.entityType === 'purchase_order');
    expect(po.keyHint).toMatch(/adds the line number/);
    expect(po.fields.find((f: { key: string }) => f.key === 'requestedOn')).toMatchObject({ required: true, reviewable: false });
  });

  it('imports order lines, grouping them into orders', async () => {
    templateId = (await api().post(`${base}/templates`).set(await owner()).send({
      entityType: 'purchase_order', name: 'ERP order lines', keyField: 'PO', settings: { writeMode: 'add_update' },
      fields: [
        { target: 'poNumber', source: 'PO' }, { target: 'lineNumber', source: 'Line' }, { target: 'supplier', source: 'Vendor' },
        { target: 'material', source: 'Item' }, { target: 'quantityOrdered', source: 'Qty' }, { target: 'requestedOn', source: 'Need by' },
        { target: 'agreedOn', source: 'Promised' }, { target: 'lineStatus', source: 'State', transform: 'map', values: { O: 'open', C: 'closed', X: 'cancelled' } },
      ],
    }).expect(201)).body.id;
    const header = 'PO,Line,Vendor,Item,Qty,Need by,Promised,State';
    const fileId = await upload('po.csv', [header, 'PO-1,1,ACME,Steel bar,100,2026-10-01,,O', 'PO-1,2,ACME,Bolts,500,2026-10-08,,O', 'PO-2,1,ACME,Washers,1000,2026-10-15,,C']);
    const preview = await run('purchase_order', fileId, 'preview');
    expect(preview).toMatchObject({ status: 'succeeded', counts: { total: 3, created: 3 } });
    const res = await run('purchase_order', fileId);
    expect(res).toMatchObject({ status: 'succeeded', counts: { created: 3 } });
    expect(await lines()).toEqual([
      { po_number: 'PO-1', line_number: 1, order_status: 'open', status: 'open', qty: 100, requested: '2026-10-01', agreed: null },
      { po_number: 'PO-1', line_number: 2, order_status: 'open', status: 'open', qty: 500, requested: '2026-10-08', agreed: null },
      { po_number: 'PO-2', line_number: 1, order_status: 'closed', status: 'closed', qty: 1000, requested: '2026-10-15', agreed: null },
    ]);
    const map = (await admin.query(`select external_id from public.integration_external_records where connection_id = $1 order by 1`, [connId])).rows.map((r) => r.external_id);
    expect(map).toEqual(['PO-1/1', 'PO-1/2', 'PO-2/1']);
    const again = await run('purchase_order', fileId);
    expect(again).toMatchObject({ counts: { unchanged: 3, created: 0, updated: 0 } });
  });

  it('a later file changes what the source owns; the requested date stays', async () => {
    const header = 'PO,Line,Vendor,Item,Qty,Need by,Promised,State';
    const fileId = await upload('po-2.csv', [header, 'PO-1,1,ACME,Steel bar,120,2026-12-31,2026-10-20,C', 'PO-1,2,ACME,Bolts,500,2026-10-08,,C', 'PO-2,1,ACME,Washers,1000,2026-10-15,,C']);
    const res = await run('purchase_order', fileId);
    expect(res).toMatchObject({ counts: { updated: 2, unchanged: 1 } });
    expect((await lines())[0]).toEqual({ po_number: 'PO-1', line_number: 1, order_status: 'closed', status: 'closed', qty: 120, requested: '2026-10-01', agreed: '2026-10-20' });
  });

  it('a row with no line number is rejected before anything is written', async () => {
    const fileId = await upload('po-3.csv', ['PO,Line,Vendor,Item,Qty,Need by,Promised,State', 'PO-3,,ACME,Nuts,5,2026-11-01,,O']);
    const res = await run('purchase_order', fileId, 'preview');
    expect(res.counts).toMatchObject({ rejected: 1 });
  });
});
