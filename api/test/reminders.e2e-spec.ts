/**
 * Reminders (docs/workflow-engine-plan.md, WK2) through the API: a person's own reminders page, switching an area off, the organisation's reminder time and
 * time zone, and the worker's daily step writing the digest and the overdue notice (addressed to the person, emailed by default, linked to the record).
 * Who is told what is the database's (supabase/tests/reminders.test.sql); this checks the wiring.
 */
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { notificationPath } from '../src/email/email-content';
import { WorkerService } from '../src/worker/worker.service';
import { makeIds, requireDb, seed, testEnv, token } from './helpers';

const ids = makeIds('ea');
let app: INestApplication;
let admin: Pool;
let worker: WorkerService;
let riskId: string;
let actionId: string;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });

/** Runs SQL as a signed-in person (claims + authenticated role), as the app would. */
async function asPerson<T>(user: string, work: (q: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>): Promise<T> {
  const c = await admin.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated', aal: 'aal2' })]);
    await c.query('set local role authenticated');
    const out = await work((text, values) => c.query(text, values as unknown[]));
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-remind');
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000', CRON_SECRET: 'cron-secret-for-reminder-tests-012345' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true }), env);
  await app.init();
  worker = app.get(WorkerService);
  // A risk action given to the inspector, due yesterday.
  await asPerson(ids.ownerA, async (q) => {
    const cat = (await q(`select id from public.risk_categories where organisation_id = $1 and key = 'process'`, [ids.orgA])).rows[0].id;
    riskId = (await q(`select app.create_risk($1, jsonb_build_object('categoryId', $2::uuid, 'title', 'Reminder risk')) as id`, [ids.orgA, cat])).rows[0].id as string;
    await q(`select app.assess_risk($1, 3, 3, 'Why')`, [riskId]);
    await q(`select app.set_risk_treatment($1, 'mitigate', 'Plan')`, [riskId]);
    actionId = (
      await q(`select app.add_risk_action($1, jsonb_build_object('description', 'Check the foundry', 'ownerId', $2::uuid, 'dueDate', (current_date + 30)::text)) as id`, [
        riskId,
        ids.inspectorA,
      ])
    ).rows[0].id as string;
  });
  await admin.query(`update public.risk_actions set due_date = (now() at time zone 'UTC')::date - 1 where id = $1`, [actionId]);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('reminders', () => {
  it('shows a person their own work, overdue first, with a link to it', async () => {
    const res = (await api().get('/api/v1/reminders/mine').set(await as(ids.inspectorA)).expect(200)).body;
    expect(res.counts.overdue).toBeGreaterThanOrEqual(1);
    const item = res.data.find((i: { recordId: string }) => i.recordId === actionId);
    expect(item).toMatchObject({ area: 'risk_actions', areaLabel: 'Risk actions', overdue: true, areaEnabled: true, path: `/Risk/Register/${riskId}` });
    expect(item.label).toContain('Check the foundry');
    const owner = (await api().get('/api/v1/reminders/mine').set(await as(ids.ownerA)).expect(200)).body;
    expect(owner.data.find((i: { recordId: string }) => i.recordId === actionId)).toBeUndefined();
    await api().get('/api/v1/reminders/mine').expect(401);
  });

  it('switches an area off and on again', async () => {
    const h = await as(ids.inspectorA);
    const areas = (await api().get('/api/v1/reminder-areas').set(h).expect(200)).body;
    expect(areas.data).toHaveLength(12);
    expect(areas).toMatchObject({ reminderTime: '07:00', timeZone: 'Europe/London' });
    await api().put('/api/v1/reminder-areas').set(h).send({ area: 'nonsense', enabled: false }).expect(400);
    const off = (await api().put('/api/v1/reminder-areas').set(h).send({ area: 'risk_actions', enabled: false }).expect(200)).body;
    expect(off.data.find((a: { area: string }) => a.area === 'risk_actions').enabled).toBe(false);
    const mine = (await api().get('/api/v1/reminders/mine').set(h).expect(200)).body;
    expect(mine.data.find((i: { recordId: string }) => i.recordId === actionId).areaEnabled).toBe(false);
    await api().put('/api/v1/reminder-areas').set(h).send({ area: 'risk_actions', enabled: true }).expect(200);
  });

  it('keeps the reminder time and time zone in the organisation settings', async () => {
    await api().patch('/api/v1/organisations/current').set(await as(ids.inspectorA)).send({ settings: { reminderTime: '06:30' } }).expect(403);
    await api().patch('/api/v1/organisations/current').set(await as(ids.ownerA)).send({ settings: { reminderTime: '06:31' } }).expect(400);
    await api().patch('/api/v1/organisations/current').set(await as(ids.ownerA)).send({ settings: { timeZone: 'Mars/Olympus' } }).expect(400);
    const res = (await api().patch('/api/v1/organisations/current').set(await as(ids.ownerA)).send({ settings: { reminderTime: '00:00', timeZone: 'UTC' } }).expect(200)).body;
    expect(res.settings).toMatchObject({ reminderTime: '00:00', timeZone: 'UTC', effectiveTimeZone: 'UTC' });
  });

  it('sends the daily digest and the overdue notice through the worker, once, to the person', async () => {
    await admin.query(`delete from app.reminder_runs where organisation_id = $1`, [ids.orgA]);
    const tick = await worker.tick({ source: 'test', budgetMs: 20_000 });
    const step = tick.steps.find((s) => s.name === 'reminders');
    expect(step).toMatchObject({ ok: true });
    const digest = (await admin.query(`select overdue, summary from public.reminder_digests where organisation_id = $1 and user_id = $2`, [ids.orgA, ids.inspectorA])).rows;
    expect(digest).toHaveLength(1);
    expect(digest[0].summary).toContain('Check the foundry (overdue since');
    const notices = (
      await admin.query(
        `select t.key, n.recipient_user_id, n.actor_user_id, n.details from public.notifications n join public.notification_event_types t on t.id = n.event_type_id
          where n.organisation_id = $1 and t.key like 'reminder_%' order by t.key`,
        [ids.orgA],
      )
    ).rows;
    expect(notices.map((n) => n.key)).toEqual(['reminder_digests.created', 'reminder_overdue_notices.created']);
    expect(notices.every((n) => n.recipient_user_id === ids.inspectorA && n.actor_user_id === null)).toBe(true);
    expect(notificationPath('reminder_overdue_notices', 'x', notices[1].details)).toBe(`/Risk/Register/${riskId}`);
    expect(notificationPath('reminder_digests', 'x', notices[0].details)).toBe('/Reminders');
    // The inspector sees both in their notifications; the owner sees neither.
    const mine = (await api().get('/api/v1/notifications').set(await as(ids.inspectorA)).expect(200)).body;
    expect(mine.data.filter((n: { entityType: string }) => n.entityType.startsWith('reminder_'))).toHaveLength(2);
    const owners = (await api().get('/api/v1/notifications').set(await as(ids.ownerA)).expect(200)).body;
    expect(owners.data.filter((n: { entityType: string }) => n.entityType.startsWith('reminder_'))).toHaveLength(0);
    // A second tick the same day sends nothing new.
    await worker.tick({ source: 'test', budgetMs: 20_000 });
    expect((await admin.query(`select count(*)::int as n from public.reminder_digests where organisation_id = $1`, [ids.orgA])).rows[0].n).toBe(1);
  });
});
