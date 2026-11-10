/**
 * Integrations IN5 through the API: production orders imported from a file with a template (status kept, the reserved external ids filled), a later file
 * updating only the fields the source owns, "Fortress wins" fields left alone, "Review" fields parked in the review queue, accepting and rejecting them, and
 * who may see and decide. Also: a template refuses "Review" on a field that cannot be reviewed.
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

const ids = makeIds('5e');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const owner = () => as(ids.ownerA);
const inspector = () => as(ids.inspectorA);
const other = () => as(ids.ownerB, ids.orgB);
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
  await seed(admin, ids, '-ow');
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

describe('production orders, field ownership and the review queue', () => {
  let connId: string;
  let templateId: string;
  let partId: string;
  const upload = async (name: string, lines: string[]): Promise<string> => {
    const text = lines.join('\n');
    const path = `${ids.orgA}/integration/${connId}/${Math.random().toString(36).slice(2)}-${name}`;
    files.set(path, strToU8(text));
    return (await api().post(`${base}/connections/${connId}/files`).set(await owner()).send({ path, fileName: name, size: text.length }).expect(201)).body.id;
  };
  const run = async (fileId: string, kind: 'preview' | 'full' = 'full') =>
    (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'production_order', kind, fileId, templateId }).expect(201)).body;
  const order = async (number: string) =>
    (await admin.query(`select status, quantity_planned::float as qty, due_date::text as due, notes, external_system, external_id, customer_id from public.production_orders where organisation_id = $1 and order_number = $2`, [ids.orgA, number])).rows[0];
  const header = 'Id,No,Part,Qty,Due,Status,Notes,Cust';
  const STATUS = { Open: 'planned', Rel: 'released', WIP: 'in_progress', Done: 'completed' };

  it('offers production orders as importable', async () => {
    partId = (await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'PO-PART', 'Shaft') returning id`, [ids.orgA])).rows[0].id;
    await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'OWNCUST', 'Own customer')`, [ids.orgA]);
    const c = (await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'csv', name: 'ERP export', externalSystem: 'erp' }).expect(201)).body;
    connId = c.id;
    expect(c.importable).toContain('production_order');
    expect(c.writable).toContain('production_order');
    const entities = (await api().get(`${base}/entities`).set(await owner()).expect(200)).body.data;
    const po = entities.find((e: { entityType: string }) => e.entityType === 'production_order');
    expect(po.fields.map((f: { key: string }) => f.key)).toEqual(expect.arrayContaining(['orderNumber', 'part', 'quantityPlanned', 'status', 'partRevision']));
  });

  it('a template cannot hold a field for review that only ever adds', async () => {
    const res = await api().post(`${base}/templates`).set(await owner()).send({
      entityType: 'part', name: 'Parts with review', keyField: 'Id',
      fields: [{ target: 'partNumber', source: 'No' }, { target: 'name', source: 'Name' }, { target: 'revision', source: 'Rev', ownership: 'manual_review' }],
    }).expect(409);
    expect(JSON.stringify(res.body)).toMatch(/cannot be held for review/);
  });

  it('imports orders with their status and the source\'s identity', async () => {
    templateId = (await api().post(`${base}/templates`).set(await owner()).send({
      entityType: 'production_order', name: 'ERP orders', keyField: 'Id', settings: { writeMode: 'add_update' },
      fields: [
        { target: 'orderNumber', source: 'No' },
        { target: 'part', source: 'Part' },
        { target: 'quantityPlanned', source: 'Qty', ownership: 'manual_review' },
        { target: 'dueDate', source: 'Due', ownership: 'qms_wins' },
        { target: 'status', source: 'Status', transform: 'map', values: STATUS, ownership: 'manual_review' },
        { target: 'notes', source: 'Notes' },
        { target: 'customer', source: 'Cust', ownership: 'manual_review' },
      ],
    }).expect(201)).body.id;
    const fileId = await upload('orders.csv', [header, '9001,WO-9001,PO-PART,100,2026-12-01,WIP,First,', '9002,WO-9002,PO-PART,50,2026-12-15,Open,Second,']);
    const res = await run(fileId);
    expect(res).toMatchObject({ status: 'succeeded', counts: { created: 2, parked: 0 } });
    expect(await order('WO-9001')).toMatchObject({ status: 'in_progress', qty: 100, external_system: expect.any(String), external_id: '9001' });
    expect(await order('WO-9002')).toMatchObject({ status: 'planned', due: '2026-12-15' });
  });

  it('a later file writes what the source owns, leaves what Fortress owns, and parks what must be reviewed', async () => {
    const fileId = await upload('orders-2.csv', [header, '9001,WO-9001,PO-PART,120,2027-01-31,WIP,Changed,OWNCUST', '9002,WO-9002,PO-PART,50,2027-02-01,Rel,Second again,']);
    const res = await run(fileId);
    expect(res).toMatchObject({ status: 'succeeded', counts: { updated: 2, parked: 3 } });
    expect(await order('WO-9001')).toMatchObject({ notes: 'Changed', qty: 100, due: '2026-12-01', customer_id: null, status: 'in_progress' });
    expect(await order('WO-9002')).toMatchObject({ notes: 'Second again', due: '2026-12-15', status: 'planned' });

    const queue = (await api().get(`${base}/conflicts`).set(await owner()).expect(200)).body;
    expect(queue).toMatchObject({ total: 3, openCount: 3 });
    const byField = Object.fromEntries(queue.data.map((c: { field: { key: string }; record: { label: string } }) => [`${c.record.label}:${c.field.key}`, c]));
    expect(byField['WO-9001:quantityPlanned']).toMatchObject({ field: { label: 'Quantity planned' }, fortressValue: '100', sourceValue: '120', status: 'open', canDecide: true, externalId: '9001' });
    expect(byField['WO-9001:customer']).toMatchObject({ fortressValue: null, sourceValue: 'OWNCUST' });
    expect(byField['WO-9002:status']).toMatchObject({ fortressValue: 'Planned', sourceValue: 'Released', applyError: null });
    const forRun = (await api().get(`${base}/conflicts?runId=${res.id}&entityType=production_order`).set(await owner()).expect(200)).body;
    expect(forRun.total).toBe(3);
  });

  it('accepting writes the value; rejecting needs a reason and keeps Fortress\'s', async () => {
    const queue = (await api().get(`${base}/conflicts`).set(await owner()).expect(200)).body.data;
    const qty = queue.find((c: { field: { key: string } }) => c.field.key === 'quantityPlanned');
    const status = queue.find((c: { field: { key: string } }) => c.field.key === 'status');
    const cust = queue.find((c: { field: { key: string } }) => c.field.key === 'customer');

    const accepted = (await api().post(`${base}/conflicts/${qty.id}/accept`).set(await owner()).send({}).expect(200)).body;
    expect(accepted).toMatchObject({ status: 'accepted', canDecide: false, decidedBy: { id: ids.ownerA } });
    expect((await order('WO-9001')).qty).toBe(120);
    await api().post(`${base}/conflicts/${qty.id}/accept`).set(await owner()).send({}).expect(409);

    await api().post(`${base}/conflicts/${status.id}/accept`).set(await owner()).send({ note: 'Released in ERP' }).expect(200);
    expect((await order('WO-9002')).status).toBe('released');

    await api().post(`${base}/conflicts/${cust.id}/reject`).set(await owner()).send({ reason: '' }).expect(400);
    const rejected = (await api().post(`${base}/conflicts/${cust.id}/reject`).set(await owner()).send({ reason: 'Stock order, no customer' }).expect(200)).body;
    expect(rejected).toMatchObject({ status: 'rejected', decisionNote: 'Stock order, no customer' });
    expect((await order('WO-9001')).customer_id).toBeNull();

    const open = (await api().get(`${base}/conflicts`).set(await owner()).expect(200)).body;
    expect(open).toMatchObject({ total: 0, openCount: 0 });
    const decided = (await api().get(`${base}/conflicts?status=decided`).set(await owner()).expect(200)).body;
    expect(decided.total).toBe(3);
  });

  it('a value someone rejected is not asked about again', async () => {
    const fileId = await upload('orders-3.csv', [header, '9001,WO-9001,PO-PART,120,2027-01-31,WIP,Third,OWNCUST', '9002,WO-9002,PO-PART,50,2027-02-01,Rel,Second again,']);
    const res = await run(fileId);
    expect(res).toMatchObject({ counts: { updated: 1, unchanged: 1, parked: 0 } });
    expect((await api().get(`${base}/conflicts`).set(await owner()).expect(200)).body.openCount).toBe(0);
  });

  it('only people who may read integrations see the queue, and another organisation sees none of it', async () => {
    await api().get(`${base}/conflicts`).set(await inspector()).expect(403);
    const theirs = (await api().get(`${base}/conflicts?status=all`).set(await other()).expect(200)).body;
    expect(theirs.total).toBe(0);
    const anyId = (await admin.query(`select id from public.integration_conflicts where organisation_id = $1 limit 1`, [ids.orgA])).rows[0].id;
    await api().post(`${base}/conflicts/${anyId}/accept`).set(await other()).send({}).expect(404);
    await api().post(`${base}/conflicts/${anyId}/accept`).set(await owner()).send({ extra: 1 }).expect(400);
  });
});
