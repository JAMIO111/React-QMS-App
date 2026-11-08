/**
 * Audit definitions through the API (AU1): defining an audit with its procedure, checklist, what it is relevant to, frequency, expected auditor and pass mark, the register
 * (filters, sort, paging), editing (the lists replace), retiring, and who may do what. The rules themselves are in supabase/tests/audit_definitions.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a1');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};

const question = (over: object = {}) => ({ question: 'Is the cell clean?', answerType: 'pass_fail', critical: true, ...over });
const body = (over: object = {}) => ({
  title: 'Layered process audit, CNC cell',
  auditType: 'layered_process',
  purpose: 'Check the basics every week',
  procedure: '1. Walk the cell.\n2. Check each item.',
  frequency: { kind: 'weekly', firstDueOn: '2026-11-09' },
  graceDays: 2,
  weekdaysOnly: true,
  auditor: { kind: 'none' },
  passMark: 95,
  questions: [question(), { question: 'Coolant concentration', answerType: 'number', unit: '%', lowerLimit: 6, upperLimit: 9 }],
  targets: [{ kind: 'machine', machineId: ctx.machine }, { kind: 'operation', operationCode: 'OP-20' }],
  ...over,
});

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-aud');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  ctx.machine = (await api().post('/api/v1/machines').set(h).send({ code: 'CNC-1', name: 'Lathe' }).expect(201)).body.id;
  ctx.machine2 = (await api().post('/api/v1/machines').set(h).send({ code: 'CNC-2', name: 'Mill' }).expect(201)).body.id;
  ctx.machineB = (await api().post('/api/v1/machines').set(await as(ids.ownerB, ids.orgB)).send({ code: 'B-1', name: 'Other' }).expect(201)).body.id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('defining an audit', () => {
  it('is done by people who manage audits, and numbers the audit', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/audits').set(await as(ids.inspectorA)).send(body()).expect(403);
    await api().post('/api/v1/audits').set(await as(ids.outsider)).send(body()).expect(404);
    const a = (await api().post('/api/v1/audits').set(h).send(body()).expect(201)).body;
    ctx.a1 = a.id;
    expect(a).toMatchObject({
      reference: 'AUD-001',
      title: 'Layered process audit, CNC cell',
      auditType: 'layered_process',
      frequency: { kind: 'weekly', interval: null, firstDueOn: '2026-11-09' },
      graceDays: 2,
      weekdaysOnly: true,
      auditor: { kind: 'none', id: null, name: null },
      passMark: 95,
      status: 'active',
      questionCount: 2,
      criticalCount: 1,
      createdBy: { name: 'Ada Owner' },
    });
    expect(a.questions.map((q: { sequence: number; question: string }) => `${q.sequence}:${q.question}`)).toEqual(['1:Is the cell clean?', '2:Coolant concentration']);
    expect(a.questions[1]).toMatchObject({ answerType: 'number', unit: '%', lowerLimit: 6, upperLimit: 9, critical: false });
    expect(a.targets).toEqual([{ kind: 'machine', id: ctx.machine, label: 'CNC-1 · Lathe' }, { kind: 'operation', id: 'OP-20', label: 'OP-20' }]);
    const b = (await api().post('/api/v1/audits').set(h).send(body({ title: 'Monthly 5S', auditType: 'housekeeping', frequency: { kind: 'monthly', firstDueOn: '2026-11-30' }, questions: [], targets: [] })).expect(201)).body;
    ctx.a2 = b.id;
    expect(b.reference).toBe('AUD-002');
    const c = (await api().post('/api/v1/audits').set(h).send(body({ title: 'On request', auditType: 'system', frequency: { kind: 'on_demand' }, questions: [question()], targets: [{ kind: 'machine', machineId: ctx.machine2 }] })).expect(201)).body;
    ctx.a3 = c.id;
    expect(c.frequency).toEqual({ kind: 'on_demand', interval: null, firstDueOn: null });
  });

  it('refuses what cannot be an audit, in words', async () => {
    const h = await as(ids.ownerA);
    const bad = (extra: object) => api().post('/api/v1/audits').set(h).send(body(extra));
    await bad({ title: '  ' }).expect(400);
    await bad({ auditType: 'nonsense' }).expect(400);
    await bad({ frequency: { kind: 'monthly' } }).expect(400);
    await bad({ frequency: { kind: 'on_demand', firstDueOn: '2026-11-09' } }).expect(400);
    await bad({ frequency: { kind: 'every_n_days', firstDueOn: '2026-11-09' } }).expect(400);
    await bad({ frequency: { kind: 'weekly', interval: 2, firstDueOn: '2026-11-09' } }).expect(400);
    await bad({ passMark: 101 }).expect(400);
    await bad({ graceDays: 61 }).expect(400);
    await bad({ questions: [{ question: 'x', answerType: 'number' }] }).expect(400);
    await bad({ questions: [{ question: 'x', answerType: 'text', critical: true }] }).expect(400);
    await bad({ questions: [{ question: 'x', answerType: 'number', lowerLimit: 5, upperLimit: 1 }] }).expect(400);
    await bad({ targets: [{ kind: 'machine' }] }).expect(400);
    await bad({ extra: 1 }).expect(400);
    const notMember = await bad({ auditor: { kind: 'person', userId: ids.outsider } }).expect(409);
    expect(notMember.body.error).toMatchObject({ code: 'audit_rule', message: expect.stringContaining('active member') });
    await bad({ targets: [{ kind: 'machine', machineId: ctx.machineB }] }).expect(404);
    const twice = await bad({ targets: [{ kind: 'operation', operationCode: 'OP-1' }, { kind: 'operation', operationCode: 'op-1' }] }).expect(409);
    expect(twice.body.error.message).toContain('listed twice');
    // A refused audit leaves nothing behind.
    const all = (await api().get('/api/v1/audits?pageSize=50').set(h).expect(200)).body;
    expect(all.total).toBe(3);
  });

  it('expects a person, a role or a department, and names them', async () => {
    const h = await as(ids.ownerA);
    const person = (await api().patch(`/api/v1/audits/${ctx.a1}`).set(h).send({ auditor: { kind: 'person', userId: ids.inspectorA } }).expect(200)).body;
    expect(person.auditor).toMatchObject({ kind: 'person', id: ids.inspectorA, name: 'Unnamed person' });
    const role = (await admin.query(`select id from public.roles where organisation_id = $1 and key = 'inspector'`, [ids.orgA])).rows[0].id;
    expect((await api().patch(`/api/v1/audits/${ctx.a1}`).set(h).send({ auditor: { kind: 'role', roleId: role } }).expect(200)).body.auditor).toMatchObject({ kind: 'role', id: role, name: expect.any(String) });
    const cleared = (await api().patch(`/api/v1/audits/${ctx.a1}`).set(h).send({ auditor: { kind: 'none' } }).expect(200)).body;
    expect(cleared.auditor).toEqual({ kind: 'none', id: null, name: null });
  });
});

describe('the register', () => {
  it('lists with counts and a preview of what each is relevant to, paged and sorted on the server', async () => {
    const h = await as(ids.inspectorA);
    const all = (await api().get('/api/v1/audits').set(h).expect(200)).body;
    expect(all).toMatchObject({ page: 1, pageSize: 25, total: 3 });
    expect(all.data.map((r: { reference: string }) => r.reference)).toEqual(['AUD-001', 'AUD-002', 'AUD-003']);
    expect(all.data[0]).toMatchObject({ questionCount: 2, criticalCount: 1, targets: { machines: 1, operations: 1, departments: 0, preview: ['CNC-1', 'OP-20'] } });
    expect((await api().get('/api/v1/audits?sort=reference&order=desc&pageSize=1&page=2').set(h).expect(200)).body.data[0].reference).toBe('AUD-002');
    expect((await api().get('/api/v1/audits?sort=frequency').set(h).expect(200)).body.data.map((r: { reference: string }) => r.reference)).toEqual(['AUD-001', 'AUD-002', 'AUD-003']);
    expect((await api().get('/api/v1/audits?sort=title&order=asc').set(h).expect(200)).body.data[0].title).toBe('Layered process audit, CNC cell');
  });

  it('filters by search, type, status and what the audit is relevant to', async () => {
    const h = await as(ids.ownerA);
    const refs = async (query: string) => ((await api().get(`/api/v1/audits?${query}`).set(h).expect(200)).body.data as { reference: string }[]).map((r) => r.reference);
    expect(await refs('q=5s')).toEqual(['AUD-002']);
    expect(await refs('q=aud-003')).toEqual(['AUD-003']);
    expect(await refs('q=%25')).toEqual([]);
    expect(await refs('type=housekeeping,system')).toEqual(['AUD-002', 'AUD-003']);
    expect(await refs(`machineId=${ctx.machine}`)).toEqual(['AUD-001']);
    expect(await refs(`machineId=${ctx.machine2}`)).toEqual(['AUD-003']);
    expect(await refs('operationCode=op-20')).toEqual(['AUD-001']);
    expect(await refs('status=retired')).toEqual([]);
    await api().get('/api/v1/audits?type=nonsense').set(h).expect(400);
    await api().get('/api/v1/audits?sort=nonsense').set(h).expect(400);
    await api().get('/api/v1/audits?departmentId=nope').set(h).expect(400);
  });

  it('is closed to other organisations', async () => {
    const hb = await as(ids.ownerB, ids.orgB);
    expect((await api().get('/api/v1/audits').set(hb).expect(200)).body.total).toBe(0);
    await api().get(`/api/v1/audits/${ctx.a1}`).set(hb).expect(404);
    await api().patch(`/api/v1/audits/${ctx.a1}`).set(hb).send({ title: 'Hijacked' }).expect(404);
    await api().post(`/api/v1/audits/${ctx.a1}/retire`).set(hb).send({ reason: 'Hijacked' }).expect(404);
  });
});

describe('editing, retiring and reactivating', () => {
  it('changes the header and replaces the checklist and the list as a whole, and only for people who manage audits', async () => {
    const h = await as(ids.ownerA);
    await api().patch(`/api/v1/audits/${ctx.a1}`).set(await as(ids.inspectorA)).send({ title: 'Hijacked' }).expect(403);
    await api().patch(`/api/v1/audits/${ctx.a1}`).set(h).send({}).expect(400);
    await api().patch(`/api/v1/audits/${ctx.a1}`).set(h).send({ nonsense: true }).expect(400);
    const a = (await api().patch(`/api/v1/audits/${ctx.a1}`).set(h).send({
      title: 'Weekly LPA, CNC',
      passMark: 100,
      frequency: { kind: 'every_n_days', interval: 10, firstDueOn: '2026-11-16' },
      questions: [question({ question: 'Guards in place?' })],
      targets: [{ kind: 'machine', machineId: ctx.machine2 }],
    }).expect(200)).body;
    expect(a).toMatchObject({ title: 'Weekly LPA, CNC', passMark: 100, frequency: { kind: 'every_n_days', interval: 10, firstDueOn: '2026-11-16' }, questionCount: 1 });
    expect(a.questions.map((q: { question: string }) => q.question)).toEqual(['Guards in place?']);
    expect(a.targets).toEqual([{ kind: 'machine', id: ctx.machine2, label: 'CNC-2 · Mill' }]);
    // Leaving a list out leaves it alone; an empty list empties it.
    const kept = (await api().patch(`/api/v1/audits/${ctx.a1}`).set(h).send({ purpose: null }).expect(200)).body;
    expect(kept).toMatchObject({ purpose: null, questionCount: 1 });
    expect((await api().patch(`/api/v1/audits/${ctx.a1}`).set(h).send({ targets: [] }).expect(200)).body.targets).toEqual([]);
    await api().patch(`/api/v1/audits/${ctx.a1}`).set(h).send({ frequency: { kind: 'weekly' } }).expect(400);
    // A refused change to the checklist leaves the old one.
    await api().patch(`/api/v1/audits/${ctx.a1}`).set(h).send({ questions: [{ question: 'x', answerType: 'number' }] }).expect(400);
    expect((await api().get(`/api/v1/audits/${ctx.a1}`).set(h).expect(200)).body.questionCount).toBe(1);
  });

  it('retires with a reason, which the register can filter on, and brings an audit back', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/audits/${ctx.a2}/retire`).set(await as(ids.inspectorA)).send({ reason: 'x' }).expect(403);
    await api().post(`/api/v1/audits/${ctx.a2}/retire`).set(h).send({}).expect(400);
    const retired = (await api().post(`/api/v1/audits/${ctx.a2}/retire`).set(h).send({ reason: 'Replaced by the LPA' }).expect(200)).body;
    expect(retired).toMatchObject({ status: 'retired', retired: { reason: 'Replaced by the LPA', by: { name: 'Ada Owner' }, at: expect.any(String) } });
    const again = await api().post(`/api/v1/audits/${ctx.a2}/retire`).set(h).send({ reason: 'again' }).expect(409);
    expect(again.body.error).toMatchObject({ code: 'audit_rule', message: expect.stringContaining('already retired') });
    expect(((await api().get('/api/v1/audits?status=retired').set(h).expect(200)).body.data as { reference: string }[]).map((r) => r.reference)).toEqual(['AUD-002']);
    expect(((await api().get('/api/v1/audits?status=active').set(h).expect(200)).body.data as { reference: string }[]).map((r) => r.reference)).toEqual(['AUD-001', 'AUD-003']);
    const back = (await api().post(`/api/v1/audits/${ctx.a2}/reactivate`).set(h).expect(200)).body;
    expect(back).toMatchObject({ status: 'active', retired: null });
    await api().post(`/api/v1/audits/${ctx.a2}/reactivate`).set(h).expect(409);
  });
});
