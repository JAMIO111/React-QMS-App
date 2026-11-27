/**
 * Hand entry versus imports (docs/order-fulfilment-plan.md): while a scheduled import of purchase orders or deliveries is on, the API refuses a person's new
 * order or delivery with 409 record_managed_by_import (naming the area and the connection), GET /import-locks/managed-areas says which areas are owned so the
 * screens can close their buttons, and everything opens again the moment the schedule goes off. A person without the area's read permission is told nothing.
 */
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { makeIds, requireDb, seed, testEnv, token } from './helpers';

const ids = makeIds('9d4b');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });

let supplierId: string;
let connectionId: string;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const NEW_PO = (poNumber: string) => ({ supplierId, poNumber, lines: [{ material: 'Steel bar', quantity: 10, requestedOn: day(5) }] });
const NEW_DELIVERY = () => ({ supplierId, receivedOn: day(0), deliveryNote: 'DN-1', lines: [{ material: 'Steel bar', quantity: 5 }] });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-imm');
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true });
  app = configureApp(nest, env);
  await app.init();

  supplierId = (await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'STEEL', 'Steel Co') returning id`, [ids.orgA])).rows[0].id;
  const provider = (await admin.query(`select id from public.integration_providers where key = 'rest_api'`)).rows[0].id;
  connectionId = (
    await admin.query(
      `insert into public.integration_connections (organisation_id, provider_id, name, external_system, status, config)
       values ($1, $2, 'ERP', 'erp', 'active', '{"baseUrl": "https://erp.example.com", "authType": "none"}'::jsonb) returning id`,
      [ids.orgA, provider],
    )
  ).rows[0].id;
  for (const [entity, name] of [['purchase_order', 'ERP orders'], ['goods_receipt', 'ERP deliveries']] as const) {
    const template = (await admin.query(`insert into public.integration_templates (organisation_id, entity_type, name, current_version) values ($1, $2, $3, 1) returning id`, [ids.orgA, entity, name])).rows[0].id;
    await admin.query(
      `insert into public.integration_template_versions (organisation_id, template_id, version, key_field, fields, settings) values ($1, $2, 1, 'Id', $3::jsonb, '{"writeMode": "add_only"}'::jsonb)`,
      [ids.orgA, template, JSON.stringify([{ target: 'supplier', source: 'Vendor' }])],
    );
    await admin.query(`insert into public.integration_import_settings (organisation_id, connection_id, entity_type, write_mode, schedule, template_id) values ($1, $2, $3, 'add_only', 'manual', $4)`, [
      ids.orgA,
      connectionId,
      entity,
      template,
    ]);
  }
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const setSchedule = (entity: string, schedule: string) => admin.query(`update public.integration_import_settings set schedule = $1 where connection_id = $2 and entity_type = $3`, [schedule, connectionId, entity]);
const managed = async (user = ids.ownerA, org = ids.orgA) => (await api().get('/api/v1/import-locks/managed-areas').set(await as(user, org)).expect(200)).body;

describe('hand entry while an import owns the kind', () => {
  it('is open, and reported open, while nothing is scheduled', async () => {
    expect(await managed()).toEqual({ data: [] });
    await api().post('/api/v1/purchase-orders').set(await as(ids.ownerA)).send(NEW_PO('PO-HAND-1')).expect(201);
    await api().post('/api/v1/goods-receipts').set(await as(ids.ownerA)).send(NEW_DELIVERY()).expect(201);
  });

  it('refuses a new order once a schedule is on, naming the connection, and leaves deliveries open', async () => {
    await setSchedule('purchase_order', 'daily');
    const res = await api().post('/api/v1/purchase-orders').set(await as(ids.ownerA)).send(NEW_PO('PO-HAND-2'));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'record_managed_by_import', details: { area: 'purchase_orders', connection: 'ERP' } });
    expect(res.body.error.message).toContain('ERP');
    await api().post('/api/v1/goods-receipts').set(await as(ids.ownerA)).send(NEW_DELIVERY()).expect(201);
    expect(await managed()).toEqual({ data: [{ area: 'purchase_orders', connection: 'ERP' }] });
  });

  it('counts deliveries and says nothing to someone who cannot read them, or to another organisation', async () => {
    await setSchedule('goods_receipt', 'every_15m');
    await api().post('/api/v1/goods-receipts').set(await as(ids.ownerA)).send(NEW_DELIVERY()).expect(409);
    expect((await managed()).data.map((x: { area: string }) => x.area).sort()).toEqual(['purchase_orders', 'receipts']);
    expect(await managed(ids.ownerB, ids.orgB)).toEqual({ data: [] });
  });

  it('opens again the moment the schedules go off', async () => {
    await setSchedule('purchase_order', 'manual');
    await setSchedule('goods_receipt', 'manual');
    expect(await managed()).toEqual({ data: [] });
    await api().post('/api/v1/purchase-orders').set(await as(ids.ownerA)).send(NEW_PO('PO-HAND-3')).expect(201);
    await api().post('/api/v1/goods-receipts').set(await as(ids.ownerA)).send(NEW_DELIVERY()).expect(201);
  });
});
