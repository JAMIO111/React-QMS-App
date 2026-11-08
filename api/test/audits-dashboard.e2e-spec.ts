/**
 * The audits dashboard through the API: planned versus done (the schedule's own states), results, findings, the questions that fail most, coverage of machines, operations and
 * departments, and the latest template changes. The data is made through the API where it can be, and by SQL where it needs a date in the past.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a8');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const day = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dashboard = async (q = `from=${day(-29)}&to=${day(0)}`, h?: Record<string, string>) => api().get(`/api/v1/audits-dashboard?${q}`).set(h ?? (await as(ids.ownerA)));
const sum = (rows: Record<string, number>[], key: string) => rows.reduce((t, r) => t + r[key], 0);

/** Starts an audit, answers it as given ('pass' | 'fail' per question, in order), dates it, and completes it unless told not to. */
const carryOut = async (auditId: string, answers: ('pass' | 'fail')[], performedOn: string, extra: object = {}, complete = true) => {
  const inspector = await as(ids.inspectorA);
  const rec = (await api().post('/api/v1/audit-records').set(inspector).send({ auditId, ...extra }).expect(201)).body;
  const full = (await api().get(`/api/v1/audit-records/${rec.id}`).set(inspector).expect(200)).body;
  for (const [i, a] of answers.entries()) {
    await api().put(`/api/v1/audit-records/${rec.id}/responses`).set(inspector).send({ questionId: full.questions[i].id, answer: a, ...(a === 'fail' ? { note: 'Not as it should be' } : {}) }).expect(200);
  }
  await api().patch(`/api/v1/audit-records/${rec.id}`).set(inspector).send({ performedOn }).expect(200);
  const withResponses = (await api().get(`/api/v1/audit-records/${rec.id}`).set(inspector).expect(200)).body;
  return { id: rec.id as string, responses: withResponses.questions.map((q: { response: { id: string } }) => q.response?.id) as string[], complete: async () => api().post(`/api/v1/audit-records/${rec.id}/complete`).set(inspector).send({}) };
};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-dash');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const owner = await as(ids.ownerA);
  const m1 = (await api().post('/api/v1/machines').set(owner).send({ code: 'CNC-1', name: 'Lathe', siteId: ids.siteA }).expect(201)).body.id;
  const m2 = (await api().post('/api/v1/machines').set(owner).send({ code: 'CNC-2', name: 'Mill', siteId: ids.siteA }).expect(201)).body.id;
  const m3 = (await api().post('/api/v1/machines').set(owner).send({ code: 'CNC-3', name: 'Grinder', siteId: ids.siteA }).expect(201)).body.id;
  const dept = (await admin.query(`insert into public.departments (organisation_id, site_id, code, name) values ($1, $2, 'MACH', 'Machining') returning id`, [ids.orgA, ids.siteA])).rows[0].id;
  ctx.employee = (await admin.query(`insert into public."Employees" (organisation_id, first_name, surname) values ($1, 'Grace', 'Hopper') returning id`, [ids.orgA])).rows[0].id;
  const questions = [{ question: 'Guard fitted?', answerType: 'pass_fail', critical: true }, { question: 'Floor clear?', answerType: 'pass_fail' }];
  ctx.audit = (await api().post('/api/v1/audits').set(owner).send({
    title: 'Cell audit', auditType: 'layered_process', frequency: { kind: 'on_demand' }, graceDays: 2, passMark: 50, questions,
    targets: [{ kind: 'machine', machineId: m1 }, { kind: 'machine', machineId: m2 }, { kind: 'operation', operationCode: 'OP-10' }, { kind: 'department', departmentId: dept }],
  }).expect(201)).body.id;
  ctx.audit2 = (await api().post('/api/v1/audits').set(owner).send({
    title: 'Grinding audit', auditType: 'process', frequency: { kind: 'on_demand' }, passMark: 100, questions: [questions[1]],
    targets: [{ kind: 'machine', machineId: m3 }, { kind: 'operation', operationCode: 'OP-99' }],
  }).expect(201)).body.id;

  // Slots of the first audit, in the past: done on time, done late, missed, overdue, skipped.
  const slot = async (due: number, status = 'scheduled') =>
    (await admin.query(
      `insert into public.audit_occurrences (organisation_id, audit_definition_id, due_on, status, skipped_at, skipped_reason) values ($1, $2, $3, $4, ${status === 'skipped' ? 'now()' : 'null'}, ${status === 'skipped' ? `'Shutdown'` : 'null'}) returning id`,
      [ids.orgA, ctx.audit, day(due), status])).rows[0].id as string;
  ctx.s1 = await slot(-25);
  ctx.s2 = await slot(-18);
  await slot(-12); // missed
  await slot(-1); // overdue (inside its two days of grace)
  await slot(-20, 'skipped');

  const r1 = await carryOut(ctx.audit, ['pass', 'pass'], day(-24), { occurrenceId: ctx.s1, targets: [{ kind: 'machine', machineId: m1 }] });
  expect((await r1.complete()).status).toBe(200);
  const r2 = await carryOut(ctx.audit, ['fail', 'pass'], day(-14), { occurrenceId: ctx.s2, targets: [{ kind: 'machine', machineId: m1 }, { kind: 'operation', operationCode: 'OP-10' }] });
  ctx.r2 = r2.id;
  const classes = Object.fromEntries(((await api().get('/api/v1/audit-finding-classifications').set(owner).expect(200)).body.data as { key: string; id: string }[]).map((c) => [c.key, c.id]));
  ctx.f1 = (await api().post(`/api/v1/audit-records/${r2.id}/findings`).set(owner).send({ responseId: r2.responses[0], classificationId: classes.major_nc, title: 'Guard missing', description: 'Not fitted', ownerId: ctx.employee, dueOn: day(10) }).expect(201)).body.id;
  expect((await r2.complete()).status).toBe(200);
  await admin.query(`update public.audit_findings set due_on = $2 where id = $1`, [ctx.f1, day(-5)]);
  await api().post(`/api/v1/audit-findings/${ctx.f1}/create-ncr`).set(owner).send({}).expect(200);
  const r3 = await carryOut(ctx.audit, ['pass', 'pass'], day(-3), { targets: [{ kind: 'machine', machineId: m2 }] });
  expect((await r3.complete()).status).toBe(200);
  ctx.f2 = (await api().post(`/api/v1/audit-records/${r3.id}/findings`).set(owner).send({ classificationId: classes.observation, title: 'Tidy the notice board', description: 'Out of date notices' }).expect(201)).body.id;
  await api().post(`/api/v1/audit-findings/${ctx.f2}/close`).set(owner).send({ note: 'Done' }).expect(200);
  // An open finding that is not late, one whose non-conformance was cancelled, and one withdrawn.
  ctx.f3 = (await api().post(`/api/v1/audit-records/${r3.id}/findings`).set(owner).send({ classificationId: classes.minor_nc, title: 'Label worn', description: 'The label is worn', dueOn: day(10) }).expect(201)).body.id;
  await api().post(`/api/v1/audit-findings/${ctx.f3}/create-ncr`).set(owner).send({}).expect(200);
  await admin.query(`update public.nonconformances set stage = 'cancelled', stage_reason = 'Raised in error' where id = (select nonconformance_id from public.audit_ncr_links where finding_id = $1)`, [ctx.f3]);
  ctx.f4 = (await api().post(`/api/v1/audit-records/${r3.id}/findings`).set(owner).send({ classificationId: classes.ofi, title: 'Spare tooling idea', description: 'Keep spares on the cell' }).expect(201)).body.id;
  await api().post(`/api/v1/audit-findings/${ctx.f4}/withdraw`).set(owner).send({ reason: 'Raised in error' }).expect(200);

  // The second audit: one record in the previous period, one long ago, and a change to the template.
  const r4 = await carryOut(ctx.audit2, ['pass'], day(-40), { targets: [{ kind: 'machine', machineId: m3 }] });
  expect((await r4.complete()).status).toBe(200);
  const r5 = await carryOut(ctx.audit2, ['fail'], day(-120), { targets: [{ kind: 'operation', operationCode: 'OP-99' }] });
  expect((await r5.complete()).status).toBe(200);
  // An audit that was started and abandoned counts for nothing: not a completed audit, not coverage.
  const r6 = await carryOut(ctx.audit2, ['pass'], day(-2), { targets: [{ kind: 'machine', machineId: m3 }] });
  await api().post(`/api/v1/audit-records/${r6.id}/abandon`).set(await as(ids.inspectorA)).send({ reason: 'Called away' }).expect(200);
  await api().patch(`/api/v1/audits/${ctx.audit2}`).set(owner).send({ purpose: 'Keep the grinder in shape', changeReason: 'Added a purpose' }).expect(200);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('planned versus done', () => {
  it('counts the slots due in the period by how they stand, with the schedule\'s own rules, and leaves out skipped ones', async () => {
    const d = (await dashboard()).body;
    expect(d.period).toMatchObject({ from: day(-29), to: day(0), previousFrom: day(-59), previousTo: day(-30), bucket: 'week' });
    expect(d.kpis).toMatchObject({ planned: 4, done: 2, doneOnTime: 1, missed: 1, overdue: 1, completionRate: 50, onTimeRate: 33.3 });
  });

  it('spreads them over the weeks of the period', async () => {
    const d = (await dashboard()).body;
    expect(d.planned.length).toBeGreaterThanOrEqual(5);
    expect(d.planned.map((b: { start: string }) => b.start)).toEqual([...d.planned.map((b: { start: string }) => b.start)].sort());
    expect(sum(d.planned, 'done')).toBe(1);
    expect(sum(d.planned, 'late')).toBe(1);
    expect(sum(d.planned, 'missed')).toBe(1);
    expect(sum(d.planned, 'overdue')).toBe(1);
    expect(sum(d.planned, 'upcoming')).toBe(0);
  });

  it('lists the slots that are overdue or missed, latest first', async () => {
    const d = (await dashboard()).body;
    expect(d.slotsNeedingAttention).toMatchObject([
      { auditReference: 'AUD-001', auditTitle: 'Cell audit', dueOn: day(-1), state: 'overdue' },
      { auditReference: 'AUD-001', dueOn: day(-12), state: 'missed' },
    ]);
  });

  it('has no rate where there is nothing to divide, and months for a long period', async () => {
    const empty = (await dashboard(`from=${day(-400)}&to=${day(-380)}`)).body;
    expect(empty.kpis).toMatchObject({ planned: 0, completionRate: null, onTimeRate: null, passRate: null, averageScore: null, completed: 0 });
    expect(empty.period.bucket).toBe('week');
    const year = (await dashboard(`from=${day(-364)}&to=${day(0)}`)).body;
    expect(year.period.bucket).toBe('month');
    expect(year.kpis.completed).toBe(5);
  });
});

