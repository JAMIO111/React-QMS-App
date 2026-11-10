/**
 * Integrations IN2 through the API, with a fake file source and a fake supplier importer in place of the real ones (IN3/IN4):
 * a preview writes nothing; the same source imported twice stages twice but applies once; a failed row is kept, shown and retryable; transient source errors
 * back off and the cron route picks the run up later; cancel; the audit trail names the person who started the import; permissions and tenant isolation.
 */
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { CATALOGUE } from '../src/integrations/core/catalogue';
import { AdapterContext, ConnectorAdapter, ConnectorError, ConnectorMetadata, FetchResult } from '../src/integrations/core/connector.interface';
import { ConnectorRegistry } from '../src/integrations/core/connector.registry';
import { EntityImporter, EntityImporterRegistry, StagedRow } from '../src/integrations/core/entity-importer';
import { giveControllerSeats, makeIds, requireDb, seed, testEnv, token } from './helpers';

const ids = makeIds('2f');
const approverId = `${String('2f').padEnd(8, '0')}-0000-0000-0000-0000000000e1`;
const CRON_SECRET = 'cron-secret-for-integration-runs-e2e';
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const owner = () => as(ids.ownerA);
const approver = () => as(approverId);
const inspector = () => as(ids.inspectorA);
const other = () => as(ids.ownerB, ids.orgB);
const base = '/api/v1/integrations';

/** What the fake file holds; two records a page. */
let source: Record<string, unknown>[] = [];
let fetchError: ConnectorError | null = null;
class FakeFileAdapter implements ConnectorAdapter {
  getMetadata(): ConnectorMetadata {
    return { key: 'rest_api', name: 'REST API', kind: 'api', authTypes: [], capabilities: { testable: true, incremental: true, webhooks: false, writeBack: false } };
  }
  async testConnection() {
    return { ok: true, message: 'ok' };
  }
  async fetchRecords(_ctx: AdapterContext, _entity: string, cursor: string | null): Promise<FetchResult> {
    if (fetchError) throw fetchError;
    const start = cursor ? Number(cursor) : 0;
    const page = source.slice(start, start + 2);
    const next = start + page.length;
    return { records: page.map((payload, i) => ({ payload, sourceRow: start + i + 2 })), nextCursor: String(next), done: next >= source.length };
  }
}

