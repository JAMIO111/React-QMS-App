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
  questions: [question(), { question: 'Coolant concentration', answerType: 'numeric', unit: '%', lowerLimit: 6, upperLimit: 9 }],
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
    expect(a.questions[1]).toMatchObject({ answerType: 'numeric', unit: '%', lowerLimit: 6, upperLimit: 9, critical: false, nominal: null, options: null, ratingMax: null, passRating: null });
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
    await bad({ questions: [{ question: 'x', answerType: 'measurement', nominal: 10, lowerLimit: 9, upperLimit: 11 }] }).expect(400);
    await bad({ questions: [{ question: 'x', answerType: 'text', critical: true }] }).expect(400);
    await bad({ questions: [{ question: 'x', answerType: 'numeric', lowerLimit: 5, upperLimit: 1 }] }).expect(400);
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
    await api().patch(`/api/v1/audits/${ctx.a1}`).set(h).send({ questions: [{ question: 'x', answerType: 'multiple_choice', options: [{ label: 'Only one' }] }] }).expect(400);
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

describe('response types set in the template', () => {
  const ALL = [
    { question: 'Procedure followed?', answerType: 'yes_no', passAnswer: 'no', critical: true },
    { question: 'Process meets requirements?', answerType: 'compliant' },
    { question: 'Product meets specification?', answerType: 'pass_fail' },
    { question: 'Requirement applicable?', answerType: 'yes_no_na', passAnswer: 'yes' },
    { question: 'Measured temperature', answerType: 'numeric', unit: 'C' },
    { question: 'Describe the observation', answerType: 'text', guidance: 'What did you see?' },
    { question: 'Select applicable condition', answerType: 'multiple_choice', options: [{ label: 'Clean', passes: true }, { label: 'Oily', passes: false }] },
    { question: 'Actual diameter', answerType: 'measurement', nominal: 10, lowerLimit: 9.95, upperLimit: 10.05, unit: 'mm', critical: true },
    { question: 'Upload photograph', answerType: 'evidence' },
    { question: 'Housekeeping score', answerType: 'rating', passRating: 3 },
    { question: 'Overall impression', answerType: 'rating', ratingMax: 7 },
  ];

  it('stores every type with what it needs and gives it back as written', async () => {
    const h = await as(ids.ownerA);
    const made = (await api().post('/api/v1/audits').set(h).send(body({ title: 'All types', questions: ALL, targets: [] })).expect(201)).body;
    expect(made.questions.map((q: { answerType: string }) => q.answerType)).toEqual(ALL.map((q) => q.answerType));
    const by = (n: number) => made.questions[n - 1];
    expect(by(1)).toMatchObject({ passAnswer: 'no', critical: true });
    expect(by(2)).toMatchObject({ passAnswer: null, critical: false });
    expect(by(5)).toMatchObject({ unit: 'C', lowerLimit: null, upperLimit: null });
    expect(by(7).options).toEqual([{ label: 'Clean', passes: true }, { label: 'Oily', passes: false }]);
    expect(by(8)).toMatchObject({ nominal: 10, lowerLimit: 9.95, upperLimit: 10.05, unit: 'mm', critical: true });
    expect(by(10)).toMatchObject({ ratingMax: 5, passRating: 3 });
    expect(by(11)).toMatchObject({ ratingMax: 7, passRating: null });
    // A field that does not belong to the type is ignored, not stored.
    const odd = (await api().post('/api/v1/audits').set(h).send(body({ title: 'Odd', questions: [{ question: 'x', answerType: 'text', unit: 'mm', options: [{ label: 'a' }, { label: 'b' }], nominal: 3 }], targets: [] })).expect(201)).body;
    expect(odd.questions[0]).toMatchObject({ unit: null, options: null, nominal: null });
  });

  it('refuses what a type cannot be, in words', async () => {
    const h = await as(ids.ownerA);
    const bad = async (q: object) => api().post('/api/v1/audits').set(h).send(body({ title: 'Bad', questions: [{ question: 'x', ...q }], targets: [] }));
    for (const q of [
      { answerType: 'measurement', nominal: 10, lowerLimit: 9, upperLimit: 11 },
      { answerType: 'measurement', nominal: 12, lowerLimit: 9, upperLimit: 11, unit: 'mm' },
      { answerType: 'measurement', lowerLimit: 9, upperLimit: 11, unit: 'mm' },
      { answerType: 'multiple_choice' },
      { answerType: 'multiple_choice', options: [{ label: 'One' }] },
      { answerType: 'multiple_choice', options: [{ label: 'A' }, { label: ' a' }] },
      { answerType: 'multiple_choice', options: [{ label: 'A', passes: false }, { label: 'B', passes: false }] },
      { answerType: 'rating', ratingMax: 2 },
      { answerType: 'rating', ratingMax: 11 },
      { answerType: 'rating', passRating: 6 },
      { answerType: 'rating', passRating: 0 },
      { answerType: 'text', critical: true },
      { answerType: 'evidence', critical: true },
      { answerType: 'numeric', critical: true },
      { answerType: 'rating', critical: true },
      { answerType: 'yes_no', passAnswer: 'maybe' },
      { answerType: 'number' },
    ]) {
      const res = await bad(q);
      expect([q, res.status]).toEqual([q, 400]);
    }
    // A numeric question is scored once it has a limit, and a rating once it has a lowest acceptable rating: then it may be critical.
    expect((await bad({ answerType: 'numeric', lowerLimit: 1, critical: true })).status).toBe(201);
    expect((await bad({ answerType: 'rating', passRating: 2, critical: true })).status).toBe(201);
  });

  it('offers the operation codes of the plans and of audits, one of each, for choosing what an audit is relevant to', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/audits').set(h).send(body({ title: 'Ops', questions: [], targets: [{ kind: 'operation', operationCode: 'OP-30' }, { kind: 'operation', operationCode: 'OP-40' }] })).expect(201);
    await api().post('/api/v1/audits').set(h).send(body({ title: 'Ops again', questions: [], targets: [{ kind: 'operation', operationCode: 'op-30' }] })).expect(201);
    const list = (await api().get('/api/v1/audits/operation-codes').set(await as(ids.inspectorA)).expect(200)).body.data as { code: string; name: string | null }[];
    expect(list.map((o) => o.code.toUpperCase())).toEqual(expect.arrayContaining(['OP-30', 'OP-40']));
    expect(new Set(list.map((o) => o.code.toUpperCase())).size).toBe(list.length);
    expect((await api().get('/api/v1/audits/operation-codes').set(await as(ids.ownerB, ids.orgB)).expect(200)).body.data).toEqual([]);
    await api().get('/api/v1/audits/operation-codes').set(await as(ids.outsider)).expect(404);
  });
});