describe('results', () => {
  it('counts the audits completed, the pass rate and the average score against the period before', async () => {
    const d = (await dashboard()).body;
    expect(d.kpis).toMatchObject({ completed: 3, completedPrevious: 1, passRate: 66.7, passRatePrevious: 100, averageScore: 83.3 });
    expect(sum(d.results, 'pass')).toBe(2);
    expect(sum(d.results, 'fail')).toBe(1);
  });

  it('lists the latest failed audits', async () => {
    const d = (await dashboard()).body;
    expect(d.failedRecords).toMatchObject([{ id: ctx.r2, auditReference: 'AUD-001', performedOn: day(-14), score: 50, criticalFailed: 1 }]);
  });

  it('names the questions that fail most often, among completed audits in the period', async () => {
    const d = (await dashboard()).body;
    expect(d.failedQuestions).toEqual([{ auditId: ctx.audit, auditReference: 'AUD-001', auditTitle: 'Cell audit', question: 'Guard fitted?', failed: 1, answered: 3, failRate: 33.3 }]);
  });
});

describe('findings', () => {
  it('counts what is open, overdue and raised in the period, and the ones that became a non-conformance', async () => {
    const d = (await dashboard()).body;
    expect(d.kpis).toMatchObject({ openFindings: 2, overdueFindings: 1, findingsRaised: 3, findingsRaisedPrevious: 0, nonconformances: 1 });
    expect(d.findingsByClassification.map((c: { key: string; count: number }) => [c.key, c.count])).toEqual([['major_nc', 1], ['minor_nc', 1], ['observation', 1], ['ofi', 0]]);
    expect(d.findingsByStatus).toEqual([{ key: 'open', label: 'Open', count: 2 }, { key: 'closed', label: 'Closed', count: 1 }, { key: 'withdrawn', label: 'Withdrawn', count: 1 }]);
  });

  it('lists the overdue ones with how late, and who owns them', async () => {
    const d = (await dashboard()).body;
    expect(d.overdueFindings).toMatchObject([{ id: ctx.f1, classification: 'Major non-conformity', dueOn: day(-5), daysOverdue: 5, owner: 'Grace Hopper' }]);
  });

  it('counts a period that does not include today by when the findings were raised, not by what is open now', async () => {
    const d = (await dashboard(`from=${day(-100)}&to=${day(-60)}`)).body;
    expect(d.kpis).toMatchObject({ findingsRaised: 0, nonconformances: 0, openFindings: 2, overdueFindings: 1 });
  });
});

