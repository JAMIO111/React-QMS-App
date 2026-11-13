/**
 * Workflow rules WF1 through the API: the catalogue, writing a rule (checked against the trigger), versions with a reason, and the worker turning an outbox event
 * into a run, a notice and a task for the right person, once; the task's person closing it. Who may be told what is the database's
 * (supabase/tests/workflow_rules.test.sql); this checks the wiring.
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
import { categoryId, makeIds, requireDb, seed, testEnv, token } from './helpers';

const ids = makeIds('eb');
let app: INestApplication;
let admin: Pool;
let worker: WorkerService;
let ruleId: string;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });

/** An NC inserted as the database would have it, and its outbox event (the worker reads events written after it first read). */
async function raiseNc(reference: string, severity: string): Promise<string> {
  const cat = await categoryId(admin, ids.orgA);
  const id = (
    await admin.query(
      `insert into public.nonconformances (organisation_id, reference, source, stage, severity, title, category_id, site_id) values ($1, $2, 'internal', 'open', $3, $4, $5, $6) returning id`,
      [ids.orgA, reference, severity, `Workflow ${reference}`, cat, ids.siteA],
    )
  ).rows[0].id as string;
  const has = (await admin.query(`select 1 from public.outbox_events where entity_id = $1 and event_type = 'ncr.created'`, [id])).rows.length;
  if (!has) await admin.query(`insert into public.outbox_events (organisation_id, event_type, entity_type, entity_id) values ($1, 'ncr.created', 'nonconformance', $2)`, [ids.orgA, id]);
  return id;
}

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-wf');
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000', CRON_SECRET: 'cron-secret-for-workflow-tests-0123' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true }), env);
  await app.init();
  worker = app.get(WorkerService);
  await admin.query(`update app.worker_state set lease_tick = null, lease_until = null`);
  // The consumer starts reading from its first read: make sure it exists before the events of this suite.
  await worker.tick({ source: 'test', budgetMs: 20_000 });
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

beforeEach(async () => {
  await admin.query(`update app.worker_state set lease_tick = null, lease_until = null`);
});