/** Remembers which source record became which "QMS record"; fails for the codes in `broken`. */
const applied: string[] = [];
const qmsIds = new Map<string, string>();
const broken = new Set<string>();
const importer: EntityImporter = {
  entityType: 'supplier',
  externalIdOf: (r) => (typeof r.code === 'string' ? r.code : null),
  async apply(_client, row: StagedRow) {
    applied.push(row.externalId);
    if (broken.has(row.externalId)) throw new Error(`Supplier ${row.externalId} has no approved category`);
    if (!qmsIds.has(row.externalId)) qmsIds.set(row.externalId, row.internalId ?? randomUUID());
    return { internalId: qmsIds.get(row.externalId)! };
  },
};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ir');
  await admin.query(`insert into auth.users (id, email) values ($1, 'approver@example.test') on conflict do nothing`, [approverId]);
  const { rows } = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, approverId]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'quality_manager'`, [ids.orgA, rows[0].id]);
  await giveControllerSeats(admin, ids.orgA, [ids.ownerA, approverId]);
  await giveControllerSeats(admin, ids.orgB, [ids.ownerB]);
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000', CRON_SECRET });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(ConnectorRegistry).useValue(new ConnectorRegistry().register(new FakeFileAdapter()))
    .overrideProvider(EntityImporterRegistry).useValue(new EntityImporterRegistry().register(importer))
    .compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true });
  app = configureApp(nest, env);
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('import runs', () => {
  let connId: string;
  let firstRun: string;

  it('a preview runs before activation and writes nothing', async () => {
    connId = (await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'rest_api', name: 'ERP suppliers', externalSystem: 'erp', config: { baseUrl: 'https://erp.example.com' } }).expect(201)).body.id;
    const conn = (await api().get(`${base}/connections/${connId}`).set(await owner()).expect(200)).body;
    expect(conn.runnable).toEqual(CATALOGUE.map((c) => c.entityType));
    expect(conn.importable).toEqual(['supplier']);
    await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'goods_receipt', kind: 'preview' }).expect(409);
    await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'supplier', kind: 'full' }).expect(409);
    await api().post(`${base}/connections/${connId}/runs`).set(await inspector()).send({ entityType: 'supplier', kind: 'preview' }).expect(403);

    source = [{ code: 'S-1', name: 'Alpha' }, { code: 'S-2', name: 'Bravo' }, { code: 'S-3', name: 'Charlie' }, { name: 'No code' }];
    const run = (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'supplier', kind: 'preview' }).expect(201)).body;
    expect(run).toMatchObject({ kind: 'preview', status: 'partial', drain: { state: 'finished' }, counts: { total: 4, created: 3, rejected: 1 } });
    expect(run.requestedBy.id).toBe(ids.ownerA);
    expect(applied).toEqual([]);
    expect((await api().get(`${base}/connections/${connId}/external-records`).set(await owner()).expect(200)).body.total).toBe(0);
    const rows = (await api().get(`${base}/runs/${run.id}/rows`).set(await owner()).query({ status: 'rejected' }).expect(200)).body;
    expect(rows.data[0]).toMatchObject({ externalId: null, sourceRow: 5, errors: [{ field: 'externalId', message: 'The record has no identifier' }] });
  });

  it('imports once activated; a failed row stays for a retry', async () => {
    await api().post(`${base}/connections/${connId}/test`).set(await owner()).send({}).expect(200);
    await api().post(`${base}/connections/${connId}/ready`).set(await owner()).send({}).expect(200);
    await api().post(`${base}/connections/${connId}/activate`).set(await approver()).send({}).expect(200);
    broken.add('S-3');
    const run = (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'supplier', kind: 'full' }).expect(201)).body;
    firstRun = run.id;
    expect(run).toMatchObject({ status: 'partial', counts: { total: 4, created: 2, failed: 1, rejected: 1, unchanged: 0 } });
    expect(applied).toEqual(['S-1', 'S-2', 'S-3']);
    const failed = (await api().get(`${base}/runs/${run.id}/rows`).set(await owner()).query({ status: 'failed' }).expect(200)).body.data;
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ externalId: 'S-3', errors: [{ message: 'Supplier S-3 has no approved category' }], payload: { code: 'S-3', name: 'Charlie' } });
    const map = (await api().get(`${base}/connections/${connId}/external-records`).set(await owner()).query({ entityType: 'supplier' }).expect(200)).body;
    expect(map.data.map((x: { externalId: string }) => x.externalId)).toEqual(['S-1', 'S-2']);
    expect(map.data[0].internalId).toBe(qmsIds.get('S-1'));
    // the audit trail names the person who started the import, and the run
    const ev = await admin.query(`select actor_user_id, source, correlation_id from audit.events where entity_type = 'integration_external_records' and entity_id = $1`, [qmsIds.get('S-1')]);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]).toMatchObject({ actor_user_id: ids.ownerA, source: 'integration' });
  });

  it('the same source again stages everything but applies only what is not in yet', async () => {
    applied.length = 0;
    const before = Number((await admin.query(`select count(*) from audit.events where entity_type = 'integration_external_records'`)).rows[0].count);
    const run = (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'supplier', kind: 'full' }).expect(201)).body;
    expect(run).toMatchObject({ counts: { total: 4, unchanged: 2, created: 0, failed: 1 } });
    expect(applied).toEqual(['S-3']);
    expect(Number((await admin.query(`select count(*) from audit.events where entity_type = 'integration_external_records'`)).rows[0].count)).toBe(before);
    expect((await api().get(`${base}/connections/${connId}/external-records`).set(await owner()).expect(200)).body.total).toBe(2);
  });

  it('retries the failed rows once the cause is fixed: only the newest copy is applied', async () => {
    applied.length = 0;
    broken.clear();
    await api().post(`${base}/connections/${connId}/retry`).set(await inspector()).send({ entityType: 'supplier' }).expect(403);
    const run = (await api().post(`${base}/connections/${connId}/retry`).set(await owner()).send({ entityType: 'supplier' }).expect(201)).body;
    expect(run).toMatchObject({ kind: 'retry', status: 'succeeded', counts: { total: 2, created: 1, superseded: 1, failed: 0 } });
    expect(applied).toEqual(['S-3']);
    expect((await api().get(`${base}/runs/${firstRun}`).set(await owner()).expect(200)).body.rowsNow).toMatchObject({ failed: 0, superseded: 1 });
    await api().post(`${base}/connections/${connId}/retry`).set(await owner()).send({ entityType: 'supplier' }).expect(409); // nothing left to retry
    expect((await api().get(`${base}/connections/${connId}/external-records`).set(await owner()).expect(200)).body.total).toBe(3);
  });

  it('a source that cannot be read waits and tries again; the cron route picks it up', async () => {
    fetchError = new ConnectorError('The ERP is busy', 'rate_limit', true, 60);
    source = [...source, { code: 'S-4', name: 'Delta' }];
    const run = (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'supplier', kind: 'full' }).expect(201)).body;
    expect(run).toMatchObject({ status: 'running', drain: { state: 'waiting', reason: 'The ERP is busy' }, attempts: 1 });
    expect(run.errors).toEqual([expect.objectContaining({ kind: 'rate_limit', message: 'The ERP is busy', transient: true })]);
    await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'supplier', kind: 'full' }).expect(409); // one at a time
    const blocked = (await api().post(`${base}/runs/${run.id}/continue`).set(await owner()).send({}).expect(200)).body;
    expect(blocked.drain).toMatchObject({ state: 'blocked', reason: 'Waiting to try again' });

    fetchError = null;
    await admin.query(`update public.integration_sync_runs set next_attempt_at = now() where id = $1`, [run.id]);
    await api().get('/api/v1/internal/cron/integration-runs').expect(401);
    const cron = (await api().get('/api/v1/internal/cron/integration-runs').set('Authorization', `Bearer ${CRON_SECRET}`).expect(200)).body;
    expect(cron.results).toEqual(expect.arrayContaining([{ runId: run.id, state: 'finished', reason: null }]));
    const done = (await api().get(`${base}/runs/${run.id}`).set(await owner()).expect(200)).body;
    expect(done).toMatchObject({ status: 'partial', counts: { created: 1, unchanged: 3, rejected: 1 } });
  });

  it('cancels a waiting run with a reason', async () => {
    fetchError = new ConnectorError('Down for maintenance', 'transient', true, 600);
    const run = (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'supplier', kind: 'incremental' }).expect(201)).body;
    fetchError = null;
    await api().post(`${base}/runs/${run.id}/cancel`).set(await owner()).send({ reason: 'x' }).expect(400);
    const cancelled = (await api().post(`${base}/runs/${run.id}/cancel`).set(await owner()).send({ reason: 'Wrong file' }).expect(200)).body;
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Wrong file', cancelledBy: { id: ids.ownerA } });
    await api().post(`${base}/runs/${run.id}/cancel`).set(await owner()).send({ reason: 'Again' }).expect(409);
  });

  it('lists runs; nothing of it is visible to another organisation or without permission', async () => {
    const list = (await api().get(`${base}/runs`).set(await owner()).query({ connectionId: connId }).expect(200)).body;
    expect(list.total).toBe(6);
    expect(list.data[0].status).toBe('cancelled');
    expect((await api().get(`${base}/runs`).set(await owner()).query({ status: 'partial' }).expect(200)).body.total).toBe(4);
    await api().get(`${base}/runs`).set(await inspector()).expect(403);
    await api().get(`${base}/runs/${firstRun}`).set(await other()).expect(404);
    await api().get(`${base}/runs/${firstRun}/rows`).set(await other()).expect(404);
    await api().post(`${base}/runs/${firstRun}/continue`).set(await other()).send({}).expect(404);
    await api().post(`${base}/runs/${firstRun}/cancel`).set(await other()).send({ reason: 'Not mine' }).expect(404);
    await api().get(`${base}/connections/${connId}/external-records`).set(await other()).expect(404);
    await api().post(`${base}/connections/${connId}/runs`).set(await other()).send({ entityType: 'supplier', kind: 'preview' }).expect(404);
    expect((await api().get(`${base}/runs`).set(await other()).expect(200)).body.total).toBe(0);
  });
});