describe('coverage', () => {
  it('shows when each machine, operation and department was last covered, never-covered ones first, then the oldest', async () => {
    const d = (await dashboard()).body;
    expect(d.coverage).toMatchObject({ listed: 6, never: 1, stale: 1, staleAfterDays: 90 });
    expect(d.coverage.items.map((i: { kind: string; label: string; lastAuditedOn: string | null; daysSince: number | null }) => [i.kind, i.label, i.lastAuditedOn, i.daysSince])).toEqual([
      ['department', 'MACH · Machining', null, null],
      ['operation', 'OP-99', day(-120), 120],
      ['machine', 'CNC-3 · Grinder', day(-40), 40],
      ['machine', 'CNC-1 · Lathe', day(-14), 14],
      ['operation', 'OP-10', day(-14), 14],
      ['machine', 'CNC-2 · Mill', day(-3), 3],
    ]);
    expect(d.coverage.items[3].audits).toEqual(['AUD-001']);
  });

  it('does not depend on the period chosen', async () => {
    const d = (await dashboard(`from=${day(-100)}&to=${day(-60)}`)).body;
    expect(d.coverage).toMatchObject({ listed: 6, never: 1, stale: 1 });
  });

  it('leaves out the targets of a retired audit', async () => {
    await api().post(`/api/v1/audits/${ctx.audit2}/retire`).set(await as(ids.ownerA)).send({ reason: 'Replaced' }).expect(200);
    const d = (await dashboard()).body;
    expect(d.coverage).toMatchObject({ listed: 4, never: 1, stale: 0 });
    await api().post(`/api/v1/audits/${ctx.audit2}/reactivate`).set(await as(ids.ownerA)).expect(200);
  });
});

