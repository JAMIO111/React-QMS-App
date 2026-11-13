/**
 * The background worker (docs/workflow-engine-plan.md, WK1) through the API: the tick's secret, its steps in order, one tick at a time, background
 * jobs (done, tried again, failed at once, no handler, never queued twice) and the operator's view. The queue's own rules are covered by
 * supabase/tests/worker_foundation.test.sql; this checks the wiring.
 */
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { PermanentJobError, WorkerJobRegistry } from '../src/worker/job-registry';
import { WorkerService } from '../src/worker/worker.service';
import { makeIds, requireDb, seed, testEnv, token } from './helpers';

const ids = makeIds('e8');
const SECRET = 'cron-secret-for-worker-tests-0123456789';
let app: INestApplication;
let admin: Pool;
let worker: WorkerService;
let registry: WorkerJobRegistry;
const api = () => request(app.getHttpServer());
const cron = { Authorization: `Bearer ${SECRET}` };
const as = async (user: string, claims: Record<string, unknown> = {}) => ({ Authorization: `Bearer ${await token(user, claims)}` });
const job = async (id: string) =>
  (await admin.query(`select status, attempts, last_error, result from app.worker_jobs where id = $1`, [id])).rows[0] as { status: string; attempts: number; last_error: string | null; result: unknown };

const calls: string[] = [];
let flakyFails = 1;

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-worker');
  await admin.query(`insert into public.platform_admins (user_id, note) values ($1, 'e2e operator') on conflict do nothing`, [ids.outsider]);
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000', CRON_SECRET: SECRET });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true }), env);
  await app.init();
  worker = app.get(WorkerService);
  registry = app.get(WorkerJobRegistry);
  registry.register('test.echo', async (j) => {
    calls.push(`echo:${String(j.payload.n)}`);
    return { echoed: j.payload.n, organisationId: j.organisationId };
  });
  registry.register('test.flaky', async () => {
    if (flakyFails-- > 0) throw new Error('Not yet');
    return { ok: true };
  });
  registry.register('test.bad', async () => {
    throw new PermanentJobError('That record is gone');
  });
});

afterAll(async () => {
  await admin?.query(`delete from app.worker_jobs where kind like 'test.%'`);
  await admin?.query(`delete from public.platform_admins where user_id = $1`, [ids.outsider]);
  await app?.close();
  await admin?.end();
});

beforeEach(async () => {
  await admin.query(`update app.worker_state set lease_tick = null, lease_until = null`);
});

describe('the worker tick', () => {
  it('needs the cron secret', async () => {
    await api().post('/api/v1/internal/worker/tick').expect(401);
    await api().post('/api/v1/internal/worker/tick').set({ Authorization: 'Bearer wrong' }).expect(401);
    await api().post('/api/v1/internal/worker/tick?source=nonsense').set(cron).expect(400);
  });

  it('runs every step in order and records the tick', async () => {
    const res = (await api().post('/api/v1/internal/worker/tick?source=manual&budgetMs=20000').set(cron).expect(200)).body;
    expect(res.skipped).toBe(false);
    expect(res.steps.map((s: { name: string }) => s.name)).toEqual(['quality-alerts', 'documents', 'reminders', 'scorecards', 'workflows', 'jobs', 'email', 'imports']);
    expect(res.steps.every((s: { ok: boolean }) => s.ok)).toBe(true);
    expect(res.outcome).toBe('done');
    const tick = (await admin.query(`select source, outcome, finished_at, jsonb_array_length(steps) as n from app.worker_ticks where id = $1`, [res.tickId])).rows[0];
    expect(tick).toMatchObject({ source: 'manual', outcome: 'done', n: 8 });
    expect(tick.finished_at).not.toBeNull();
    expect((await admin.query(`select lease_until from app.worker_state`)).rows[0].lease_until).toBeNull();
  });

  it('skips while another tick is still working', async () => {
    await admin.query(`update app.worker_state set lease_tick = 0, lease_until = now() + interval '1 minute'`);
    const res = (await api().get('/api/v1/internal/worker/tick?source=pg_cron').set(cron).expect(200)).body;
    expect(res).toMatchObject({ skipped: true, outcome: 'skipped', steps: [] });
    expect((await admin.query(`select outcome from app.worker_ticks where id = $1`, [res.tickId])).rows[0].outcome).toBe('skipped');
  });
});

