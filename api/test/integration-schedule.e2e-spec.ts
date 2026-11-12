/**
 * Integrations IN8 through the API, against a fake REST server (the real connector; only DNS and the last hop are swapped, as in
 * integration-rest.e2e-spec.ts): a daily schedule set with a template, the daily cron asking for it and working it, a scheduled import that
 * fails recovering the next day without duplicates, records that disappeared from a full read (made inactive under the 20% guard, held above it,
 * decided by a person), rejected rows ignored and brought back, and the health summary.
 */
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createServer, IncomingMessage, request as httpRequest, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { ConnectorRegistry } from '../src/integrations/core/connector.registry';
import { isPublicAddress, SafeHttpClient, SafeResponse } from '../src/integrations/core/safe-http';
import { CsvAdapter } from '../src/integrations/providers/csv/csv.adapter';
import { RestApiAdapter } from '../src/integrations/providers/rest-api/rest-api.adapter';
import { giveControllerSeats, makeIds, requireDb, seed, testEnv, token } from './helpers';

const ids = makeIds('5b');
const CRON_SECRET = 'cron-secret-for-integration-schedule-e2e';
let app: INestApplication;
let admin: Pool;
let server: Server;
let port = 0;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const owner = () => as(ids.ownerA);
const inspector = () => as(ids.inspectorA);
const other = () => as(ids.ownerB, ids.orgB);
const base = '/api/v1/integrations';
const cron = (path: string) => api().post(`/api/v1/internal/cron/${path}`).set('Authorization', `Bearer ${CRON_SECRET}`).expect(200);
/**
 * The cron works every organisation's due runs, and the suites share one database: a run another suite left waiting can fall due while this one runs.
 * These tests are about this connection's runs, so they look only at those.
 */
const mine = async (connId: string, results: { runId: string }[]) => {
  const own = new Set((await admin.query(`select id from public.integration_sync_runs where connection_id = $1`, [connId])).rows.map((r: { id: string }) => r.id));
  return results.filter((r) => own.has(r.runId));
};

let site = '';
let machines: Array<{ id: string; code: string; name: string; plant: string }> = [];
let failNext = 0;

function handle(req: IncomingMessage) {
  const url = new URL(req.url ?? '/', 'http://fake');
  if (url.pathname === '/api/health') return { status: 200, body: { ok: true } };
  if (url.pathname === '/api/v1/machines') {
    if (failNext > 0) {
      failNext -= 1;
      return { status: 503, body: { error: 'busy' } };
    }
    return { status: 200, body: { data: machines } };
  }
  return { status: 404, body: {} };
}

const toFakeServer = (req: { url: URL; headers: Record<string, string> }): Promise<SafeResponse> =>
  new Promise((resolve, reject) => {
    const r = httpRequest({ host: '127.0.0.1', port, path: `${req.url.pathname}${req.url.search}`, method: 'GET', headers: { ...req.headers, host: req.url.host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k] = v;
        resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
      });
    });
    r.on('error', reject);
    r.end();
  });

const http = new SafeHttpClient({
  resolve: async (host) => {
    if (host !== 'erp.fake-api.com') throw new Error('ENOTFOUND');
    return [{ address: '127.0.0.1', family: 4 }];
  },
  addressAllowed: (a) => a === '127.0.0.1' || isPublicAddress(a),
  send: toFakeServer,
});

beforeAll(async () => {
  server = createServer((req, res) => {
    const out = handle(req);
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-sched');
  await giveControllerSeats(admin, ids.orgA, [ids.ownerA]);
  await giveControllerSeats(admin, ids.orgB, [ids.ownerB]);
  site = (await admin.query(`select code from public.sites where organisation_id = $1 order by created_at limit 1`, [ids.orgA])).rows[0].code;
  machines = Array.from({ length: 10 }, (_, i) => ({ id: `M${i + 1}`, code: `SCH-M${i + 1}`, name: `Machine ${i + 1}`, plant: site }));
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000', CRON_SECRET });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(ConnectorRegistry).useValue(new ConnectorRegistry().register(new CsvAdapter()).register(new RestApiAdapter(http)))
    .compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true });
  app = configureApp(nest, env);
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
});

