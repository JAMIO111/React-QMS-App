/**
 * Audit records through the API (AU3): starting an audit (from a slot or on its own) with a frozen copy of the questions, choosing what it was carried out on, answering,
 * what is still needed, completing with the computed score and result, the schedule's done / in-progress states and rates, the register, abandoning, and the finding a failed critical
 * answer needs (findings: audit-findings.e2e-spec.ts). The rules themselves are in supabase/tests/audit_records.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('b3');
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
type Q = { id: string; sequence: number; question: string; response: null | { id: string; result: string | null; ncrs: unknown[]; finding: unknown } };
const start = async (body: object, h?: Record<string, string>) => api().post('/api/v1/audit-records').set(h ?? (await as(ids.inspectorA))).send(body);
const answer = async (record: string, body: object, h?: Record<string, string>) => api().put(`/api/v1/audit-records/${record}/responses`).set(h ?? (await as(ids.inspectorA))).send(body);
const qid = (record: { questions: Q[] }, seq: number) => record.questions.find((q) => q.sequence === seq)!.id;
const schedule = async (query = '') => (await api().get(`/api/v1/audit-schedule${query}`).set(await as(ids.ownerA)).expect(200)).body;

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-rec');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  ctx.machine = (await api().post('/api/v1/machines').set(h).send({ code: 'CNC-1', name: 'Lathe', siteId: ids.siteA }).expect(201)).body.id;
  ctx.machine2 = (await api().post('/api/v1/machines').set(h).send({ code: 'CNC-2', name: 'Mill', siteId: ids.siteA }).expect(201)).body.id;
  ctx.other = (await api().post('/api/v1/machines').set(await as(ids.ownerB, ids.orgB)).send({ code: 'OTH-1', name: 'Other' }).expect(201)).body.id;
  // A weekly audit with a pass mark of 80 and four questions (one critical, one a number), relevant to two machines and an operation.
  ctx.audit = (
    await api()
      .post('/api/v1/audits')
      .set(h)
      .send({
        title: 'Cell audit',
        auditType: 'layered_process',
        procedure: 'Walk the cell.',
        frequency: { kind: 'weekly', firstDueOn: day(-14) },
        graceDays: 2,
        passMark: 80,
        questions: [
          { question: 'Work instruction at the machine?', answerType: 'yes_no', passAnswer: 'yes', critical: true },
          { question: 'Floor clear?', answerType: 'pass_fail' },
          { question: 'Coolant concentration', answerType: 'numeric', unit: '%', lowerLimit: 6, upperLimit: 10 },
          { question: 'Anything else seen', answerType: 'text' },
        ],
        targets: [{ kind: 'machine', machineId: ctx.machine }, { kind: 'machine', machineId: ctx.machine2 }, { kind: 'operation', operationCode: 'OP-10' }],
      })
      .expect(201)
  ).body.id;
  ctx.free = (await api().post('/api/v1/audits').set(h).send({ title: 'Free audit', auditType: 'other', frequency: { kind: 'on_demand' }, passMark: 50, questions: [{ question: 'Fine?', answerType: 'pass_fail' }] }).expect(201)).body.id;
  await admin.query(`update public.audit_definitions set created_at = now() - interval '60 days' where organisation_id = $1`, [ids.orgA]);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('starting an audit', () => {
  it('copies the audit into a record, from a scheduled slot, and marks the slot in progress', async () => {
    const slot = (await schedule('?auditId=' + ctx.audit)).data.find((i: { dueOn: string }) => i.dueOn === day(-14));
    expect(slot.state).toBe('missed');
    const res = await start({ auditId: ctx.audit, occurrenceId: slot.id });
    expect(res.status).toBe(201);
    ctx.record = res.body.id;
    expect(res.body).toMatchObject({
      reference: expect.stringMatching(/^AR-\d\d-0001$/),
      status: 'in_progress',
      result: null,
      passMark: 80,
      scheduledFor: day(-14),
      audit: { reference: 'AUD-001', title: 'Cell audit' },
      procedure: 'Walk the cell.',
      targetsRequired: true,
      auditor: { name: expect.any(String) },
    });
    expect(res.body.questions.map((q: Q) => q.question)).toEqual(['Work instruction at the machine?', 'Floor clear?', 'Coolant concentration', 'Anything else seen']);
    expect(res.body.availableTargets.map((t: { label: string }) => t.label).sort()).toEqual(['CNC-1 · Lathe', 'CNC-2 · Mill', 'OP-10']);
    expect(res.body.problems.join('|')).toContain('3 questions are not answered');
    expect(res.body.problems.join('|')).toContain('choose which machines');
    const s = await schedule('?auditId=' + ctx.audit);
    const same = s.data.find((i: { id: string }) => i.id === slot.id);
    expect(same).toMatchObject({ state: 'in_progress', record: { id: ctx.record, status: 'in_progress', result: null } });
    expect(s.counts).toMatchObject({ inProgress: 1, done: 0, passRate: null });
    await start({ auditId: ctx.audit, occurrenceId: slot.id }).then((r) => {
      expect(r.status).toBe(409);
      expect(r.body.error).toMatchObject({ code: 'audit_rule', message: expect.stringContaining('already being done') });
    });
  });

  it('needs audits.perform, an audit of this organisation and a body that makes sense', async () => {
    expect((await start({ auditId: ctx.audit }, await as(ids.dual))).status).toBe(403);
    expect((await start({ auditId: ctx.audit }, await as(ids.outsider))).status).toBe(404);
    expect((await start({ auditId: ctx.audit }, await as(ids.ownerB, ids.orgB))).status).toBe(404);
    expect((await start({})).status).toBe(400);
    expect((await start({ auditId: ctx.audit, surprise: 1 })).status).toBe(400);
    expect((await start({ auditId: '00000000-0000-4000-8000-000000000001' })).status).toBe(404);
    expect((await start({ auditId: ctx.audit, occurrenceId: '00000000-0000-4000-8000-000000000001' })).status).toBe(404);
  });
});

describe('carrying it out', () => {
  it('takes the machines it was carried out on from the audit\'s own list, one or several', async () => {
    const put = async (targets: object[], h?: Record<string, string>) => api().put(`/api/v1/audit-records/${ctx.record}/targets`).set(h ?? (await as(ids.inspectorA))).send({ targets });
    expect((await put([{ kind: 'machine', machineId: ctx.other }])).status).toBe(409);
    expect((await put([{ kind: 'operation', operationCode: 'OP-99' }])).status).toBe(409);
    expect((await put([{ kind: 'machine', machineId: ctx.machine }], await as(ids.dual))).status).toBe(403);
    expect((await put([{ kind: 'machine' }])).status).toBe(400);
    const ok = await put([{ kind: 'machine', machineId: ctx.machine }, { kind: 'operation', operationCode: 'op-10' }]);
    expect(ok.status).toBe(200);
    expect(ok.body.targets.map((t: { label: string }) => t.label).sort()).toEqual(['CNC-1 · Lathe', 'OP-10']);
    expect(ok.body.carriedOutOn.sort()).toEqual(['CNC-1 · Lathe', 'OP-10']);
    expect(ok.body.problems.join('|')).not.toContain('choose which machines');
  });

  it('works out each answer and says what is still needed', async () => {
    const rec = (await api().get(`/api/v1/audit-records/${ctx.record}`).set(await as(ids.dual)).expect(200)).body;
    const r1 = await answer(ctx.record, { questionId: qid(rec, 1), answer: 'no' });
    expect(r1.status).toBe(200);
    expect(r1.body.questions[0].response).toMatchObject({ answer: 'no', result: 'fail' });
    expect(r1.body.problems.join('|')).toContain('say what was found for the failed question: 1');
    expect((await answer(ctx.record, { questionId: qid(rec, 1), answer: 'maybe' })).status).toBe(400);
    expect((await answer(ctx.record, { questionId: qid(rec, 2), answer: 'yes' })).status).toBe(409);
    expect((await answer(ctx.record, { questionId: qid(rec, 3) , note: 'x' })).status).toBe(409);
    expect((await answer(ctx.record, { questionId: qid(rec, 1), answer: 'yes' }, await as(ids.dual))).status).toBe(403);
    expect((await answer(ctx.record, { questionId: '00000000-0000-4000-8000-000000000001', answer: 'yes' })).status).toBe(404);
    expect((await answer(ctx.record, { answer: 'yes' })).status).toBe(400);
    const num = await answer(ctx.record, { questionId: qid(rec, 3), value: 10.5 });
    expect(num.body.questions[2].response).toMatchObject({ value: 10.5, result: 'fail' });
    expect((await answer(ctx.record, { questionId: qid(rec, 3), value: 8 })).body.questions[2].response).toMatchObject({ value: 8, result: 'pass' });
    // Clearing an answer removes it.
    expect((await answer(ctx.record, { questionId: qid(rec, 3) })).body.questions[2].response).toBeNull();
    await answer(ctx.record, { questionId: qid(rec, 3), value: 8 });
    await answer(ctx.record, { questionId: qid(rec, 2), answer: 'pass' });
    await answer(ctx.record, { questionId: qid(rec, 4), note: 'Tidy otherwise' });
    const failing = (await api().get(`/api/v1/audit-records/${ctx.record}`).set(await as(ids.inspectorA)).expect(200)).body;
    expect(failing.problems).toEqual(['say what was found for the failed question: 1', 'raise a finding for the failed critical question: 1']);
    const done = await answer(ctx.record, { questionId: qid(rec, 1), answer: 'no', note: 'Instruction missing at the machine' });
    // A failed critical question needs a finding before the audit can be completed.
    expect(done.body.problems).toEqual(['raise a finding for the failed critical question: 1']);
    const minor = (await api().get('/api/v1/audit-finding-classifications').set(await as(ids.inspectorA)).expect(200)).body.data.find((c: { key: string }) => c.key === 'minor_nc');
    const finding = await api()
      .post(`/api/v1/audit-records/${ctx.record}/findings`)
      .set(await as(ids.inspectorA))
      .send({ responseId: done.body.questions.find((q: Q) => q.sequence === 1).response.id, classificationId: minor.id, title: 'Work instruction missing', description: 'No instruction at the machine' })
      .expect(201);
    const covered = await api().get(`/api/v1/audit-records/${ctx.record}`).set(await as(ids.inspectorA)).expect(200);
    expect(covered.body.problems).toEqual([]);
    expect(covered.body.questions.find((q: Q) => q.sequence === 1).response.finding).toMatchObject({ id: finding.body.id, status: 'open', kind: 'nonconformity' });
  });

  it('refuses completion while something is missing, and completes with the score and result', async () => {
    const h = await as(ids.inspectorA);
    const other = (await start({ auditId: ctx.audit })).body.id;
    const early = await api().post(`/api/v1/audit-records/${other}/complete`).set(h);
    expect(early.status).toBe(409);
    expect(early.body.error).toMatchObject({ code: 'audit_rule', message: expect.stringContaining('can be completed') });
    expect((await api().post(`/api/v1/audit-records/${ctx.record}/complete`).set(await as(ids.dual))).status).toBe(403);
    await api().patch(`/api/v1/audit-records/${ctx.record}`).set(h).send({ notes: 'Quiet shift', performedOn: day(-1) }).expect(200);
    expect((await api().patch(`/api/v1/audit-records/${ctx.record}`).set(h).send({ performedOn: day(1) })).status).toBe(409);
    expect((await api().patch(`/api/v1/audit-records/${ctx.record}`).set(h).send({})).status).toBe(400);
    const res = await api().post(`/api/v1/audit-records/${ctx.record}/complete`).set(h);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'completed', result: 'fail', passedCount: 2, failedCount: 1, criticalFailedCount: 1, notes: 'Quiet shift', performedOn: day(-1), problems: [] });
    expect(res.body.completedBy.name).toBeDefined();
    expect(res.body.availableTargets).toEqual([]);
    // The score is passes over answered questions: the number and the floor pass, the instruction fails, the note is not scored: 2 of 3.
    expect(res.body.score).toBeCloseTo(66.67, 2);
    // Frozen.
    const rec = res.body;
    expect((await answer(ctx.record, { questionId: qid(rec, 1), answer: 'yes' })).status).toBe(409);
    expect((await api().post(`/api/v1/audit-records/${ctx.record}/abandon`).set(h).send({ reason: 'oops' })).status).toBe(409);
    ctx.abandon = other;
  });

  it('shows done audits and the rates on the schedule', async () => {
    const s = await schedule('?auditId=' + ctx.audit);
    const slot = s.data.find((i: { dueOn: string }) => i.dueOn === day(-14));
    expect(slot).toMatchObject({ state: 'done', record: { id: ctx.record, status: 'completed', result: 'fail', performedOn: day(-1) } });
    expect(s.counts).toMatchObject({ done: 1, donePassed: 0, doneFailed: 1, passRate: 0, inProgress: 0 });
    // One slot done (a day before its grace ran out: -14 + 2 is -12, done on -1 is late), the others missed: so none in time.
    expect(s.counts.onTimeRate).toBe(0);
    expect((await schedule('?state=done')).data.map((i: { record: { id: string } }) => i.record.id)).toContain(ctx.record);
    const skip = await api().post(`/api/v1/audit-occurrences/${slot.id}/skip`).set(await as(ids.ownerA)).send({ reason: 'x' });
    expect(skip.status).toBe(409);
    expect(skip.body.error.message).toContain('cannot be skipped');
  });
});

describe('passing, abandoning and unscheduled audits', () => {
  it('passes when every critical question passes and the score reaches the pass mark', async () => {
    const res = await start({ auditId: ctx.free });
    expect(res.body).toMatchObject({ scheduledFor: null, targetsRequired: false });
    const q = qid(res.body, 1);
    expect((await answer(res.body.id, { questionId: q, answer: 'pass' })).status).toBe(200);
    const done = await api().post(`/api/v1/audit-records/${res.body.id}/complete`).set(await as(ids.inspectorA)).expect(200);
    expect(done.body).toMatchObject({ result: 'pass', score: 100, status: 'completed' });
    ctx.passed = res.body.id;
  });

  it('can be abandoned with a reason, which frees the slot', async () => {
    const h = await as(ids.inspectorA);
    expect((await api().post(`/api/v1/audit-records/${ctx.abandon}/abandon`).set(h).send({ reason: ' ' })).status).toBe(400);
    expect((await api().post(`/api/v1/audit-records/${ctx.abandon}/abandon`).set(await as(ids.dual)).send({ reason: 'x' })).status).toBe(403);
    const res = await api().post(`/api/v1/audit-records/${ctx.abandon}/abandon`).set(h).send({ reason: 'Started by mistake' }).expect(200);
    expect(res.body).toMatchObject({ status: 'abandoned', abandonReason: 'Started by mistake', result: null });
  });
});

describe('the register', () => {
  const list = async (query = '', h?: Record<string, string>) => (await api().get(`/api/v1/audit-records${query}`).set(h ?? (await as(ids.dual))).expect(200)).body;

  it('lists records with filters, sorting and paging, for anyone who may read audits', async () => {
    const all = await list();
    expect(all.total).toBe(3);
    expect(all.data.map((r: { reference: string }) => r.reference)).toEqual(expect.arrayContaining([expect.stringMatching(/^AR-\d\d-000[1-3]$/)]));
    const first = all.data.find((r: { id: string }) => r.id === ctx.record);
    expect(first).toMatchObject({ result: 'fail', status: 'completed', performedOn: day(-1), scheduledFor: day(-14), carriedOutOn: ['CNC-1 · Lathe', 'OP-10'], audit: { title: 'Cell audit' } });
    expect((await list('?result=pass')).data.map((r: { id: string }) => r.id)).toEqual([ctx.passed]);
    expect((await list('?result=fail')).total).toBe(1);
    expect((await list('?status=abandoned')).total).toBe(1);
    expect((await list('?status=in_progress,completed')).total).toBe(2);
    expect((await list(`?auditId=${ctx.free}`)).total).toBe(1);
    expect((await list(`?machineId=${ctx.machine}`)).data.map((r: { id: string }) => r.id)).toEqual([ctx.record]);
    expect((await list(`?machineId=${ctx.machine2}`)).total).toBe(0);
    expect((await list('?operationCode=op-10')).total).toBe(1);
    expect((await list(`?from=${day(-1)}&to=${day(-1)}`)).data.map((r: { id: string }) => r.id)).toEqual([ctx.record]);
    expect((await list('?q=cell')).total).toBe(2);
    expect((await list('?q=zzz')).total).toBe(0);
    expect((await list('?type=layered_process')).total).toBe(2);
    expect((await list('?mine=true', await as(ids.inspectorA))).total).toBe(3);
    expect((await list('?mine=true', await as(ids.ownerA))).total).toBe(0);
    const sorted = await list('?sort=reference&order=asc&pageSize=2');
    expect(sorted).toMatchObject({ page: 1, pageSize: 2, total: 3 });
    expect(sorted.data.map((r: { reference: string }) => r.reference)).toEqual([...sorted.data.map((r: { reference: string }) => r.reference)].sort());
    expect((await list('?sort=reference&order=asc&pageSize=2&page=2')).data).toHaveLength(1);
    await api().get('/api/v1/audit-records?sort=nope').set(await as(ids.dual)).expect(400);
    await api().get('/api/v1/audit-records?result=maybe').set(await as(ids.dual)).expect(400);
  });

  it('is closed to other organisations', async () => {
    expect((await list('', await as(ids.ownerB, ids.orgB))).total).toBe(0);
    await api().get(`/api/v1/audit-records/${ctx.record}`).set(await as(ids.ownerB, ids.orgB)).expect(404);
    await api().get(`/api/v1/audit-records/${ctx.record}`).set(await as(ids.outsider)).expect(404);
    await api().get('/api/v1/audit-records/not-an-id').set(await as(ids.dual)).expect(400);
  });
});

describe('the rates and who did the audit', () => {
  it('counts a slot done on the last day of its grace period as on time, and one day later as late', async () => {
    const owner = await as(ids.ownerA);
    // Weekly, 2 days' grace, due 9 and 2 days ago: the deadlines were 7 days ago and today.
    const rate = (
      await api().post('/api/v1/audits').set(owner).send({ title: 'Rate audit', auditType: 'process', frequency: { kind: 'weekly', firstDueOn: day(-9) }, graceDays: 2, questions: [{ question: 'Fine?', answerType: 'pass_fail' }] }).expect(201)
    ).body.id;
    await admin.query(`update public.audit_definitions set created_at = now() - interval '60 days' where id = $1`, [rate]);
    // The register works out the next due slot itself (it makes the slots): a slot past due but inside its grace period is still the next one, a missed one is not.
    const listed = async (q: string) => (await api().get(`/api/v1/audits?q=${encodeURIComponent(q)}`).set(owner).expect(200)).body.data[0];
    expect(await listed('Rate audit')).toMatchObject({ nextDueOn: day(-2), lastRecord: null });
    const slots = (await schedule(`?auditId=${rate}`)).data;
    const slot = (due: string) => slots.find((i: { dueOn: string }) => i.dueOn === due);
    expect(slot(day(-9)).state).toBe('missed');
    expect(slot(day(-2)).state).toBe('overdue');

    const doIt = async (slotId: string, performedOn: string, starter: string, finisher: string) => {
      const rec = (await start({ auditId: rate, occurrenceId: slotId }, await as(starter))).body;
      await api().patch(`/api/v1/audit-records/${rec.id}`).set(await as(starter)).send({ performedOn }).expect(200);
      await answer(rec.id, { questionId: qid(rec, 1), answer: 'pass' }, await as(starter));
      return { id: rec.id, done: (await api().post(`/api/v1/audit-records/${rec.id}/complete`).set(await as(finisher))).body };
    };
    // One day late, started by the inspector and completed by the owner.
    const late = await doIt(slot(day(-9)).id, day(-6), ids.inspectorA, ids.ownerA);
    expect(late.done).toMatchObject({ status: 'completed', result: 'pass', score: 100, auditor: { name: 'Ada Owner' }, completedBy: { name: 'Ada Owner' } });
    // On the last day of the grace period.
    const onTime = await doIt(slot(day(-2)).id, day(0), ids.inspectorA, ids.inspectorA);
    expect(onTime.done.auditor.name).toBe('Unnamed person');

    const s = await schedule(`?auditId=${rate}`);
    expect(s.counts).toMatchObject({ done: 2, donePassed: 2, doneFailed: 0, missed: 0, overdue: 0, passRate: 100, onTimeRate: 50 });
    expect(s.data.filter((i: { state: string }) => i.state === 'done').map((i: { record: { performedOn: string } }) => i.record.performedOn)).toEqual([day(-6), day(0)]);
    // Last done is the latest completed audit, next due the slot after the ones done.
    expect(await listed('Rate audit')).toMatchObject({ nextDueOn: day(5), lastRecord: { id: onTime.id, reference: onTime.done.reference, performedOn: day(0), result: 'pass' } });
    expect((await api().get(`/api/v1/audits/${rate}`).set(owner).expect(200)).body).toMatchObject({ nextDueOn: day(5), lastRecord: { id: onTime.id } });
    // An audit done on demand has no next slot but does have a last record; one that is scheduled but not yet done has a next due and no last.
    expect(await listed('Free audit')).toMatchObject({ nextDueOn: null, lastRecord: { id: ctx.passed, result: 'pass' } });
    expect(await listed('Cell audit')).toMatchObject({ nextDueOn: day(0), lastRecord: { id: ctx.record, result: 'fail', performedOn: day(-1) } });
    // A skipped slot, and one that already has an audit started, are not the next one due.
    const stepping = (await api().post('/api/v1/audits').set(owner).send({ title: 'Stepping audit', auditType: 'process', frequency: { kind: 'weekly', firstDueOn: day(0) }, graceDays: 0, questions: [{ question: 'Fine?', answerType: 'pass_fail' }] }).expect(201)).body.id;
    const steps = (await schedule(`?auditId=${stepping}`)).data;
    expect(await listed('Stepping audit')).toMatchObject({ nextDueOn: day(0) });
    await api().post(`/api/v1/audit-occurrences/${steps[0].id}/skip`).set(owner).send({ reason: 'Shutdown' }).expect(200);
    expect(await listed('Stepping audit')).toMatchObject({ nextDueOn: day(7) });
    await start({ auditId: stepping, occurrenceId: steps[1].id }).then((r) => expect(r.status).toBe(201));
    expect(await listed('Stepping audit')).toMatchObject({ nextDueOn: day(14), lastRecord: null });
    // The register shows who completed it, and can be filtered by that person.
    const byOwner = (await api().get(`/api/v1/audit-records?auditId=${rate}&performedBy=${ids.ownerA}`).set(await as(ids.dual)).expect(200)).body;
    expect(byOwner.data.map((r: { id: string }) => r.id)).toEqual([late.id]);
    expect(byOwner.data[0].auditor.name).toBe('Ada Owner');
  });
});

describe('carrying out every response type', () => {
  const QUESTIONS = [
    { question: 'Procedure followed?', answerType: 'yes_no', passAnswer: 'no', critical: true },
    { question: 'Process meets requirements?', answerType: 'compliant' },
    { question: 'Product meets specification?', answerType: 'pass_fail' },
    { question: 'Requirement applicable?', answerType: 'yes_no_na', passAnswer: 'yes' },
    { question: 'Measured temperature', answerType: 'numeric', unit: 'C' },
    { question: 'Describe the observation', answerType: 'text' },
    { question: 'Select applicable condition', answerType: 'multiple_choice', options: [{ label: 'Clean', passes: true }, { label: 'Oily', passes: false }] },
    { question: 'Actual diameter', answerType: 'measurement', nominal: 10, lowerLimit: 9.95, upperLimit: 10.05, unit: 'mm', critical: true },
    { question: 'Upload photograph', answerType: 'evidence' },
    { question: 'Housekeeping score', answerType: 'rating', passRating: 3 },
    { question: 'Overall impression', answerType: 'rating', ratingMax: 7 },
  ];
  const state: { rec?: string; audit?: string; file?: string } = {};
  const upload = (path: string) => admin.query(`insert into storage.objects (bucket_id, name) values ('audit-files', $1)`, [path]);

  it('shows each type as the template set it', async () => {
    state.audit = (await api().post('/api/v1/audits').set(await as(ids.ownerA)).send({ title: 'Every type', auditType: 'process', frequency: { kind: 'on_demand' }, passMark: 50, questions: QUESTIONS }).expect(201)).body.id;
    const res = await start({ auditId: state.audit });
    expect(res.status).toBe(201);
    state.rec = res.body.id;
    const q = (n: number) => res.body.questions[n - 1];
    expect(res.body.questions.map((x: { answerType: string }) => x.answerType)).toEqual(QUESTIONS.map((x) => x.answerType));
    expect(q(7).options).toEqual([{ label: 'Clean', passes: true }, { label: 'Oily', passes: false }]);
    expect(q(8)).toMatchObject({ nominal: 10, lowerLimit: 9.95, upperLimit: 10.05, unit: 'mm' });
    expect(q(10)).toMatchObject({ ratingMax: 5, passRating: 3 });
    expect(q(9)).toMatchObject({ fileCount: 0 });
    // Evidence is needed; everything else that wants an answer is not answered yet.
    expect(res.body.problems.join('|')).toContain('add a photograph or document to question 9');
    expect(res.body.problems.join('|')).toContain('9 questions are not answered');
  });

  it('works out each answer by its type', async () => {
    const rec = (await api().get(`/api/v1/audit-records/${state.rec}`).set(await as(ids.inspectorA)).expect(200)).body;
    const put = async (n: number, body: object) => answer(state.rec!, { questionId: qid(rec, n), ...body });
    const result = (r: { body: { questions: Q[] } }, n: number) => r.body.questions[n - 1].response?.result ?? null;
    expect(result(await put(1, { answer: 'yes' }), 1)).toBe('fail');
    expect((await put(1, { answer: 'na' })).status).toBe(409);
    expect(result(await put(2, { answer: 'compliant' }), 2)).toBe('pass');
    expect(result(await put(2, { answer: 'non_compliant' }), 2)).toBe('fail');
    expect(result(await put(2, { answer: 'compliant' }), 2)).toBe('pass');
    expect((await put(2, { answer: 'pass' })).status).toBe(409);
    expect(result(await put(3, { answer: 'pass' }), 3)).toBe('pass');
    expect((await put(3, { answer: 'na' })).status).toBe(409);
    expect(result(await put(4, { answer: 'na' }), 4)).toBe('na');
    const numeric = await put(5, { value: 21 });
    expect(numeric.body.questions[4].response).toMatchObject({ value: 21, result: null });
    expect((await put(6, { note: 'Tidy' })).status).toBe(200);
    const choice = await put(7, { choice: ' oily ' });
    expect(choice.body.questions[6].response).toMatchObject({ choice: 'Oily', result: 'fail' });
    expect((await put(7, { choice: 'Wet' })).status).toBe(409);
    expect(result(await put(7, { choice: 'clean' }), 7)).toBe('pass');
    expect(result(await put(8, { value: 10.05 }), 8)).toBe('pass');
    expect(result(await put(8, { value: 10.06 }), 8)).toBe('fail');
    expect((await put(10, { value: 6 })).status).toBe(409);
    expect((await put(10, { value: 2.5 })).status).toBe(409);
    expect((await put(11, { value: 8 })).status).toBe(409);
    expect(result(await put(10, { value: 2 }), 10)).toBe('fail');
    expect(result(await put(11, { value: 7 }), 11)).toBeNull();
    expect((await put(9, { answer: 'pass' })).status).toBe(409);
  });

  it('takes evidence as files, which can be removed with a reason and put back, and which completing needs', async () => {
    const rec = (await api().get(`/api/v1/audit-records/${state.rec}`).set(await as(ids.inspectorA)).expect(200)).body;
    const inspector = await as(ids.inspectorA);
    const folder = `${ids.orgA}/audit/${state.rec}/`;
    const path = `${folder}u1-photo.jpg`;
    const post = async (body: object, h?: Record<string, string>) => api().post(`/api/v1/audit-records/${state.rec}/attachments`).set(h ?? inspector).send(body);
    const body = { questionId: qid(rec, 9), storagePath: path, fileName: 'photo.jpg', contentType: 'image/jpeg', sizeBytes: 1000 };
    expect((await post(body)).status).toBe(400); // not uploaded yet
    await upload(path);
    expect((await post({ ...body, storagePath: `${ids.orgA}/audit/${ids.orgA}/x.jpg` })).status).toBe(400); // another folder
    expect((await post({ ...body, questionId: qid(rec, 3) })).status).toBe(409); // not an evidence question
    expect((await post(body, await as(ids.dual))).status).toBe(403);
    const added = await post(body);
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ questionId: qid(rec, 9), fileName: 'photo.jpg', sizeBytes: 1000, storagePath: path, deletedAt: null });
    state.file = added.body.id;
    const list = (await api().get(`/api/v1/audit-records/${state.rec}/attachments`).set(await as(ids.dual)).expect(200)).body.data;
    expect(list.map((f: { id: string }) => f.id)).toEqual([state.file]);
    expect((await api().get(`/api/v1/audit-records/${state.rec}`).set(inspector).expect(200)).body.questions[8].fileCount).toBe(1);
    expect((await api().get(`/api/v1/audit-records/${state.rec}?x=1`).set(inspector).expect(200)).body.problems.join('|')).not.toContain('photograph');

    await api().post(`/api/v1/audit-attachments/${state.file}/delete`).set(inspector).send({ reason: 'x' }).expect(400);
    await api().post(`/api/v1/audit-attachments/${state.file}/delete`).set(await as(ids.dual)).send({ reason: 'Wrong photo' }).expect(403);
    const removed = (await api().post(`/api/v1/audit-attachments/${state.file}/delete`).set(inspector).send({ reason: 'Wrong photo' }).expect(200)).body;
    expect(removed).toMatchObject({ deleteReason: 'Wrong photo', deletedAt: expect.any(String) });
    expect((await api().get(`/api/v1/audit-records/${state.rec}/attachments`).set(inspector).expect(200)).body.data).toHaveLength(0);
    expect((await api().get(`/api/v1/audit-records/${state.rec}/attachments?deleted=include&questionId=${qid(rec, 9)}`).set(inspector).expect(200)).body.data).toHaveLength(1);
    expect((await api().get(`/api/v1/audit-records/${state.rec}`).set(inspector).expect(200)).body.problems.join('|')).toContain('add a photograph or document to question 9');
    await api().post(`/api/v1/audit-attachments/${state.file}/delete`).set(inspector).send({ reason: 'again again' }).expect(409);
    await api().post(`/api/v1/audit-attachments/${state.file}/restore`).set(await as(ids.ownerB, ids.orgB)).expect(404);
    await api().post(`/api/v1/audit-attachments/${state.file}/restore`).set(inspector).expect(200);
    expect((await api().get(`/api/v1/audit-records/${state.rec}`).set(inspector).expect(200)).body.problems.join('|')).not.toContain('photograph');
  });

  it('scores only what can fail, and completes', async () => {
    const inspector = await as(ids.inspectorA);
    const rec = (await api().get(`/api/v1/audit-records/${state.rec}`).set(inspector).expect(200)).body;
    // Failures need their words: questions 1, 7 (an option answers it, so the choice is sent again), 8 and 10.
    expect(rec.problems.join('|')).toContain('say what was found for the failed questions: 1, 8, 10');
    expect((await api().post(`/api/v1/audit-records/${state.rec}/complete`).set(inspector)).status).toBe(409);
    await answer(state.rec!, { questionId: qid(rec, 1), answer: 'yes', note: 'Followed the wrong one' }, inspector);
    await answer(state.rec!, { questionId: qid(rec, 8), value: 10.06, note: 'Oversize' }, inspector);
    await answer(state.rec!, { questionId: qid(rec, 10), value: 2, note: 'Poor' }, inspector);
    // The two failed critical questions (1 and 8) each need a finding; the rule is "a failed critical answer needs a live finding".
    const answered = (await api().get(`/api/v1/audit-records/${state.rec}`).set(inspector).expect(200)).body;
    expect(answered.problems.join('|')).toContain('raise a finding for the failed critical questions: 1, 8');
    expect((await api().post(`/api/v1/audit-records/${state.rec}/complete`).set(inspector)).status).toBe(409);
    const major = (await api().get('/api/v1/audit-finding-classifications').set(inspector).expect(200)).body.data.find((c: { key: string }) => c.key === 'major_nc');
    for (const seq of [1, 8]) {
      await api()
        .post(`/api/v1/audit-records/${state.rec}/findings`)
        .set(inspector)
        .send({ responseId: answered.questions.find((q: Q) => q.sequence === seq).response.id, classificationId: major.id, title: `Critical question ${seq}`, description: 'Found by the audit' })
        .expect(201);
    }
    const done = await api().post(`/api/v1/audit-records/${state.rec}/complete`).set(inspector);
    expect(done.status).toBe(200);
    // Scored: 1 fail (critical), 2 pass, 3 pass, 7 pass (clean), 8 fail (critical), 10 fail = 3 pass, 3 fail; N/A (4) left out; numeric without a limit, note, evidence and the unscored rating are not scored.
    expect(done.body).toMatchObject({ status: 'completed', result: 'fail', passedCount: 3, failedCount: 3, naCount: 1, criticalFailedCount: 2, score: 50 });
    await upload(`${ids.orgA}/audit/${state.rec}/late.jpg`);
    expect((await api().post(`/api/v1/audit-records/${state.rec}/attachments`).set(inspector).send({ questionId: qid(rec, 9), storagePath: `${ids.orgA}/audit/${state.rec}/late.jpg`, fileName: 'late.jpg', sizeBytes: 1 })).status).toBe(409);
    await api().post(`/api/v1/audit-attachments/${state.file}/delete`).set(inspector).send({ reason: 'Too late now' }).expect(409);
    expect((await api().get(`/api/v1/audit-records/${state.rec}/attachments`).set(await as(ids.dual)).expect(200)).body.data).toHaveLength(1);
  });
});