describe('workflow rules', () => {
  it('offers the catalogue to people who read workflows only', async () => {
    const res = (await api().get('/api/v1/workflow-triggers').set(await as(ids.ownerA)).expect(200)).body;
    expect(res.data.map((t: { eventType: string }) => t.eventType)).toContain('ncr.created');
    await api().get('/api/v1/workflow-triggers').set(await as(ids.inspectorA)).expect(403);
  });

  it('checks a rule against its trigger and the organisation, then saves version 1', async () => {
    const h = await as(ids.ownerA);
    const bad = await api()
      .post('/api/v1/workflow-rules')
      .set(h)
      .send({ name: 'Bad', trigger: 'ncr.created', conditions: { all: [{ field: 'colour', op: 'eq', value: 'red' }] }, actions: [{ type: 'notify', recipients: [{ kind: 'record_owner' }], message: 'x' }] })
      .expect(409);
    expect(bad.body.error.details.problems[0]).toContain('"colour" is not something');
    await api()
      .post('/api/v1/workflow-rules')
      .set(h)
      .send({ name: 'Stranger', trigger: 'ncr.created', actions: [{ type: 'notify', recipients: [{ kind: 'person', userId: ids.ownerB }], message: 'x' }] })
      .expect(409);
    await api().post('/api/v1/workflow-rules').set(await as(ids.inspectorA)).send({ name: 'x', trigger: 'ncr.created', actions: [] }).expect(403);
    const made = (
      await api()
        .post('/api/v1/workflow-rules')
        .set(h)
        .send({
          name: 'Major NCs',
          trigger: 'ncr.created',
          conditions: { all: [{ field: 'severity', op: 'gte', value: 'major' }] },
          actions: [
            { type: 'notify', recipients: [{ kind: 'person', userId: ids.inspectorA }], message: 'A major NC was raised' },
            { type: 'task', assignee: { kind: 'person', userId: ids.inspectorA }, title: 'Check the containment', dueDays: 2 },
          ],
        })
        .expect(201)
    ).body;
    ruleId = made.id;
    expect(made).toMatchObject({ reference: expect.stringMatching(/^WF-\d{3}$/), version: 1, status: 'active', triggerLabel: 'A non-conformance is raised' });
  });

  it('makes a change to what a rule does a new version, with a reason', async () => {
    const h = await as(ids.ownerA);
    await api().patch(`/api/v1/workflow-rules/${ruleId}`).set(h).send({ conditions: { all: [{ field: 'severity', op: 'in', value: ['major', 'critical'] }] } }).expect(409);
    const res = (
      await api().patch(`/api/v1/workflow-rules/${ruleId}`).set(h).send({ conditions: { all: [{ field: 'severity', op: 'in', value: ['major', 'critical'] }] }, reason: 'Say it plainly' }).expect(200)
    ).body;
    expect(res.version).toBe(2);
    expect(res.versions.map((v: { version: number; reason: string | null }) => [v.version, v.reason])).toEqual([
      [2, 'Say it plainly'],
      [1, null],
    ]);
    const renamed = (await api().patch(`/api/v1/workflow-rules/${ruleId}`).set(h).send({ name: 'Major and critical NCs' }).expect(200)).body;
    expect(renamed).toMatchObject({ name: 'Major and critical NCs', version: 2 });
  });

  it('runs when a matching NC is raised: one notice and one task for the person, once; not for a minor NC', async () => {
    const major = await raiseNc('WF-NC-1', 'major');
    await raiseNc('WF-NC-2', 'minor');
    const tick = await worker.tick({ source: 'test', budgetMs: 30_000 });
    expect(tick.steps.find((s) => s.name === 'workflows')?.result).toMatchObject({ matched: 1, actionsQueued: 2 });
    const rule = (await api().get(`/api/v1/workflow-rules/${ruleId}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(rule.runs).toHaveLength(1);
    expect(rule.runs[0]).toMatchObject({ version: 2, status: 'done', record: { kind: 'nonconformance', id: major, path: `/Non-Conformance/Register/${major}` } });
    const notes = (
      await admin.query(
        `select t.key, n.recipient_user_id, n.details from public.notifications n join public.notification_event_types t on t.id = n.event_type_id
          where n.organisation_id = $1 and t.key like 'workflow_%' order by t.key`,
        [ids.orgA],
      )
    ).rows;
    expect(notes.map((n) => n.key)).toEqual(['workflow_notices.created', 'workflow_tasks.created']);
    expect(notes.every((n) => n.recipient_user_id === ids.inspectorA)).toBe(true);
    expect(notificationPath('workflow_notices', 'x', notes[0].details)).toBe(`/Non-Conformance/Register/${major}`);
    expect(notificationPath('workflow_tasks', 'x', notes[1].details)).toBe('/Tasks');
    // Another tick does nothing more.
    await worker.tick({ source: 'test', budgetMs: 20_000 });
    expect((await admin.query(`select count(*)::int as n from public.workflow_tasks where organisation_id = $1`, [ids.orgA])).rows[0].n).toBe(1);
  });

  it('tests a rule against a recent event without saving or sending anything', async () => {
    const h = await as(ids.ownerA);
    const events = (await api().get('/api/v1/workflow-test-events?trigger=ncr.created').set(h).expect(200)).body.data;
    const major = events.find((e: { record: { label: string } }) => e.record.label.startsWith('WF-NC-1'));
    const minor = events.find((e: { record: { label: string } }) => e.record.label.startsWith('WF-NC-2'));
    expect(major.facts.find((f: { field: string }) => f.field === 'severity')).toMatchObject({ value: 'major', words: 'Major' });
    await api().get('/api/v1/workflow-test-events?trigger=ncr.created').set(await as(ids.inspectorA)).expect(403);
    await api().get('/api/v1/workflow-test-events?trigger=nonsense').set(h).expect(409);
    const before = (await admin.query(`select count(*)::int as n from public.workflow_tasks where organisation_id = $1`, [ids.orgA])).rows[0].n;
    const rule = {
      trigger: 'ncr.created',
      conditions: { all: [{ field: 'severity', op: 'gte', value: 'major' }] },
      actions: [
        { type: 'notify', recipients: [{ kind: 'person', userId: ids.inspectorA }, { kind: 'person', userId: ids.ownerB }], message: 'x' },
        { type: 'task', assignee: { kind: 'person', userId: ids.inspectorA }, title: 'Check' },
      ],
    };
    const hit = (await api().post('/api/v1/workflow-tests').set(h).send({ ...rule, eventId: major.eventId }).expect(200)).body;
    expect(hit).toMatchObject({ matched: true, conditions: { all: [{ field: 'severity', label: 'Severity', holds: true }] } });
    expect(hit.actions[0].people).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: ids.inspectorA, told: true }), expect.objectContaining({ userId: ids.ownerB, told: false })]),
    );
    expect(hit.actions[0].wouldTell).toBe(1);
    expect(hit.labels[ids.inspectorA]).toBeTruthy();
    const miss = (await api().post('/api/v1/workflow-tests').set(h).send({ ...rule, eventId: minor.eventId }).expect(200)).body;
    expect(miss).toMatchObject({ matched: false, actions: [{ wouldTell: 0 }, { wouldTell: 0 }] });
    await api().post('/api/v1/workflow-tests').set(h).send({ ...rule, trigger: 'capa.created', conditions: { all: [] }, eventId: major.eventId }).expect(409);
    await api().post('/api/v1/workflow-tests').set(await as(ids.ownerB, ids.orgB)).send({ ...rule, actions: [], eventId: major.eventId }).expect(404);
    expect((await admin.query(`select count(*)::int as n from public.workflow_tasks where organisation_id = $1`, [ids.orgA])).rows[0].n).toBe(before);
  });

  it('names the people, roles and records a rule refers to', async () => {
    const rule = (await api().get(`/api/v1/workflow-rules/${ruleId}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(rule.labels[ids.inspectorA]).toBeTruthy();
  });

  it('lets the person see and close their task, and only someone who manages workflows cancel one', async () => {
    const mine = (await api().get('/api/v1/workflow-tasks/mine').set(await as(ids.inspectorA)).expect(200)).body;
    expect(mine.openCount).toBe(1);
    const task = mine.data[0];
    expect(task).toMatchObject({ title: 'Check the containment', ruleName: 'Major and critical NCs', status: 'open' });
    expect(task.record.path).toMatch(/^\/Non-Conformance\/Register\//);
    expect((await api().get('/api/v1/workflow-tasks/mine').set(await as(ids.ownerA)).expect(200)).body.data).toHaveLength(0);
    await api().post(`/api/v1/workflow-tasks/${task.id}/cancel`).set(await as(ids.inspectorA)).send({ reason: 'Not mine' }).expect(403);
    const done = (await api().post(`/api/v1/workflow-tasks/${task.id}/complete`).set(await as(ids.inspectorA)).send({ note: 'Contained' }).expect(200)).body;
    expect(done).toMatchObject({ status: 'done', doneNote: 'Contained' });
    await api().post(`/api/v1/workflow-tasks/${task.id}/complete`).set(await as(ids.inspectorA)).send({}).expect(409);
    await api().post(`/api/v1/workflow-tasks/${task.id}/reopen`).set(await as(ids.inspectorA)).expect(200);
    const cancelled = (await api().post(`/api/v1/workflow-tasks/${task.id}/cancel`).set(await as(ids.ownerA)).send({ reason: 'Raised in error' }).expect(200)).body;
    expect(cancelled.status).toBe('cancelled');
  });

  it('pauses and retires a rule', async () => {
    const h = await as(ids.ownerA);
    expect((await api().post(`/api/v1/workflow-rules/${ruleId}/status`).set(h).send({ status: 'paused' }).expect(200)).body.status).toBe('paused');
    await api().post(`/api/v1/workflow-rules/${ruleId}/status`).set(h).send({ status: 'retired' }).expect(409);
    expect((await api().post(`/api/v1/workflow-rules/${ruleId}/status`).set(h).send({ status: 'retired', reason: 'No longer wanted' }).expect(200)).body).toMatchObject({
      status: 'retired',
      statusReason: 'No longer wanted',
    });
    const list = (await api().get('/api/v1/workflow-rules').set(h).expect(200)).body;
    expect(list.data.find((r: { id: string }) => r.id === ruleId)).toMatchObject({ status: 'retired', runs: 1 });
  });
});
