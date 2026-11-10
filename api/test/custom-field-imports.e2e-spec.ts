/**
 * Custom fields CF4 through the API: the import catalogue offers the organisation's active custom fields (`cf_<key>`, a field required on save is
 * required in the mapping), a real import writes them (choices by label, several choices as a comma list, people by email address, numbers), a row
 * the database refuses fails on its own, and a blank cell never clears a stored value.
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

const ids = makeIds('cb');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const owner = async () => ({ Authorization: `Bearer ${await token(ids.ownerA)}`, 'X-Organisation-Id': ids.orgA });
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
  await seed(admin, ids, '-cfi');
  await giveControllerSeats(admin, ids.orgA, [ids.ownerA]);
  await admin.query(`update auth.users set email = 'ada@alpha.test' where id = $1`, [ids.ownerA]);
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

describe('importing custom fields', () => {
  let connId: string;
  let site: string;
  const upload = async (name: string, text: string): Promise<string> => {
    const path = `${ids.orgA}/integration/${connId}/${Math.random().toString(36).slice(2)}-${name}`;
    files.set(path, strToU8(text));
    return (await api().post(`${base}/connections/${connId}/files`).set(await owner()).send({ path, fileName: name, size: text.length }).expect(201)).body.id;
  };
  const run = async (fileId: string) => (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'machine', kind: 'full', fileId }).expect(201)).body;
  const values = async (code: string) =>
    (await admin.query(`select v."values" from public.machines m left join public.custom_field_values v on v.record_id = m.id where m.organisation_id = $1 and m.code = $2`, [ids.orgA, code])).rows[0]?.values;
  const fields = [
    { target: 'code', source: 'Code' },
    { target: 'name', source: 'Name' },
    { target: 'site', source: 'Site', match: 'code' },
    { target: 'cf_asset_tag', source: 'Tag' },
    { target: 'cf_criticality', source: 'Criticality' },
    { target: 'cf_shifts', source: 'Shifts' },
    { target: 'cf_owner', source: 'Owner' },
    { target: 'cf_power', source: 'Power' },
  ];

  beforeAll(async () => {
    const h = await owner();
    const add = (body: object) => api().post('/api/v1/custom-fields').set(h).send({ entityType: 'machine', ...body }).expect(201);
    await add({ fieldType: 'text', label: 'Asset tag', requiredAt: 'save' });
    await add({ fieldType: 'choice', label: 'Criticality', options: [{ key: 'high', label: 'High' }, { key: 'low', label: 'Low' }] });
    await add({ fieldType: 'multi_choice', label: 'Shifts', options: [{ key: 'days', label: 'Days' }, { key: 'nights', label: 'Nights' }] });
    await add({ fieldType: 'person', label: 'Owner' });
    await add({ fieldType: 'number', label: 'Power', unit: 'kW', decimals: 1 });
    connId = (await api().post(`${base}/connections`).set(h).send({ providerKey: 'csv', name: 'Plant list', externalSystem: 'plant' }).expect(201)).body.id;
    await api().put(`${base}/connections/${connId}/settings`).set(h).send({ entityType: 'machine', writeMode: 'add_update' }).expect(200);
    site = (await admin.query(`select code from public.sites where organisation_id = $1 order by created_at limit 1`, [ids.orgA])).rows[0].code;
  });

  it('offers the custom fields in the catalogue, a field required on save as required', async () => {
    const body = (await api().get(`${base}/entities`).set(await owner()).expect(200)).body;
    const machine = body.data.find((e: { entityType: string }) => e.entityType === 'machine');
    const custom = machine.fields.filter((f: { custom: boolean }) => f.custom);
    expect(custom.map((f: { key: string }) => f.key)).toEqual(['cf_asset_tag', 'cf_criticality', 'cf_shifts', 'cf_owner', 'cf_power']);
    expect(custom[0]).toMatchObject({ label: 'Asset tag', required: true, type: 'text' });
    expect(custom[1]).toMatchObject({ type: 'enum', options: [{ value: 'high', label: 'High' }, { value: 'low', label: 'Low' }] });
    expect(custom[4]).toMatchObject({ type: 'number' });
    expect(machine.fields.find((f: { key: string }) => f.key === 'code').custom).toBe(false);
  });

  it('refuses a mapping that leaves out a field required on save', async () => {
    const fileId = await upload('m0.csv', 'Id,Code,Name,Site,Tag\n1,X,Y,MAIN,T');
    const res = await api().put(`${base}/connections/${connId}/mapping`).set(await owner()).send({ entityType: 'machine', keyField: 'Id', fileId, fields: fields.slice(0, 3) });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/Asset tag is required/);
  });

  it('imports the values, turning labels, lists and email addresses into what is stored; a refused row fails alone', async () => {
    const fileId = await upload('machines.csv', [
      'Id,Code,Name,Site,Tag,Criticality,Shifts,Owner,Power',
      `1,CNC-01,Lathe,${site},AT-1,high,"Days, Nights",ada@alpha.test,7.5`,
      `2,MILL-02,Mill,${site},AT-2,Low,Nights,,`,
      `3,DRILL-03,Drill,${site},AT-3,,,nobody@else.test,`,
      `4,SAW-04,Saw,${site},,,,,`,
    ].join('\n'));
    await api().put(`${base}/connections/${connId}/mapping`).set(await owner()).send({ entityType: 'machine', keyField: 'Id', fileId, fields }).expect(200);
    const res = await run(fileId);
    expect(res.counts).toMatchObject({ total: 4, created: 2, rejected: 1, failed: 1 });
    expect(await values('CNC-01')).toEqual({ asset_tag: 'AT-1', criticality: 'high', shifts: ['days', 'nights'], owner: ids.ownerA, power: 7.5 });
    expect(await values('MILL-02')).toEqual({ asset_tag: 'AT-2', criticality: 'low', shifts: ['nights'] });
    const failed = (await admin.query(`select errors from public.integration_inbox where run_id = $1 and status = 'failed'`, [res.id])).rows;
    expect(JSON.stringify(failed)).toMatch(/Owner: nobody in the organisation is called or has the email address/);
    expect((await admin.query(`select count(*)::int as n from public.machines where organisation_id = $1 and code in ('DRILL-03', 'SAW-04')`, [ids.orgA])).rows[0].n).toBe(0);
    const rejected = (await api().get(`${base}/runs/${res.id}/rows?status=rejected`).set(await owner()).expect(200)).body.data;
    expect(rejected[0].errors[0]).toMatchObject({ field: 'cf_asset_tag', message: 'Asset tag is required' });
  });

  it('updates a changed value and never clears one from a blank cell; the same file again writes nothing', async () => {
    const fileId = await upload('machines-v2.csv', ['Id,Code,Name,Site,Tag,Criticality,Shifts,Owner,Power', `1,CNC-01,Lathe,${site},AT-1,Low,,,8`].join('\n'));
    const res = await run(fileId);
    expect(res.counts).toMatchObject({ updated: 1 });
    expect(await values('CNC-01')).toEqual({ asset_tag: 'AT-1', criticality: 'low', shifts: ['days', 'nights'], owner: ids.ownerA, power: 8 });
    expect((await run(fileId)).counts).toMatchObject({ unchanged: 1, updated: 0 });
  });
});
