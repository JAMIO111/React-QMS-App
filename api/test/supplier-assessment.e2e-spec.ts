/**
 * Supplier quality SQ2c through the API: assessment templates (versions), assessments scored by the database and frozen, and approval decisions proposed by one person and decided by
 * another (preparer is never the approver), including that a direct move to approved is refused.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('f9');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const owner = () => as(ids.ownerA);
const reader = () => as(ids.inspectorA);
const other = () => as(ids.ownerB, ids.orgB);
const qmId = ids.ownerA.replace(/a1$/, 'a4');
const engId = ids.ownerA.replace(/a1$/, 'a5');
const manager = () => as(qmId);
const engineer = () => as(engId);
const ctx: Record<string, string> = {};
const base = '/api/v1/supplier-quality';

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-sqa');
  for (const [user, role] of [[qmId, 'quality_manager'], [engId, 'quality_engineer']] as const) {
    await admin.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [user, `${role}@example.test`]);
    const mem = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status) values ($1, $2, 'active') returning id`, [ids.orgA, user]);
    await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = $3`, [ids.orgA, mem.rows[0].id, role]);
  }
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await owner();
  for (const [key, code, name] of [['s1', 'ACME', 'Acme Metals'], ['s2', 'BOLT', 'Bolt Co']]) {
    ctx[key] = (await api().post(`${base}/suppliers`).set(h).send({ code, name }).expect(201)).body.id;
  }
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const Q = (over: Record<string, unknown> = {}) => ({ key: 'qms', section: 'Quality', text: 'Is there a certified quality system?', answerType: 'yes_no', weight: 5, critical: true, evidenceRequired: false, ...over });
const RATE = { key: 'delivery', section: 'Supply', text: 'How reliable is delivery?', answerType: 'rating', weight: 5, critical: false, evidenceRequired: false, passRating: 3 };

describe('templates', () => {
  it('every organisation starts with a default template', async () => {
    const list = (await api().get(`${base}/assessment-templates`).set(await reader()).expect(200)).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Supplier qualification questionnaire', active: true, version: 1, passMark: 75 });
    expect(list[0].questions).toHaveLength(11);
    expect(list[0].questions.find((q: { key: string }) => q.key === 'calibration')).toMatchObject({ answerType: 'yes_no', critical: true, weight: 4 });
    expect(list[0].versions).toHaveLength(1);
    ctx.defaultTemplate = list[0].id;
    ctx.defaultVersion = list[0].versionId;
  });

  it('are created, versioned, renamed and switched off by people who may configure', async () => {
    await api().post(`${base}/assessment-templates`).set(await engineer()).send({ name: 'Nope', questions: [Q()], passMark: 70 }).expect(403);
    const h = await owner();
    await api().post(`${base}/assessment-templates`).set(h).send({ name: '', questions: [Q()], passMark: 70 }).expect(400);
    await api().post(`${base}/assessment-templates`).set(h).send({ name: 'Bad', questions: [Q({ answerType: 'maybe' })], passMark: 70 }).expect(400);
    await api().post(`${base}/assessment-templates`).set(h).send({ name: 'Bad', questions: [Q({ key: 'Bad Key' })], passMark: 70 }).expect(400);
    expect((await api().post(`${base}/assessment-templates`).set(h).send({ name: 'Notes', questions: [Q({ answerType: 'text', critical: false })], passMark: 70 })).status).toBe(409); // nothing scored
    expect((await api().post(`${base}/assessment-templates`).set(h).send({ name: 'supplier QUALIFICATION questionnaire', questions: [Q()], passMark: 70 })).status).toBe(409); // name taken
    const t = (await api().post(`${base}/assessment-templates`).set(h).send({ name: 'Quick check', description: 'Two questions', questions: [Q(), RATE], passMark: 60 }).expect(201)).body;
    ctx.quick = t.id;
    ctx.quickV1 = t.versionId;
    expect(t).toMatchObject({ name: 'Quick check', version: 1, passMark: 60, active: true });
    expect((await api().post(`${base}/assessment-templates/${t.id}/versions`).set(h).send({ questions: [Q(), RATE], passMark: 60, reason: 'No change' })).status).toBe(409);
    await api().post(`${base}/assessment-templates/${t.id}/versions`).set(h).send({ questions: [Q(), RATE], passMark: 70, reason: '' }).expect(400);
    const v2 = (await api().post(`${base}/assessment-templates/${t.id}/versions`).set(h).send({ questions: [Q(), RATE], passMark: 70, reason: 'Raised the bar' }).expect(201)).body;
    expect(v2).toMatchObject({ version: 2, passMark: 70 });
    expect(v2.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    ctx.quickV2 = v2.versionId;
    const renamed = (await api().patch(`${base}/assessment-templates/${t.id}`).set(h).send({ name: 'Quick questionnaire', active: false }).expect(200)).body;
    expect(renamed).toMatchObject({ name: 'Quick questionnaire', active: false });
    await api().patch(`${base}/assessment-templates/${t.id}`).set(h).send({}).expect(400);
    await api().patch(`${base}/assessment-templates/${t.id}`).set(h).send({ active: true }).expect(200);
  });
});

describe('assessments', () => {
  it('start frozen, take answers the database scores, and show what is still needed', async () => {
    const h = await engineer();
    await api().post(`${base}/suppliers/${ctx.s1}/assessments`).set(await reader()).send({ templateVersionId: ctx.quickV2 }).expect(403);
    expect((await api().post(`${base}/suppliers/${ctx.s1}/assessments`).set(h).send({ templateVersionId: ctx.quickV1 })).status).toBe(409); // not the current version
    const a = (await api().post(`${base}/suppliers/${ctx.s1}/assessments`).set(h).send({ templateVersionId: ctx.quickV2 }).expect(201)).body;
    ctx.a1 = a.id;
    expect(a).toMatchObject({ status: 'in_progress', templateName: 'Quick questionnaire', templateVersion: 2, passMark: 70, supplier: { code: 'ACME' } });
    expect(a.reference).toMatch(/^SA-\d{2}-\d{4}$/);
    expect(a.progress).toMatchObject({ scored: 2, answered: 0, score: null, result: null });
    expect(a.progress.problems).toHaveLength(2);
    expect((await api().post(`${base}/suppliers/${ctx.s1}/assessments`).set(h).send({ templateVersionId: ctx.quickV2 })).status).toBe(409); // one at a time
    const put = (body: Record<string, unknown>) => api().put(`${base}/supplier-assessments/${ctx.a1}/responses`).set(h).send(body);
    expect((await put({ questionKey: 'qms', answer: 'maybe' })).status).toBe(400);
    expect((await put({ questionKey: 'qms', answer: null, rating: 3 })).status).toBe(409);
    expect((await put({ questionKey: 'nonsense', answer: 'yes' })).status).toBe(409);
    expect((await put({ questionKey: 'delivery', rating: 7 })).status).toBe(400);
    const r1 = (await put({ questionKey: 'qms', answer: 'no', note: 'Not certified' }).expect(200)).body;
    expect(r1.questions[0].response).toMatchObject({ answer: 'no', result: 'fail', note: 'Not certified' });
    const r2 = (await put({ questionKey: 'delivery', rating: 4 }).expect(200)).body;
    expect(r2.questions[1].response).toMatchObject({ rating: 4, result: 'pass' });
    // qms is critical (5) and failed; delivery 4/5 => (5*0.75)/(10) = 37.5
    expect(r2.progress).toMatchObject({ scored: 2, answered: 2, problems: [], score: 37.5, criticalFailures: 1, result: 'fail' });
    const done = (await api().post(`${base}/supplier-assessments/${ctx.a1}/complete`).set(h).send({ summary: 'Not certified' }).expect(200)).body;
    expect(done).toMatchObject({ status: 'completed', score: 37.5, result: 'fail', criticalFailures: 1, summary: 'Not certified', completedBy: { id: engId } });
    expect((await put({ questionKey: 'qms', answer: 'yes' })).status).toBe(409); // frozen
    expect((await api().post(`${base}/supplier-assessments/${ctx.a1}/abandon`).set(h).send({ reason: 'Too late now' })).status).toBe(409);
  });

  it('cannot be completed with problems, and a changed template does not touch a running assessment', async () => {
    const h = await engineer();
    const a = (await api().post(`${base}/suppliers/${ctx.s1}/assessments`).set(h).send({ templateVersionId: ctx.quickV2 }).expect(201)).body;
    ctx.a2 = a.id;
    const bad = await api().post(`${base}/supplier-assessments/${a.id}/complete`).set(h).send({});
    expect(bad.status).toBe(409);
    expect(bad.body.error.message).toContain('not complete');
    await api().put(`${base}/supplier-assessments/${a.id}/responses`).set(h).send({ questionKey: 'qms', answer: 'yes' }).expect(200);
    await api().put(`${base}/supplier-assessments/${a.id}/responses`).set(h).send({ questionKey: 'delivery', rating: 5 }).expect(200);
    // The template moves on while this assessment is open: it keeps the questions it started with.
    await api().post(`${base}/assessment-templates/${ctx.quick}/versions`).set(await owner()).send({ questions: [Q({ text: 'Reworded question' }), RATE], passMark: 90, reason: 'Reworded' }).expect(201);
    const same = (await api().get(`${base}/supplier-assessments/${a.id}`).set(h).expect(200)).body;
    expect(same.templateVersion).toBe(2);
    expect(same.passMark).toBe(70);
    expect(same.questions[0].text).toBe('Is there a certified quality system?');
    const pass = (await api().post(`${base}/supplier-assessments/${a.id}/complete`).set(h).send({}).expect(200)).body;
    expect(pass).toMatchObject({ score: 100, result: 'pass', criticalFailures: 0 });
    const list = (await api().get(`${base}/suppliers/${ctx.s1}/assessments`).set(await reader()).expect(200)).body.data;
    expect(list.map((x: { status: string }) => x.status)).toEqual(['completed', 'completed']);
    expect(list.map((x: { id: string }) => x.id).sort()).toEqual([ctx.a1, ctx.a2].sort());
  });

  it('is abandoned with a reason and kept', async () => {
    const h = await engineer();
    const a = (await api().post(`${base}/suppliers/${ctx.s2}/assessments`).set(h).send({ templateVersionId: ctx.defaultVersion }).expect(201)).body;
    await api().post(`${base}/supplier-assessments/${a.id}/abandon`).set(h).send({ reason: 'x' }).expect(400);
    const gone = (await api().post(`${base}/supplier-assessments/${a.id}/abandon`).set(h).send({ reason: 'Started against the wrong supplier' }).expect(200)).body;
    expect(gone).toMatchObject({ status: 'abandoned', abandonReason: 'Started against the wrong supplier' });
  });
});

describe('approval decisions', () => {
  it('refuse a direct approval, even from an owner', async () => {
    const r = await api().post(`${base}/suppliers/${ctx.s1}/status`).set(await owner()).send({ status: 'approved', reason: 'I will just approve it' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('supplier_rule');
  });

  it('are proposed with a passing assessment by one person and decided by another', async () => {
    const eng = await engineer();
    const url = `${base}/suppliers/${ctx.s1}/approval-decisions`;
    await api().post(url).set(await reader()).send({ target: 'approved', rationale: 'Viewer says', assessmentId: ctx.a2 }).expect(403);
    expect((await api().post(url).set(eng).send({ target: 'approved', rationale: 'No assessment' })).status).toBe(409); // needs an assessment or an exception
    expect((await api().post(url).set(eng).send({ target: 'approved', rationale: 'Failed one', assessmentId: ctx.a1 })).status).toBe(409); // the assessment failed
    expect((await api().post(url).set(eng).send({ target: 'approved', rationale: 'Failed one', assessmentId: ctx.a1, exceptionReason: 'short' })).status).toBe(409);
    expect((await api().post(url).set(eng).send({ target: 'conditional', rationale: 'No conditions', assessmentId: ctx.a2 })).status).toBe(409);
    await api().post(url).set(eng).send({ target: 'suspended', rationale: 'Not a decision' }).expect(400);
    await api().post(url).set(eng).send({ target: 'approved', rationale: 'Extra', assessmentId: ctx.a2, status: 'approved' }).expect(400);
    const d = (await api().post(url).set(eng).send({ target: 'approved', rationale: 'Passed the qualification assessment', assessmentId: ctx.a2, reviewOn: '2999-01-01' }).expect(201)).body;
    ctx.d1 = d.id;
    expect(d).toMatchObject({ status: 'proposed', fromStatus: 'pending_approval', target: 'approved', exceptionReason: null, proposedBy: { id: engId }, canDecide: false, assessment: { id: ctx.a2, result: 'pass', score: 100 } });
    expect((await api().post(url).set(eng).send({ target: 'approved', rationale: 'Second', assessmentId: ctx.a2 })).status).toBe(409);
    expect((await api().get(`${base}/suppliers/${ctx.s1}`).set(eng).expect(200)).body.approvalStatus).toBe('pending_approval');
    // The engineer has no approve right; a reader neither.
    await api().post(`${base}/supplier-approval-decisions/${d.id}/decide`).set(eng).send({ approve: true, note: 'I propose, I approve' }).expect(403);
    const mine = (await api().get(url).set(await manager()).expect(200)).body.data[0];
    expect(mine.canDecide).toBe(true);
    await api().post(`${base}/supplier-approval-decisions/${d.id}/decide`).set(await manager()).send({ approve: true, note: '' }).expect(400);
    const decided = (await api().post(`${base}/supplier-approval-decisions/${d.id}/decide`).set(await manager()).send({ approve: true, note: 'Assessment and certificates reviewed' }).expect(200)).body;
    expect(decided).toMatchObject({ status: 'approved', decidedBy: { id: qmId }, decisionNote: 'Assessment and certificates reviewed', canDecide: false });
    const s = (await api().get(`${base}/suppliers/${ctx.s1}`).set(await owner()).expect(200)).body;
    expect(s.approvalStatus).toBe('approved');
    const hist = (await api().get(`${base}/suppliers/${ctx.s1}/history`).set(await owner()).expect(200)).body.data;
    expect(hist[0]).toMatchObject({ toStatus: 'approved', reason: 'Passed the qualification assessment', reviewOn: '2999-01-01' });
    expect((await api().post(`${base}/supplier-approval-decisions/${d.id}/decide`).set(await manager()).send({ approve: true, note: 'Again' })).status).toBe(409);
  });

  it('never let the preparer approve their own proposal; a rejection changes nothing; a proposal can be withdrawn', async () => {
    await api().post(`${base}/suppliers/${ctx.s1}/status`).set(await owner()).send({ status: 'suspended', reason: 'Late deliveries' }).expect(200); // protective moves stay direct
    const own = (await api().post(`${base}/suppliers/${ctx.s1}/approval-decisions`).set(await owner()).send({ target: 'conditional', rationale: 'Reinstate with checks', assessmentId: ctx.a2, conditions: 'Inspect every delivery' }).expect(201)).body;
    const self = await api().post(`${base}/supplier-approval-decisions/${own.id}/decide`).set(await owner()).send({ approve: true, note: 'Approving my own proposal' });
    expect(self.status).toBe(409);
    expect(self.body.error.message).toContain('someone else');
    const rej = (await api().post(`${base}/supplier-approval-decisions/${own.id}/decide`).set(await manager()).send({ approve: false, note: 'Not enough evidence yet' }).expect(200)).body;
    expect(rej.status).toBe('rejected');
    expect((await api().get(`${base}/suppliers/${ctx.s1}`).set(await owner()).expect(200)).body.approvalStatus).toBe('suspended');
    const again = (await api().post(`${base}/suppliers/${ctx.s1}/approval-decisions`).set(await engineer()).send({ target: 'approved', rationale: 'Sole source for a legacy part', exceptionReason: 'Sole source, corrective action in progress' }).expect(201)).body;
    expect(again).toMatchObject({ exceptionReason: 'Sole source, corrective action in progress', assessment: null });
    await api().post(`${base}/supplier-approval-decisions/${again.id}/withdraw`).set(await reader()).send({ reason: 'Reader withdraws' }).expect(403);
    const w = (await api().post(`${base}/supplier-approval-decisions/${again.id}/withdraw`).set(await engineer()).send({ reason: 'Waiting for the corrective action' }).expect(200)).body;
    expect(w).toMatchObject({ status: 'withdrawn', decisionNote: 'Waiting for the corrective action' });
    const all = (await api().get(`${base}/suppliers/${ctx.s1}/approval-decisions`).set(await reader()).expect(200)).body.data;
    expect(all.map((x: { status: string }) => x.status)).toEqual(['withdrawn', 'rejected', 'approved']);
  });
});

describe('isolation', () => {
  it('another organisation sees and changes nothing, and has its own default template', async () => {
    const o = await other();
    await api().get(`${base}/suppliers/${ctx.s1}/assessments`).set(o).expect(404);
    await api().get(`${base}/supplier-assessments/${ctx.a1}`).set(o).expect(404);
    await api().post(`${base}/suppliers/${ctx.s1}/assessments`).set(o).send({ templateVersionId: ctx.defaultVersion }).expect(404);
    await api().post(`${base}/suppliers/${ctx.s1}/approval-decisions`).set(o).send({ target: 'approved', rationale: 'Hijacked' }).expect(404);
    await api().post(`${base}/supplier-approval-decisions/${ctx.d1}/decide`).set(o).send({ approve: true, note: 'Hijacked' }).expect(404);
    await api().post(`${base}/assessment-templates/${ctx.defaultTemplate}/versions`).set(o).send({ questions: [Q()], passMark: 70, reason: 'Hijacked' }).expect(404);
    const theirs = (await api().get(`${base}/assessment-templates`).set(o).expect(200)).body.data;
    expect(theirs).toHaveLength(1);
    expect(theirs[0].id).not.toBe(ctx.defaultTemplate);
  });
});