describe('changes to audit templates', () => {
  it('lists the versions saved in the period, with the reason and who', async () => {
    const d = (await dashboard()).body;
    expect(d.kpis.versionsSaved).toBe(1);
    expect(d.recentVersions).toMatchObject([{ auditReference: 'AUD-002', auditTitle: 'Grinding audit', version: 2, reason: 'Added a purpose', by: 'Ada Owner' }]);
  });
});

describe('who may see it, and what it asks for', () => {
  beforeAll(async () => {
    // A viewer who may not read audits.
    await admin.query(`delete from public.role_permissions where permission_code = 'audits.read' and role_id = (select id from public.roles where organisation_id = $1 and key = 'viewer')`, [ids.orgA]);
  });

  it('needs audits.read, an organisation, and a sensible period', async () => {
    expect((await dashboard(undefined, await as(ids.dual))).status).toBe(403);
    expect((await dashboard(undefined, await as(ids.ownerB, ids.orgA))).status).toBe(404);
    expect((await dashboard(undefined, await as(ids.inspectorA))).status).toBe(200);
    expect((await dashboard(`from=${day(0)}&to=${day(-1)}`)).status).toBe(400);
    expect((await dashboard(`from=${day(-2000)}&to=${day(0)}`)).status).toBe(400);
    expect((await dashboard('from=today')).status).toBe(400);
    expect((await api().get('/api/v1/audits-dashboard').set(await as(ids.ownerA))).status).toBe(400);
  });

  it('shows another organisation nothing of this one', async () => {
    const d = (await dashboard(undefined, await as(ids.ownerB, ids.orgB))).body;
    expect(d.kpis).toMatchObject({ planned: 0, completed: 0, openFindings: 0, findingsRaised: 0, versionsSaved: 0 });
    expect(d.coverage).toMatchObject({ listed: 0, never: 0 });
    expect(d.failedQuestions).toEqual([]);
    expect(d.recentVersions).toEqual([]);
  });
});