describe('background jobs', () => {
  it('runs a job once however often it is queued, with its organisation and result', async () => {
    const a = await worker.enqueue('test.echo', { n: 1 }, { organisationId: ids.orgA, idempotencyKey: 'e8-echo-1' });
    expect(await worker.enqueue('test.echo', { n: 99 }, { organisationId: ids.orgA, idempotencyKey: 'e8-echo-1' })).toBe(a);
    const later = await worker.enqueue('test.echo', { n: 2 }, { runAt: new Date(Date.now() + 3_600_000) });
    calls.length = 0;
    const res = await worker.tick({ source: 'test', budgetMs: 20_000 });
    expect(res.steps.find((s) => s.name === 'jobs')?.result).toMatchObject({ done: 1 });
    expect(calls).toEqual(['echo:1']);
    expect(await job(a)).toMatchObject({ status: 'done', attempts: 1, result: { echoed: 1, organisationId: ids.orgA } });
    expect(await job(later)).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('tries a failing job again later, and fails one that can never succeed at once', async () => {
    flakyFails = 1;
    const flaky = await worker.enqueue('test.flaky', {});
    const bad = await worker.enqueue('test.bad', {});
    const orphan = await worker.enqueue('test.nobody', {});
    await worker.tick({ source: 'test', budgetMs: 20_000 });
    expect(await job(flaky)).toMatchObject({ status: 'queued', attempts: 1, last_error: 'Not yet' });
    expect(await job(bad)).toMatchObject({ status: 'failed', attempts: 1, last_error: 'That record is gone' });
    expect(await job(orphan)).toMatchObject({ status: 'failed', last_error: 'No handler for job kind test.nobody' });
    await admin.query(`update app.worker_jobs set run_at = now() where id = $1`, [flaky]);
    await worker.tick({ source: 'test', budgetMs: 20_000 });
    expect(await job(flaky)).toMatchObject({ status: 'done', attempts: 2, last_error: null });
  });

  it('refuses a kind that is not a plain name', () => {
    expect(() => registry.register('Bad Kind', async () => undefined)).toThrow('Bad job kind');
  });
});

describe('the operator view', () => {
  it('is for operators with two-factor only', async () => {
    await api().get('/api/v1/platform/worker').expect(401);
    expect((await api().get('/api/v1/platform/worker').set(await as(ids.ownerA, { aal: 'aal2' })).expect(404)).body.error.code).toBe('not_found');
    expect((await api().get('/api/v1/platform/worker').set(await as(ids.outsider, { aal: 'aal1' })).expect(403)).body.error.code).toBe('mfa_required');
  });

  it('shows the last tick, the job kinds, the queue and failures without payloads', async () => {
    await worker.tick({ source: 'test', budgetMs: 10_000 });
    const res = (await api().get('/api/v1/platform/worker').set(await as(ids.outsider, { aal: 'aal2' })).expect(200)).body;
    expect(res.cronConfigured).toBe(true);
    expect(res.jobKinds).toEqual(expect.arrayContaining(['test.bad', 'test.echo', 'test.flaky']));
    expect(res.lastTick).toMatchObject({ source: 'test', outcome: 'done' });
    expect(res.recentTicks.length).toBeGreaterThan(0);
    const failure = res.jobs.failures.find((f: { kind: string }) => f.kind === 'test.bad');
    expect(failure).toMatchObject({ status: 'failed', error: 'That record is gone' });
    expect(failure).not.toHaveProperty('payload');
  });
});
