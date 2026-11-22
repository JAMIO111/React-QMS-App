/**
 * Import field locks through the API (docs/import-field-locks-plan.md): while a connection's schedule is on, the fields its template maps as "source wins"
 * on a record it imported are listed by GET /import-locks and a person's change to one is refused with 409 field_managed_by_import (naming the fields and
 * the connection); every other field still saves; switching the schedule off unlocks at once; another organisation's member is told nothing.
 */
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { makeIds, requireDb, seed, testEnv, token } from './helpers';

const ids = makeIds('9d4a');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });

let machineId: string;
let handMachineId: string;
let connectionId: string;

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-il');
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true });
  app = configureApp(nest, env);
  await app.init();

  machineId = (await admin.query(`insert into public.machines (organisation_id, code, name) values ($1, 'CNC-1', 'Lathe') returning id`, [ids.orgA])).rows[0].id;
  handMachineId = (await admin.query(`insert into public.machines (organisation_id, code, name) values ($1, 'HAND-1', 'By hand') returning id`, [ids.orgA])).rows[0].id;
  const provider = (await admin.query(`select id from public.integration_providers where key = 'rest_api'`)).rows[0].id;
  connectionId = (
    await admin.query(
      `insert into public.integration_connections (organisation_id, provider_id, name, external_system, status, config)
       values ($1, $2, 'ERP', 'erp', 'active', '{"baseUrl": "https://erp.example.com", "authType": "none"}'::jsonb) returning id`,
      [ids.orgA, provider],
    )
  ).rows[0].id;
  const template = (await admin.query(`insert into public.integration_templates (organisation_id, entity_type, name, current_version) values ($1, 'machine', 'ERP machines', 1) returning id`, [ids.orgA])).rows[0].id;
  await admin.query(
    `insert into public.integration_template_versions (organisation_id, template_id, version, key_field, fields, settings)
     values ($1, $2, 1, 'Id', $3::jsonb, '{"writeMode": "add_update"}'::jsonb)`,
    [ids.orgA, template, JSON.stringify([{ target: 'code', source: 'Code' }, { target: 'name', source: 'Name' }, { target: 'description', source: 'Desc', ownership: 'qms_wins' }])],
  );
  await admin.query(`insert into public.integration_import_settings (organisation_id, connection_id, entity_type, write_mode, schedule, template_id) values ($1, $2, 'machine', 'add_update', 'manual', $3)`, [
    ids.orgA,
    connectionId,
    template,
  ]);
  const run = '00000000-0000-0000-0000-0000000000aa';
  await admin.query(
    `insert into public.integration_external_records (organisation_id, connection_id, entity_type, external_id, internal_id, content_hash, first_run_id, last_run_id)
     values ($1, $2, 'machine', 'MC1', $3, 'x', $4, $4)`,
    [ids.orgA, connectionId, machineId, run],
  );
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const locks = async (user = ids.ownerA, org = ids.orgA, record = machineId) =>
  api().get(`/api/v1/import-locks?entityType=machine&recordId=${record}`).set(await as(user, org));
const setSchedule = (schedule: string) => admin.query(`update public.integration_import_settings set schedule = $1 where connection_id = $2 and entity_type = 'machine'`, [schedule, connectionId]);

describe('import field locks', () => {
  it('lists nothing while no schedule is on, and lets people edit', async () => {
    const res = await locks();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
    await api().patch(`/api/v1/machines/${machineId}`).set(await as(ids.ownerA)).send({ name: 'Lathe (edited)' }).expect(200);
  });

  it('lists the source-wins fields and the connection once a schedule is on', async () => {
    await setSchedule('daily');
    const res = await locks();
    expect(res.body.data).toEqual([
      { field: 'code', connection: { id: connectionId, name: 'ERP' } },
      { field: 'name', connection: { id: connectionId, name: 'ERP' } },
    ]);
  });

  it('refuses a change to a locked field with the fields and the connection', async () => {
    const res = await api().patch(`/api/v1/machines/${machineId}`).set(await as(ids.ownerA)).send({ name: 'Renamed' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('field_managed_by_import');
    expect(res.body.error.details).toEqual({ fields: ['name'], connection: 'ERP' });
    expect(res.body.error.message).toContain('Managed by ERP');
    const after = await admin.query(`select name from public.machines where id = $1`, [machineId]);
    expect(after.rows[0].name).toBe('Lathe (edited)');
  });

  it('still saves a field the template does not own, and an unchanged locked value', async () => {
    await api().patch(`/api/v1/machines/${machineId}`).set(await as(ids.ownerA)).send({ description: 'Mine', name: 'Lathe (edited)' }).expect(200);
    const after = await admin.query(`select description from public.machines where id = $1`, [machineId]);
    expect(after.rows[0].description).toBe('Mine');
  });

  it('says nothing about a record no import manages', async () => {
    expect((await locks(ids.ownerA, ids.orgA, handMachineId)).body).toEqual({ data: [] });
    await api().patch(`/api/v1/machines/${handMachineId}`).set(await as(ids.ownerA)).send({ name: 'Hand edit' }).expect(200);
  });

  it('tells a member of another organisation nothing', async () => {
    const res = await locks(ids.ownerB, ids.orgB);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
    await locks(ids.ownerB, ids.orgA).then((r) => expect([403, 404]).toContain(r.status));
  });

  it('refuses a kind of record that is never locked, and a bad id', async () => {
    await api().get(`/api/v1/import-locks?entityType=nonconformance&recordId=${machineId}`).set(await as(ids.ownerA)).expect(400);
    await api().get(`/api/v1/import-locks?entityType=machine&recordId=nope`).set(await as(ids.ownerA)).expect(400);
  });

  it('unlocks at once when the schedule is switched off', async () => {
    await setSchedule('manual');
    expect((await locks()).body).toEqual({ data: [] });
    await api().patch(`/api/v1/machines/${machineId}`).set(await as(ids.ownerA)).send({ name: 'Renamed by hand' }).expect(200);
  });
});
