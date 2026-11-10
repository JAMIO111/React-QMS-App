/**
 * Integrations IN7 through the API: the generic REST connector against a fake REST server. The connector is the real one (`RestApiAdapter` over
 * `SafeHttpClient`); only the last hop is swapped so the test can answer locally: a table stands in for DNS ("erp.fake-api.com" is the fake server,
 * "private.fake-api.com" points into a private network, "metadata.fake-api.com" at the cloud metadata address) and the request goes over plain HTTP to the
 * fake server. The address rules are the real ones, with the fake server's loopback address the only exception.
 *
 * Covers: test with a bearer credential, preview without a template, paging, a full import through a template, the same import again writing nothing,
 * an incremental import that sends the high-water mark and picks up only the change, private and metadata targets refused, a redirect refused, a 429
 * waiting with Retry-After, and the organisation's allow-list pausing a connection.
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

const ids = makeIds('5a');
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

// ---- the fake REST server -------------------------------------------------------------------------------------------------
let site = '';
let machines: Array<{ id: string; code: string; name: string; plant: string; updatedAt: string; meta: { line: string } }> = [];
const seen: Array<{ path: string; query: Record<string, string>; auth: string | undefined; host: string | undefined }> = [];

function handle(req: IncomingMessage) {
  const url = new URL(req.url ?? '/', 'http://fake');
  seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, host: req.headers.host });
  if (req.headers.authorization !== 'Bearer erp-token') return { status: 401, body: { error: 'no' } };
  if (url.pathname === '/api/health') return { status: 200, body: { ok: true } };
  if (url.pathname === '/api/v1/machines') {
    const since = url.searchParams.get('updated_since');
    const page = Number(url.searchParams.get('page'));
    const size = Number(url.searchParams.get('per_page'));
    const list = machines.filter((m) => !since || m.updatedAt >= since);
    return { status: 200, body: { data: list.slice((page - 1) * size, page * size), total: list.length } };
  }
  if (url.pathname === '/api/v1/moved') return { status: 302, body: {}, headers: { location: 'http://169.254.169.254/latest/meta-data' } };
  if (url.pathname === '/api/v1/busy') return { status: 429, body: {}, headers: { 'retry-after': '120' } };
  return { status: 404, body: {} };
}

/** The last hop: plain HTTP to the fake server, with the same size cap. Everything before it (URL, DNS and address rules, headers) is the real client. */
const toFakeServer = (req: { url: URL; headers: Record<string, string>; maxBytes: number }): Promise<SafeResponse> =>
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

const DNS: Record<string, string> = { 'erp.fake-api.com': '127.0.0.1', 'private.fake-api.com': '10.0.0.7', 'metadata.fake-api.com': '169.254.169.254', 'mixed.fake-api.com': '192.168.4.4' };
const http = new SafeHttpClient({
  resolve: async (host) => {
    if (!(host in DNS)) throw new Error('ENOTFOUND');
    return [{ address: DNS[host], family: 4 }];
  },
  addressAllowed: (a) => a === '127.0.0.1' || isPublicAddress(a),
  send: toFakeServer,
});

const config = (baseUrl = 'https://erp.fake-api.com/api') => ({
  baseUrl,
  authType: 'bearer',
  testPath: '/health',
  entities: {
    machine: { path: '/v1/machines', recordsPath: 'data', paging: { style: 'page', pageSize: 2, pageParam: 'page', sizeParam: 'per_page' }, incremental: { param: 'updated_since', field: 'updatedAt' } },
    customer: { path: '/v1/moved' },
    part: { path: '/v1/busy' },
  },
});

