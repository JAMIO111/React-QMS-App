/**
 * OAuth client credentials for REST connections (docs/email-oauth-plan.md, OA1) through the API: a fake sign-in server on one host and a fake API on
 * another. As in the REST e2e, the connector is the real `RestApiAdapter` over the real `SafeHttpClient`; only DNS (a table) and the last hop (plain HTTP to
 * the fake server, which tells the two hosts apart by the Host header) are swapped.
 *
 * Covers: the client credential is checked and never returned; the test signs in and says where; a sample and a preview read with the token, which is
 * asked for once and reused; a client the sign-in server refuses is reported in its words; a token host outside the allow-list blocks activation and is
 * refused at run time without calling it.
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
import { isPublicAddress, SafeHttpClient, SafeResponse, SendRequest } from '../src/integrations/core/safe-http';
import { CsvAdapter } from '../src/integrations/providers/csv/csv.adapter';
import { RestApiAdapter } from '../src/integrations/providers/rest-api/rest-api.adapter';
import { giveControllerSeats, makeIds, requireDb, seed, testEnv, token } from './helpers';

const ids = makeIds('5d');
let app: INestApplication;
let admin: Pool;
let server: Server;
let port = 0;
const api = () => request(app.getHttpServer());
const owner = async () => ({ Authorization: `Bearer ${await token(ids.ownerA)}`, 'X-Organisation-Id': ids.orgA });
const base = '/api/v1/integrations';

// ---- the fake sign-in server and API ----------------------------------------------------------------------------------------
let issued = 0;
const tokenRequests: Array<Record<string, string>> = [];
const apiCalls: Array<{ path: string; auth: string | undefined }> = [];

function handle(req: IncomingMessage, body: string) {
  const url = new URL(req.url ?? '/', 'http://fake');
  if (req.headers.host === 'idp.fake-api.com') {
    const form = Object.fromEntries(new URLSearchParams(body));
    tokenRequests.push(form);
    if (req.method !== 'POST' || url.pathname !== '/oauth2/token' || form.grant_type !== 'client_credentials') return { status: 400, body: { error: 'invalid_request' } };
    if (form.client_id !== 'fortress' || form.client_secret !== 'right-secret') return { status: 401, body: { error: 'invalid_client', error_description: 'Client authentication failed.' } };
    issued += 1;
    return { status: 200, body: { access_token: `tok-${issued}`, token_type: 'Bearer', expires_in: 3600, scope: form.scope } };
  }
  apiCalls.push({ path: url.pathname, auth: req.headers.authorization });
  if (!/^Bearer tok-\d+$/.test(req.headers.authorization ?? '')) return { status: 401, body: {} };
  if (url.pathname === '/api/health') return { status: 200, body: { ok: true } };
  if (url.pathname === '/api/v1/machines') return { status: 200, body: { data: [{ id: 'M1', code: 'OA-M1', name: 'Lathe' }, { id: 'M2', code: 'OA-M2', name: 'Mill' }] } };
  return { status: 404, body: {} };
}

const toFakeServer = (req: SendRequest): Promise<SafeResponse> =>
  new Promise((resolve, reject) => {
    const r = httpRequest(
      { host: '127.0.0.1', port, path: `${req.url.pathname}${req.url.search}`, method: req.method ?? 'GET', headers: { ...req.headers, host: req.url.host, ...(req.body ? { 'content-length': String(req.body.length) } : {}) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: {}, body: Buffer.concat(chunks) }));
      },
    );
    r.on('error', reject);
    r.end(req.body);
  });

const DNS: Record<string, string> = { 'erp.fake-api.com': '127.0.0.1', 'idp.fake-api.com': '127.0.0.1' };
const http = new SafeHttpClient({
  resolve: async (host) => {
    if (!(host in DNS)) throw new Error('ENOTFOUND');
    return [{ address: DNS[host], family: 4 }];
  },
  addressAllowed: (a) => a === '127.0.0.1' || isPublicAddress(a),
  send: toFakeServer,
});

const config = {
  baseUrl: 'https://erp.fake-api.com/api',
  authType: 'oauth_client',
  oauthTokenUrl: 'https://idp.fake-api.com/oauth2/token',
  oauthScope: 'erp.read',
  testPath: '/health',
  entities: { machine: { path: '/v1/machines', recordsPath: 'data' } },
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const out = handle(req, body);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;

  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-oauth');
  await giveControllerSeats(admin, ids.orgA, [ids.ownerA]);

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

describe('OAuth client credentials', () => {
  let connId: string;

  it('takes the client id and secret as one credential that is never shown again', async () => {
    const missing = await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'rest_api', name: 'No token address', externalSystem: 'no-token', config: { ...config, oauthTokenUrl: undefined } }).expect(409);
    expect(missing.body.error.message).toMatch(/token is asked for/);
    connId = (await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'rest_api', name: 'Entra ERP', externalSystem: 'entra-erp', config }).expect(201)).body.id;
    const bad = await api().put(`${base}/connections/${connId}/credential`).set(await owner()).send({ kind: 'oauth_client', secret: 'fortress:right-secret' }).expect(409);
    expect(bad.body.error.message).toMatch(/client id and a client secret/);
    const c = (await api().put(`${base}/connections/${connId}/credential`).set(await owner()).send({ kind: 'oauth_client', secret: JSON.stringify({ clientId: 'fortress', clientSecret: 'wrong' }) }).expect(200)).body;
    expect(c.credential.kind).toBe('oauth_client');
    expect(JSON.stringify(c)).not.toContain('wrong');
  });

  it('reports a refused client in the sign-in server\'s words, without calling the API', async () => {
    const c = (await api().post(`${base}/connections/${connId}/test`).set(await owner()).send({}).expect(200)).body;
    expect(c.lastTest).toMatchObject({ ok: false, message: 'The sign-in server refused the client (401 invalid_client): Client authentication failed.' });
    expect(tokenRequests.at(-1)).toMatchObject({ grant_type: 'client_credentials', scope: 'erp.read', client_id: 'fortress' });
    expect(apiCalls).toHaveLength(0);
  });

  it('signs in, tests, and reuses the token for a sample and a preview', async () => {
    await api().put(`${base}/connections/${connId}/credential`).set(await owner()).send({ kind: 'oauth_client', secret: JSON.stringify({ clientId: 'fortress', clientSecret: 'right-secret' }) }).expect(200);
    const c = (await api().post(`${base}/connections/${connId}/test`).set(await owner()).send({}).expect(200)).body;
    expect(c.lastTest).toMatchObject({ ok: true, message: 'Signed in at idp.fake-api.com; The API answered 200 at /api/health' });
    expect(JSON.stringify(c)).not.toContain('right-secret');
    expect(JSON.stringify(c)).not.toContain('tok-1');

    const sample = (await api().post(`${base}/connections/${connId}/sample`).set(await owner()).send({ entityType: 'machine' }).expect(200)).body;
    expect(sample.columns).toEqual(['id', 'code', 'name']);
    const run = (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'machine', kind: 'preview' }).expect(201)).body;
    // Both records were read with the token (without a template every row is rejected for want of a mapping: the read is what matters here).
    expect(run).toMatchObject({ drain: { state: 'finished' }, errors: [], counts: { total: 2 } });
    expect(issued).toBe(1);
    expect(apiCalls.every((a) => a.auth === 'Bearer tok-1')).toBe(true);
    // The token is kept in memory only: nothing about it is in the database.
    const stored = await admin.query(`select count(*)::int as n from public.integration_connection_events where connection_id = $1 and coalesce(note, '') like '%tok-%'`, [connId]);
    expect(stored.rows[0].n).toBe(0);
  });

  it('a token host outside the allow-list blocks activation and is never called', async () => {
    await api().put(`${base}/allowed-hosts`).set(await owner()).send({ hosts: ['erp.fake-api.com'] }).expect(200);
    const detail = (await api().get(`${base}/connections/${connId}`).set(await owner()).expect(200)).body;
    expect(detail.problems.join(';')).toMatch(/does not allow connections to the token address idp\.fake-api\.com/);
    const before = tokenRequests.length;
    // A fresh adapter has no cached token, so the request would go to the sign-in server: it is refused first.
    const fresh = new RestApiAdapter(http);
    await expect(fresh.fetchRecords({ config, secret: JSON.stringify({ clientId: 'fortress', clientSecret: 'right-secret' }), allowedHosts: ['erp.fake-api.com'] }, 'machine', null))
      .rejects.toMatchObject({ kind: 'auth', message: expect.stringMatching(/does not allow connections to idp\.fake-api\.com/) });
    expect(tokenRequests.length).toBe(before);
    await api().put(`${base}/allowed-hosts`).set(await owner()).send({ hosts: ['erp.fake-api.com', 'idp.fake-api.com'] }).expect(200);
    const ok = (await api().get(`${base}/connections/${connId}`).set(await owner()).expect(200)).body;
    expect(ok.problems.join(';')).not.toMatch(/token address/);
  });
});