describe('scheduled imports and keeping them healthy', () => {
  let connId: string;
  let templateId: string;
  const count = async () => Number((await admin.query(`select count(*) from public.machines where organisation_id = $1 and code like 'SCH-M%'`, [ids.orgA])).rows[0].count);
  const active = async (code: string) => (await admin.query(`select active from public.machines where organisation_id = $1 and code = $2`, [ids.orgA, code])).rows[0].active as boolean;
  const fullRun = async () =>
    (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'machine', kind: 'full', templateId }).expect(201)).body;

  it('a daily import is set with a template and acts for whoever set it', async () => {
    connId = (await api().post(`${base}/connections`).set(await owner()).send({
      providerKey: 'rest_api', name: 'Plant ERP', externalSystem: 'plant-erp',
      config: { baseUrl: 'https://erp.fake-api.com/api', authType: 'none', testPath: '/health', entities: { machine: { path: '/v1/machines', recordsPath: 'data' } } },
    }).expect(201)).body.id;
    await api().post(`${base}/connections/${connId}/test`).set(await owner()).send({}).expect(200);
    await api().post(`${base}/connections/${connId}/ready`).set(await owner()).send({}).expect(200);
    await api().post(`${base}/connections/${connId}/activate`).set(await owner()).send({}).expect(200);
    templateId = (await api().post(`${base}/templates`).set(await owner()).send({
      entityType: 'machine', name: 'Plant machines', keyField: 'id',
      fields: [{ target: 'code', source: 'code' }, { target: 'name', source: 'name' }, { target: 'site', source: 'plant' }],
      settings: { writeMode: 'add_update', matchExisting: false },
    }).expect(201)).body.id;

    const noTemplate = await api().put(`${base}/connections/${connId}/settings`).set(await owner()).send({ entityType: 'machine', schedule: 'daily' }).expect(409);
    expect(noTemplate.body.error.message).toMatch(/template/);
    await api().put(`${base}/connections/${connId}/settings`).set(await inspector()).send({ entityType: 'machine', schedule: 'daily', templateId }).expect(403);
    const s = (await api().put(`${base}/connections/${connId}/settings`).set(await owner()).send({ entityType: 'machine', schedule: 'daily', templateId, onMissing: 'deactivate' }).expect(200)).body;
    expect(s).toMatchObject({ schedule: 'daily', onMissing: 'deactivate', template: { id: templateId, name: 'Plant machines', version: 1 }, scheduledBy: { id: ids.ownerA }, tracksMissing: true });
  });

  it('the daily job asks for the import and works it; asking again the same day does nothing', async () => {
    await api().post('/api/v1/internal/cron/integration-schedule').expect(401);
    const first = (await cron('integration-schedule')).body;
    expect(first.scheduled).toEqual([expect.objectContaining({ connectionId: connId, entityType: 'machine', skipped: null })]);
    expect(await mine(connId, first.results)).toEqual([expect.objectContaining({ state: 'finished' })]);
    expect(await count()).toBe(10);
    const run = (await admin.query(`select kind, trigger, status, requested_by from public.integration_sync_runs where connection_id = $1 and trigger = 'schedule'`, [connId])).rows[0];
    expect(run).toMatchObject({ kind: 'full', trigger: 'schedule', status: 'succeeded', requested_by: ids.ownerA });
    const again = (await cron('integration-schedule')).body;
    expect(again.scheduled).toEqual([]);
  });

  it('a scheduled import that fails waits, is not doubled the next day, and then finishes without duplicates', async () => {
    failNext = 1;
    await admin.query(`select app.system_schedule_integration_runs(current_date + 1)`);
    const waiting = (await cron('integration-runs')).body;
    expect(await mine(connId, waiting.results)).toEqual([expect.objectContaining({ state: 'waiting' })]);
    const next = (await admin.query(`select app.system_schedule_integration_runs(current_date + 2) as r`)).rows[0].r;
    expect(next).toEqual([expect.objectContaining({ runId: null, skipped: 'An earlier import is still running; it carries on' })]);
    await admin.query(`update public.integration_sync_runs set next_attempt_at = now() where connection_id = $1 and status in ('queued', 'running')`, [connId]);
    const done = (await cron('integration-runs')).body;
    expect(await mine(connId, done.results)).toEqual([expect.objectContaining({ state: 'finished' })]);
    expect(await count()).toBe(10);
    const runs = (await admin.query(`select status, unchanged, created from public.integration_sync_runs where connection_id = $1 and trigger = 'schedule' order by requested_at`, [connId])).rows;
    expect(runs[runs.length - 1]).toMatchObject({ status: 'succeeded', unchanged: 10, created: 0 });
  });

  it('records that disappear: one is made inactive, too many at once are held for a person', async () => {
    machines = machines.filter((m) => m.id !== 'M1');
    const r1 = await fullRun();
    expect(r1.missing).toMatchObject({ deactivated: 1, held: 0 });
    expect(await active('SCH-M1')).toBe(false);

    machines = machines.filter((m) => !['M2', 'M3', 'M4'].includes(m.id));
    const r2 = await fullRun();
    expect(r2.missing).toMatchObject({ held: 3, deactivated: 0, heldReason: expect.stringMatching(/^3 of 10/) });
    expect(await active('SCH-M2')).toBe(true);

    const list = (await api().get(`${base}/missing-records`).set(await owner()).expect(200)).body;
    expect(list).toMatchObject({ total: 3, openCount: 3 });
    expect(list.data[0]).toMatchObject({ status: 'held', entityType: 'machine', record: { label: expect.stringMatching(/^SCH-M/), active: true }, canDecide: true, canDeactivate: true });
    const [a, b, c] = list.data.map((m: { id: string }) => m.id);
    await api().post(`${base}/missing-records/decide`).set(await owner()).send({ ids: [a], deactivate: false }).expect(400);
    await api().post(`${base}/missing-records/decide`).set(await other()).send({ ids: [a], deactivate: true }).expect(404);
    expect((await api().post(`${base}/missing-records/decide`).set(await owner()).send({ ids: [a], deactivate: false, note: 'Moved, still in use' }).expect(200)).body).toEqual({ decided: 1 });
    expect((await api().post(`${base}/missing-records/decide`).set(await owner()).send({ ids: [b, c], deactivate: true }).expect(200)).body).toEqual({ decided: 2 });
    const decided = (await api().get(`${base}/missing-records`).set(await owner()).query({ status: 'decided' }).expect(200)).body;
    expect(decided.data.map((m: { status: string }) => m.status).sort()).toEqual(['deactivated', 'deactivated', 'deactivated', 'kept']);
    expect((await api().get(`${base}/missing-records`).set(await other()).expect(200)).body.total).toBe(0);
  });

  it('a rejected row can be ignored with a reason and brought back', async () => {
    machines = [...machines, { id: 'M99', code: '', name: 'No code', plant: site }];
    const run = await fullRun();
    expect(run.counts.rejected).toBe(1);
    const needs = (await api().get(`${base}/connections/${connId}/attention`).set(await owner()).query({ entityType: 'machine' }).expect(200)).body;
    expect(needs.data).toEqual([expect.objectContaining({ externalId: 'M99', status: 'rejected', ignored: null })]);
    const rowId = needs.data[0].id;
    await api().post(`${base}/connections/${connId}/rows/ignore`).set(await owner()).send({ rowIds: [rowId], reason: 'x' }).expect(400);
    await api().post(`${base}/connections/${connId}/rows/ignore`).set(await inspector()).send({ rowIds: [rowId], reason: 'Test machine' }).expect(403);
    await api().post(`${base}/connections/${connId}/rows/ignore`).set(await other()).send({ rowIds: [rowId], reason: 'Test machine' }).expect(404);
    expect((await api().post(`${base}/connections/${connId}/rows/ignore`).set(await owner()).send({ rowIds: [rowId], reason: 'A test machine the ERP should not send' }).expect(200)).body).toEqual({ changed: 1 });
    expect((await api().get(`${base}/connections/${connId}/attention`).set(await owner()).query({ entityType: 'machine' }).expect(200)).body.total).toBe(0);
    const ignored = (await api().get(`${base}/connections/${connId}/attention`).set(await owner()).query({ entityType: 'machine', ignored: 'only' }).expect(200)).body;
    expect(ignored.data[0]).toMatchObject({ status: 'ignored', ignored: { reason: 'A test machine the ERP should not send', by: { id: ids.ownerA }, from: 'rejected' } });
    await api().post(`${base}/connections/${connId}/rows/restore`).set(await owner()).send({ rowIds: [rowId] }).expect(200);
    expect((await api().get(`${base}/connections/${connId}/attention`).set(await owner()).query({ entityType: 'machine' }).expect(200)).body.total).toBe(1);
  });

  it('health shows every scheduled import and what waits for a person', async () => {
    const h = (await api().get(`${base}/health`).set(await owner()).expect(200)).body;
    const row = h.data.find((r: { connectionId: string; entityType: string }) => r.connectionId === connId && r.entityType === 'machine');
    expect(row).toMatchObject({
      schedule: 'daily', onMissing: 'deactivate', template: { name: 'Plant machines' }, rowsNeedingAction: 1, missingWaiting: 0, failedInARow: 0,
      lastRun: { status: 'partial' }, state: 'attention',
    });
    expect(row.lastSuccessAt).toEqual(expect.any(String));
    await api().get(`${base}/health`).set(await inspector()).expect(403);
    expect((await api().get(`${base}/health`).set(await other()).expect(200)).body.data).toEqual([]);
  });
});