beforeAll(async () => {
  server = createServer((req, res) => {
    const out = handle(req);
    res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) });
    res.end(JSON.stringify(out.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;

  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-rest');
  await giveControllerSeats(admin, ids.orgA, [ids.ownerA]);
  await giveControllerSeats(admin, ids.orgB, [ids.ownerB]);
  site = (await admin.query(`select code from public.sites where organisation_id = $1 order by created_at limit 1`, [ids.orgA])).rows[0].code;
  machines = [1, 2, 3, 4, 5].map((n) => ({ id: `M${n}`, code: `REST-M${n}`, name: `Machine ${n}`, plant: site, updatedAt: `2026-11-0${n}T08:00:00Z`, meta: { line: `L${n}` } }));

  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000' });
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

describe('the REST connector', () => {
  let connId: string;
  let templateId: string;
  const run = async (entityType: string, kind: 'preview' | 'full' | 'incremental', extra: Record<string, unknown> = {}) =>
    (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType, kind, ...extra }).expect(201)).body;

  it('signs in, tests and is activated', async () => {
    const bad = await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'rest_api', name: 'Bad', externalSystem: 'bad', config: { ...config(), entities: { machine: { path: '//evil.example.com/x' } } } }).expect(409);
    expect(bad.body.error.message).toMatch(/stays below the address/);
    await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'rest_api', name: 'Bad', externalSystem: 'bad', config: { ...config(), apiKeyHeader: 'Host', authType: 'api_key' } }).expect(409);

    connId = (await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'rest_api', name: 'Fake ERP', externalSystem: 'fake-erp', config: config() }).expect(201)).body.id;
    let c = (await api().post(`${base}/connections/${connId}/test`).set(await owner()).send({}).expect(200)).body;
    expect(c.lastTest).toMatchObject({ ok: false, message: 'Store the credential for this connection first' });
    await api().put(`${base}/connections/${connId}/credential`).set(await owner()).send({ kind: 'bearer', secret: 'erp-token' }).expect(200);
    c = (await api().post(`${base}/connections/${connId}/test`).set(await owner()).send({}).expect(200)).body;
    expect(c.lastTest).toMatchObject({ ok: true, message: 'The API answered 200 at /api/health' });
    expect(seen.at(-1)).toMatchObject({ path: '/api/health', auth: 'Bearer erp-token', host: 'erp.fake-api.com' });
    expect(JSON.stringify(c)).not.toContain('erp-token');
    await api().post(`${base}/connections/${connId}/ready`).set(await owner()).send({}).expect(200);
    c = (await api().post(`${base}/connections/${connId}/activate`).set(await owner()).send({}).expect(200)).body;
    expect(c.status).toBe('active');
  });

  it('a sample shows what the API sends, as columns, and a template is made and previewed against it', async () => {
    const sample = (await api().post(`${base}/connections/${connId}/sample`).set(await owner()).send({ entityType: 'machine' }).expect(200)).body;
    expect(sample.columns).toEqual(['id', 'code', 'name', 'plant', 'updatedAt', 'meta.line']);
    expect(sample.rows[0]).toEqual({ r: 1, v: { id: 'M1', code: 'REST-M1', name: 'Machine 1', plant: site, updatedAt: '2026-11-01T08:00:00Z', 'meta.line': 'L1' } });
    await api().post(`${base}/connections/${connId}/sample`).set(await inspector()).send({ entityType: 'machine' }).expect(403);
    const notSet = await api().post(`${base}/connections/${connId}/sample`).set(await owner()).send({ entityType: 'supplier' }).expect(409);
    expect(notSet.body.error.message).toMatch(/does not say where to read supplier records/);

    const fields = [{ target: 'code', source: 'code' }, { target: 'name', source: 'name' }, { target: 'site', source: 'plant' }];
    const preview = (await api().post(`${base}/templates/preview`).set(await owner()).send({ entityType: 'machine', connectionId: connId, keyField: 'id', fields }).expect(200)).body;
    expect(preview.columns).toContain('meta.line');
    expect(preview.rows[0].fields.find((f: { target: string }) => f.target === 'code')).toMatchObject({ value: 'REST-M1', error: null });
    templateId = (await api().post(`${base}/templates`).set(await owner()).send({
      entityType: 'machine', name: 'Fake ERP machines', keyField: 'id', fields, expectedColumns: sample.columns,
      settings: { writeMode: 'add_update', matchExisting: false },
    }).expect(201)).body.id;
  });

  it('a preview reads every page, then the import writes once and the same import again writes nothing', async () => {
    seen.length = 0;
    const r = await run('machine', 'preview', { templateId });
    expect(r).toMatchObject({ status: 'succeeded', drain: { state: 'finished' }, counts: { total: 5, created: 5 } });
    expect(seen.map((x) => x.query.page)).toEqual(['1', '2', '3']);
    expect(seen.every((x) => x.query.per_page === '2' && x.auth === 'Bearer erp-token')).toBe(true);
    expect((await admin.query(`select count(*)::int as n from public.machines where organisation_id = $1 and code like 'REST-M%'`, [ids.orgA])).rows[0].n).toBe(0);

    const first = await run('machine', 'full', { templateId });
    expect(first).toMatchObject({ status: 'succeeded', counts: { total: 5, created: 5 } });
    expect((await admin.query(`select count(*)::int as n from public.machines where organisation_id = $1 and code like 'REST-M%'`, [ids.orgA])).rows[0].n).toBe(5);
    const cursor = (await admin.query(`select cursor from public.integration_sync_cursors where connection_id = $1 and entity_type = 'machine'`, [connId])).rows[0].cursor;
    expect(JSON.parse(cursor)).toEqual({ w: '2026-11-05T08:00:00Z' });

    const again = await run('machine', 'full', { templateId });
    expect(again).toMatchObject({ status: 'succeeded', counts: { total: 5, created: 0, updated: 0, unchanged: 5 } });
  });

  it('an incremental import sends the high-water mark and takes only what changed', async () => {
    machines[1] = { ...machines[1], name: 'Machine 2 (rebuilt)', updatedAt: '2026-11-08T09:00:00Z' };
    machines.push({ id: 'M6', code: 'REST-M6', name: 'Machine 6', plant: site, updatedAt: '2026-11-09T07:00:00Z', meta: { line: 'L6' } });
    seen.length = 0;
    const inc = await run('machine', 'incremental', { templateId });
    expect(seen[0].query.updated_since).toBe('2026-11-05T08:00:00Z');
    // M5 is sent again (same timestamp: the filter is "on or after") and is unchanged; M2 changed; M6 is new.
    expect(inc).toMatchObject({ kind: 'incremental', status: 'succeeded', counts: { total: 3, created: 1, updated: 1, unchanged: 1 } });
    expect((await admin.query(`select name from public.machines where organisation_id = $1 and code = 'REST-M2'`, [ids.orgA])).rows[0].name).toBe('Machine 2 (rebuilt)');
    const cursor = (await admin.query(`select cursor from public.integration_sync_cursors where connection_id = $1 and entity_type = 'machine'`, [connId])).rows[0].cursor;
    expect(JSON.parse(cursor)).toEqual({ w: '2026-11-09T07:00:00Z' });
  });

  it('never follows a redirect, and waits when the API asks it to slow down', async () => {
    const moved = await run('customer', 'preview');
    expect(moved).toMatchObject({ status: 'failed', drain: { state: 'failed' } });
    expect(moved.errors[0]).toMatchObject({ kind: 'malformed', transient: false, message: expect.stringMatching(/redirect.*never followed/) });

    const busy = await run('part', 'preview');
    expect(busy).toMatchObject({ status: 'running', drain: { state: 'waiting' } });
    expect(busy.errors[0]).toMatchObject({ kind: 'rate_limit', transient: true });
    const wait = (await admin.query(`select extract(epoch from next_attempt_at - now())::int as s from public.integration_sync_runs where id = $1`, [busy.id])).rows[0].s;
    expect(wait).toBeGreaterThan(100);
    await api().post(`${base}/runs/${busy.id}/cancel`).set(await owner()).send({ reason: 'Test over' }).expect(200);
  });

  it('refuses private and metadata targets, before sending anything', async () => {
    for (const [name, host] of [['Private', 'private.fake-api.com'], ['Metadata', 'metadata.fake-api.com'], ['Mixed', 'mixed.fake-api.com']]) {
      const id = (await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'rest_api', name, externalSystem: name.toLowerCase(), config: config(`https://${host}/api`) }).expect(201)).body.id;
      await api().put(`${base}/connections/${id}/credential`).set(await owner()).send({ kind: 'bearer', secret: 'erp-token' }).expect(200);
      seen.length = 0;
      const t = (await api().post(`${base}/connections/${id}/test`).set(await owner()).send({}).expect(200)).body;
      expect(t.lastTest).toMatchObject({ ok: false, message: `${host} points to a private or reserved network address, which is not allowed` });
      const preview = (await api().post(`${base}/connections/${id}/runs`).set(await owner()).send({ entityType: 'machine', kind: 'preview' }).expect(201)).body;
      expect(preview).toMatchObject({ status: 'failed' });
      expect(preview.errors[0]).toMatchObject({ kind: 'limit', transient: false, message: expect.stringMatching(/private or reserved/) });
      expect(seen).toHaveLength(0);
    }
  });

  it('holds connections to the organisation\'s allow-list', async () => {
    expect((await api().get(`${base}/allowed-hosts`).set(await owner()).expect(200)).body).toEqual({ hosts: [], canManage: true });
    await api().put(`${base}/allowed-hosts`).set(await inspector()).send({ hosts: ['example.com'] }).expect(403);
    await api().put(`${base}/allowed-hosts`).set(await owner()).send({ hosts: ['10.0.0.1'] }).expect(409);

    const set = (await api().put(`${base}/allowed-hosts`).set(await owner()).send({ hosts: ['Partner.example.org'] }).expect(200)).body;
    expect(set).toEqual({ hosts: ['partner.example.org'], canManage: true });
    const c = (await api().get(`${base}/connections/${connId}`).set(await owner()).expect(200)).body;
    expect(c.status).toBe('paused');
    expect(c.problems).toEqual(expect.arrayContaining([expect.stringMatching(/does not allow connections to erp\.fake-api\.com/)]));
    const refused = await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'machine', kind: 'preview' }).expect(409);
    expect(refused.body.error.message).toMatch(/does not allow connections to erp\.fake-api\.com/);
    seen.length = 0;
    const t = (await api().post(`${base}/connections/${connId}/test`).set(await owner()).send({}).expect(200)).body;
    expect(t.lastTest).toMatchObject({ ok: false, message: 'Your organisation does not allow connections to erp.fake-api.com' });
    expect(seen).toHaveLength(0);

    expect((await api().get(`${base}/allowed-hosts`).set(await other()).expect(200)).body.hosts).toEqual([]);
    await api().put(`${base}/allowed-hosts`).set(await owner()).send({ hosts: ['fake-api.com'] }).expect(200);
    const ok = (await api().post(`${base}/connections/${connId}/test`).set(await owner()).send({}).expect(200)).body;
    expect(ok.lastTest).toMatchObject({ ok: true });
    await api().put(`${base}/allowed-hosts`).set(await owner()).send({ hosts: [] }).expect(200);
  });
});
