/**
 * Risk register (RK1) through the API: the matrix and its versions, the score preview, categories, raising, editing, assessing, retiring, the register's
 * filters, permissions and tenancy. The rules are in supabase/tests/risk_register_core.test.sql; this checks the routes and that errors reach the caller in words.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { categoryId, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a1c');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-rk');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('the matrix', () => {
  it('gives the seeded matrix and scores a cell without saving anything', async () => {
    const h = await as(ids.inspectorA);
    const model = await api().get('/api/v1/risk-model').set(h).expect(200);
    expect(model.body).toMatchObject({ version: 1, current: true, canChange: false, config: { acceptanceBand: 'medium' } });
    expect(model.body.config.likelihood).toHaveLength(5);
    expect(model.body.config.bands[4][4]).toBe('critical');
    const score = await api().get('/api/v1/risk-score?likelihood=4&consequence=4').set(h).expect(200);
    expect(score.body).toMatchObject({ score: 16, band: 'high', acceptable: false, likelihoodLabel: 'Likely', consequenceLabel: 'Major', modelVersion: 1 });
    await api().get('/api/v1/risk-score?likelihood=6&consequence=1').set(h).expect(400);
  });

  it('saves a new version with a reason (approvers only)', async () => {
    const owner = await as(ids.ownerA);
    const model = (await api().get('/api/v1/risk-model').set(owner).expect(200)).body;
    expect(model.canChange).toBe(true);
    const config = { ...model.config, acceptanceBand: 'low' };
    await api().put('/api/v1/risk-model').set(await as(ids.inspectorA)).send({ config, reason: 'Not mine' }).expect(403);
    await api().put('/api/v1/risk-model').set(owner).send({ config }).expect(400);
    const same = await api().put('/api/v1/risk-model').set(owner).send({ config: model.config, reason: 'No change' }).expect(409);
    expect(same.body.error).toMatchObject({ code: 'risk_rule', message: 'Nothing has changed in the matrix' });
    const saved = await api().put('/api/v1/risk-model').set(owner).send({ config, reason: 'Stricter acceptance' }).expect(200);
    expect(saved.body).toMatchObject({ version: 2, reason: 'Stricter acceptance', config: { acceptanceBand: 'low' } });
    expect(saved.body.versions.map((v: { version: number; current: boolean }) => [v.version, v.current])).toEqual([[2, true], [1, false]]);
    expect((await api().get('/api/v1/risk-score?likelihood=3&consequence=3').set(owner).expect(200)).body).toMatchObject({ band: 'medium', acceptable: false, modelVersion: 2 });
  });
});

describe('categories', () => {
  it('lists the seeded ones, adds, renames and switches off', async () => {
    const h = await as(ids.ownerA);
    const list = await api().get('/api/v1/risk-categories').set(h).expect(200);
    expect(list.body.data).toHaveLength(10);
    ctx.process = list.body.data.find((c: { key: string }) => c.key === 'process').id;
    ctx.other = list.body.data.find((c: { key: string }) => c.key === 'other').id;
    await api().post('/api/v1/risk-categories').set(await as(ids.inspectorA)).send({ label: 'Tooling' }).expect(403);
    const made = await api().post('/api/v1/risk-categories').set(h).send({ label: 'Tooling' }).expect(201);
    expect(made.body).toMatchObject({ key: 'tooling', label: 'Tooling', active: true, risks: 0 });
    await api().post('/api/v1/risk-categories').set(h).send({ label: 'tooling' }).expect(409);
    const off = await api().patch(`/api/v1/risk-categories/${made.body.id}`).set(h).send({ label: 'Tools and fixtures', active: false }).expect(200);
    expect(off.body).toMatchObject({ key: 'tooling', label: 'Tools and fixtures', active: false });
    expect((await api().get('/api/v1/risk-categories').set(h).expect(200)).body.data).toHaveLength(10);
    expect((await api().get('/api/v1/risk-categories?all=true').set(h).expect(200)).body.data).toHaveLength(11);
    ctx.off = made.body.id;
  });
});

describe('risks', () => {
  it('raises a draft, numbered, owned by whoever raised it', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/risks').set(await as(ids.inspectorA)).send({ categoryId: ctx.process, title: 'Not allowed' }).expect(403);
    await api().post('/api/v1/risks').set(h).send({ categoryId: ctx.process }).expect(400);
    const off = await api().post('/api/v1/risks').set(h).send({ categoryId: ctx.off, title: 'Switched off' }).expect(409);
    expect(off.body.error.message).toMatch(/active category/);
    const made = await api().post('/api/v1/risks').set(h).send({ categoryId: ctx.process, title: 'Single source for castings', cause: 'One approved foundry', effect: 'Line stop', siteId: ids.siteA }).expect(201);
    expect(made.body).toMatchObject({
      reference: 'RSK-001', kind: 'risk', status: 'draft', title: 'Single source for castings', category: { id: ctx.process, label: 'Process' },
      owner: { id: ids.ownerA, name: 'Ada Owner' }, site: { id: ids.siteA }, inherent: null, assessments: [], canManage: true, canEdit: true,
    });
    ctx.risk = made.body.id;
    const second = await api().post('/api/v1/risks').set(h).send({ kind: 'opportunity', categoryId: ctx.other, title: 'Second CMM shift', ownerId: ids.inspectorA }).expect(201);
    expect(second.body).toMatchObject({ reference: 'RSK-002', kind: 'opportunity', owner: { id: ids.inspectorA } });
    ctx.opportunity = second.body.id;
    const outsider = await api().post('/api/v1/risks').set(h).send({ categoryId: ctx.process, title: 'x', ownerId: ids.ownerB }).expect(409);
    expect(outsider.body.error.message).toMatch(/active member/);
  });

  it('assesses: the database scores it, the first assessment opens it, a second supersedes', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/risks/${ctx.risk}/assessments`).set(h).send({ likelihood: 4, consequence: 4 }).expect(400);
    await api().post(`/api/v1/risks/${ctx.risk}/assessments`).set(await as(ids.inspectorA)).send({ likelihood: 1, consequence: 1, rationale: 'Not mine' }).expect(403);
    const first = await api().post(`/api/v1/risks/${ctx.risk}/assessments`).set(h).send({ likelihood: 4, consequence: 4, rationale: 'Two stoppages last year' }).expect(200);
    expect(first.body).toMatchObject({ status: 'open', inherent: { likelihood: 4, consequence: 4, score: 16, band: 'high', modelVersion: 2 } });
    const second = await api().post(`/api/v1/risks/${ctx.risk}/assessments`).set(h).send({ likelihood: 2, consequence: 4, rationale: 'Second foundry on trial' }).expect(200);
    expect(second.body.inherent).toMatchObject({ score: 8, band: 'medium' });
    expect(second.body.assessments).toMatchObject([
      { score: 8, current: true, rationale: 'Second foundry on trial', likelihoodLabel: 'Unlikely', consequenceLabel: 'Major', assessedBy: 'Ada Owner' },
      { score: 16, current: false },
    ]);
    const fixed = await api().patch(`/api/v1/risks/${ctx.risk}`).set(h).send({ kind: 'opportunity' }).expect(409);
    expect(fixed.body.error.code).toBe('risk_rule');
    const edited = await api().patch(`/api/v1/risks/${ctx.risk}`).set(h).send({ title: 'Single source for castings (EU)', effect: '' }).expect(200);
    expect(edited.body).toMatchObject({ title: 'Single source for castings (EU)', effect: null, cause: 'One approved foundry' });
  });

  it('filters and sorts the register', async () => {
    const h = await as(ids.inspectorA);
    const all = await api().get('/api/v1/risks').set(h).expect(200);
    expect(all.body).toMatchObject({ total: 2, page: 1 });
    expect(all.body.data.map((r: { reference: string }) => r.reference)).toEqual(['RSK-001', 'RSK-002']);
    const pick = async (q: string) => (await api().get(`/api/v1/risks?${q}`).set(h).expect(200)).body.data.map((r: { reference: string }) => r.reference);
    expect(await pick('kind=opportunity')).toEqual(['RSK-002']);
    expect(await pick('band=medium')).toEqual(['RSK-001']);
    expect(await pick('band=unassessed')).toEqual(['RSK-002']);
    expect(await pick('band=high,unassessed')).toEqual(['RSK-002']);
    expect(await pick('status=draft')).toEqual(['RSK-002']);
    expect(await pick('owner=me')).toEqual(['RSK-002']);
    expect(await pick(`categoryId=${ctx.process}`)).toEqual(['RSK-001']);
    expect(await pick('q=foundry')).toEqual(['RSK-001']);
    expect(await pick('sort=score&order=desc')).toEqual(['RSK-001', 'RSK-002']);
    await api().get('/api/v1/risks?status=nope').set(h).expect(400);
  });

  it('retires with a reason and brings back', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/risks/${ctx.opportunity}/retire`).set(h).send({}).expect(400);
    const retired = await api().post(`/api/v1/risks/${ctx.opportunity}/retire`).set(h).send({ reason: 'No budget this year' }).expect(200);
    expect(retired.body).toMatchObject({ status: 'retired', retiredReason: 'No budget this year', canEdit: false });
    expect((await api().get('/api/v1/risks').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/risks?status=retired').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/risks?status=all').set(h).expect(200)).body.total).toBe(2);
    const refused = await api().post(`/api/v1/risks/${ctx.opportunity}/assessments`).set(h).send({ likelihood: 1, consequence: 1, rationale: 'After' }).expect(409);
    expect(refused.body.error.message).toMatch(/retired/);
    const back = await api().post(`/api/v1/risks/${ctx.opportunity}/reactivate`).set(h).expect(200);
    expect(back.body).toMatchObject({ status: 'draft', retiredReason: null });
  });

  it('keeps another organisation out', async () => {
    const b = await as(ids.ownerB, ids.orgB);
    expect((await api().get('/api/v1/risks').set(b).expect(200)).body.total).toBe(0);
    await api().get(`/api/v1/risks/${ctx.risk}`).set(b).expect(404);
    await api().post(`/api/v1/risks/${ctx.risk}/assessments`).set(b).send({ likelihood: 1, consequence: 1, rationale: 'Hijack' }).expect(404);
    await api().patch(`/api/v1/risk-categories/${ctx.process}`).set(b).send({ label: 'Hijack' }).expect(404);
    expect((await api().get('/api/v1/risk-model').set(b).expect(200)).body.version).toBe(1);
  });
});

describe('treatment, acceptance, reviews and closing (RK2)', () => {
  const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  let risk = '';
  let action = '';

  it('goes from open to treating to monitoring as the facts change', async () => {
    const h = await as(ids.ownerA);
    // The matrix was made stricter above (acceptable: low); put it back to medium.
    const model = (await api().get('/api/v1/risk-model').set(h).expect(200)).body;
    await api().put('/api/v1/risk-model').set(h).send({ config: { ...model.config, acceptanceBand: 'medium' }, reason: 'Back to medium' }).expect(200);
    // dual becomes a second approver in organisation A
    await admin.query(
      `insert into public.user_role_assignments (organisation_id, membership_id, role_id)
       select $1, ou.id, r.id from public.organisation_users ou, public.roles r where ou.organisation_id = $1 and ou.user_id = $2 and r.organisation_id = $1 and r.key = 'quality_manager'`,
      [ids.orgA, ids.dual],
    );
    const made = (await api().post('/api/v1/risks').set(h).send({ categoryId: ctx.process, title: 'Coolant supply' }).expect(201)).body;
    risk = made.id;
    expect(made).toMatchObject({ status: 'draft', strategy: null, residual: null, nextReviewOn: null, problems: ['Assess the risk'], actions: [], reviews: [], acceptances: [] });
    const early = await api().put(`/api/v1/risks/${risk}/treatment`).set(h).send({ strategy: 'mitigate' }).expect(409);
    expect(early.body.error.code).toBe('risk_rule');
    const assessed = (await api().post(`/api/v1/risks/${risk}/assessments`).set(h).send({ likelihood: 4, consequence: 4, rationale: 'One supplier, six-week lead time' }).expect(200)).body;
    expect(assessed).toMatchObject({ status: 'open', band: 'high', reviewOverdue: false, problems: ['Choose what will be done about the risk'], acceptance: { acceptanceBand: 'medium', above: true, accepted: false } });
    expect(assessed.nextReviewOn > day(80)).toBe(true);
    await api().put(`/api/v1/risks/${risk}/treatment`).set(await as(ids.inspectorA)).send({ strategy: 'mitigate' }).expect(403);
    await api().put(`/api/v1/risks/${risk}/treatment`).set(h).send({ strategy: 'ignore' }).expect(400);
    const treating = (await api().put(`/api/v1/risks/${risk}/treatment`).set(h).send({ strategy: 'mitigate', plan: 'Approve a second supplier' }).expect(200)).body;
    expect(treating).toMatchObject({ status: 'treating', strategy: 'mitigate', treatmentPlan: 'Approve a second supplier' });
  });

  it('gives actions to people; the person it was given to closes it without managing risks', async () => {
    const h = await as(ids.ownerA);
    const inspector = await as(ids.inspectorA);
    await api().post(`/api/v1/risks/${risk}/actions`).set(inspector).send({ description: 'Not mine to add' }).expect(403);
    await api().post(`/api/v1/risks/${risk}/actions`).set(h).send({ description: '' }).expect(400);
    const outsider = await api().post(`/api/v1/risks/${risk}/actions`).set(h).send({ description: 'x', ownerId: ids.ownerB }).expect(409);
    expect(outsider.body.error.message).toMatch(/active member/);
    const added = (await api().post(`/api/v1/risks/${risk}/actions`).set(h).send({ description: 'Trial the second supplier', ownerId: ids.inspectorA, dueDate: day(30) }).expect(201)).body;
    expect(added).toMatchObject({ openActions: 1, problems: ['1 action is still open', 'Assess what is left after treatment'] });
    expect(added.actions).toMatchObject([{ description: 'Trial the second supplier', owner: { id: ids.inspectorA }, dueDate: day(30), status: 'open', mine: false }]);
    action = added.actions[0].id;
    const edited = (await api().patch(`/api/v1/risk-actions/${action}`).set(h).send({ description: 'Trial the second supplier on line 2' }).expect(200)).body;
    expect(edited.actions[0].description).toBe('Trial the second supplier on line 2');
    await api().patch(`/api/v1/risk-actions/${action}`).set(inspector).send({ description: 'Mine now' }).expect(403);
    await api().post(`/api/v1/risk-actions/${action}/cancel`).set(inspector).send({ reason: 'Not mine to cancel' }).expect(403);
    await api().post(`/api/v1/risk-actions/${action}/complete`).set(await as(ids.dual, ids.orgB)).send({ note: 'x' }).expect(404);
    expect((await api().get(`/api/v1/risks/${risk}`).set(inspector).expect(200)).body.actions[0].mine).toBe(true);
    const done = (await api().post(`/api/v1/risk-actions/${action}/complete`).set(inspector).send({ note: 'Trial passed' }).expect(200)).body;
    expect(done.actions[0]).toMatchObject({ status: 'done', doneNote: 'Trial passed' });
    expect(done.openActions).toBe(0);
    const frozen = await api().patch(`/api/v1/risk-actions/${action}`).set(h).send({ description: 'Later' }).expect(409);
    expect(frozen.body.error.message).toMatch(/reopened/);
    expect((await api().post(`/api/v1/risk-actions/${action}/reopen`).set(h).expect(200)).body.actions[0]).toMatchObject({ status: 'open', doneNote: null });
    await api().post(`/api/v1/risk-actions/${action}/cancel`).set(h).send({ reason: 'x' }).expect(400);
    expect((await api().post(`/api/v1/risk-actions/${action}/cancel`).set(h).send({ reason: 'Superseded by the supply agreement' }).expect(200)).body.actions[0]).toMatchObject({ status: 'cancelled', cancelReason: 'Superseded by the supply agreement' });
  });

  it('needs an approver other than the proposer to accept what is left above the acceptable level', async () => {
    const h = await as(ids.ownerA);
    const second = await as(ids.dual);
    const before = await api().post(`/api/v1/risks/${risk}/acceptances`).set(h).send({ rationale: 'Accept it as it stands' }).expect(409);
    expect(before.body.error.message).toMatch(/what is left after treatment/);
    const left = (await api().post(`/api/v1/risks/${risk}/assessments`).set(h).send({ likelihood: 3, consequence: 4, rationale: 'Second supplier approved, low volume', phase: 'residual' }).expect(200)).body;
    expect(left).toMatchObject({ status: 'treating', band: 'high', inherent: { score: 16 }, residual: { score: 12, band: 'high' } });
    expect(left.problems).toEqual(['It is high, above the level the organisation accepts (medium): reduce it, or have it accepted by an approver']);
    expect(left.reviews).toMatchObject([{ outcome: 'reassessed', note: 'Second supplier approved, low volume' }]);
    const notYet = await api().post(`/api/v1/risks/${risk}/close`).set(h).send({ outcome: 'accepted', note: 'We live with it' }).expect(409);
    expect(notYet.body.error.message).toMatch(/an approver must accept it first/);
    await api().post(`/api/v1/risks/${risk}/acceptances`).set(h).send({ rationale: 'short' }).expect(400);
    const proposed = (await api().post(`/api/v1/risks/${risk}/acceptances`).set(h).send({ rationale: 'Second source approved; volume grows next quarter' }).expect(201)).body;
    expect(proposed.problems).toEqual(['The acceptance is waiting for an approver']);
    expect(proposed.acceptances).toMatchObject([{ status: 'proposed', band: 'high', inForce: true, canDecide: false, canWithdraw: true, proposedBy: 'Ada Owner' }]);
    const acceptance = proposed.acceptances[0].id;
    const own = await api().post(`/api/v1/risk-acceptances/${acceptance}/decide`).set(h).send({ approve: true, note: 'My own' }).expect(409);
    expect(own.body.error.message).toBe('An acceptance is decided by someone other than the person who proposed it');
    await api().post(`/api/v1/risk-acceptances/${acceptance}/decide`).set(await as(ids.inspectorA)).send({ approve: true, note: 'Not mine' }).expect(403);
    expect((await api().get(`/api/v1/risks/${risk}`).set(second).expect(200)).body.acceptances[0].canDecide).toBe(true);
    await api().post(`/api/v1/risk-acceptances/${acceptance}/decide`).set(second).send({ approve: true }).expect(400);
    const accepted = (await api().post(`/api/v1/risk-acceptances/${acceptance}/decide`).set(second).send({ approve: true, note: 'Accepted until volume is reached' }).expect(200)).body;
    expect(accepted).toMatchObject({ status: 'monitoring', problems: [], acceptance: { above: true, accepted: true, waiting: false } });
    expect(accepted.acceptances[0]).toMatchObject({ status: 'approved', decisionNote: 'Accepted until volume is reached', canDecide: false });
    await api().post(`/api/v1/risk-acceptances/${acceptance}/withdraw`).set(h).send({ reason: 'Too late' }).expect(409);
  });

  it('records reviews, filters by what is overdue, closes and reopens', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/risks/${risk}/reviews`).set(h).send({ note: 'ok' }).expect(400);
    await api().post(`/api/v1/risks/${risk}/reviews`).set(await as(ids.inspectorA)).send({ note: 'Not mine' }).expect(403);
    const past = await api().post(`/api/v1/risks/${risk}/reviews`).set(h).send({ note: 'Looked at it', nextReviewOn: day(-1) }).expect(409);
    expect(past.body.error.message).toBe('The next review is after today and within five years');
    const reviewed = (await api().post(`/api/v1/risks/${risk}/reviews`).set(h).send({ note: 'Both suppliers delivering', nextReviewOn: day(20) }).expect(201)).body;
    expect(reviewed.nextReviewOn).toBe(day(20));
    expect(reviewed.reviews[0]).toMatchObject({ outcome: 'no_change', note: 'Both suppliers delivering', nextReviewOn: day(20), reviewedBy: 'Ada Owner' });
    const pick = async (q: string) => (await api().get(`/api/v1/risks?${q}`).set(h).expect(200)).body.data.map((r: { title: string }) => r.title);
    expect(await pick('reviewOverdue=true')).toEqual([]);
    await admin.query(`alter table public.risks disable trigger user`);
    await admin.query(`update public.risks set next_review_on = current_date - 3 where id = $1`, [risk]);
    await admin.query(`alter table public.risks enable trigger user`);
    expect(await pick('reviewOverdue=true')).toEqual(['Coolant supply']);
    expect((await api().get(`/api/v1/risks/${risk}`).set(h).expect(200)).body.reviewOverdue).toBe(true);
    expect(await pick('strategy=mitigate')).toEqual(['Coolant supply']);
    expect(await pick('strategy=none')).not.toContain('Coolant supply');
    expect(await pick('band=high')).toContain('Coolant supply');
    expect((await pick('sort=nextReview'))[0]).toBe('Coolant supply');
    await api().post(`/api/v1/risks/${risk}/close`).set(h).send({ outcome: 'done', note: 'Finished' }).expect(400);
    const closed = (await api().post(`/api/v1/risks/${risk}/close`).set(h).send({ outcome: 'accepted', note: 'Accepted with the second source in place' }).expect(200)).body;
    expect(closed).toMatchObject({ status: 'closed', outcome: 'accepted', closeNote: 'Accepted with the second source in place', closedBy: 'Ada Owner', nextReviewOn: null, reviewOverdue: false, problems: [], canEdit: false });
    const shut = await api().post(`/api/v1/risks/${risk}/actions`).set(h).send({ description: 'Too late' }).expect(409);
    expect(shut.body.error.message).toMatch(/closed/);
    await api().post(`/api/v1/risks/${risk}/reopen`).set(h).send({}).expect(400);
    const back = (await api().post(`/api/v1/risks/${risk}/reopen`).set(h).send({ reason: 'The second supplier has withdrawn' }).expect(200)).body;
    expect(back).toMatchObject({ status: 'monitoring', outcome: null, reopenReason: 'The second supplier has withdrawn', canEdit: true });
  });

  it('keeps another organisation out of every part of it', async () => {
    const b = await as(ids.ownerB, ids.orgB);
    await api().put(`/api/v1/risks/${risk}/treatment`).set(b).send({ strategy: 'avoid' }).expect(404);
    await api().post(`/api/v1/risks/${risk}/actions`).set(b).send({ description: 'Hijack' }).expect(404);
    await api().post(`/api/v1/risk-actions/${action}/reopen`).set(b).expect(404);
    await api().post(`/api/v1/risks/${risk}/reviews`).set(b).send({ note: 'Hijack' }).expect(404);
    await api().post(`/api/v1/risks/${risk}/close`).set(b).send({ outcome: 'treated', note: 'Hijack' }).expect(404);
  });
});

describe('links and raising from a record (RK3)', () => {
  let ncr = '';
  let part = '';
  let risk = '';

  it('drafts a risk from an NC, raises it with the NC linked, and lists it on the NC', async () => {
    const h = await as(ids.ownerA);
    part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'RK3-1', name: 'Bracket' }).expect(201)).body.id;
    ncr = (
      await api().post('/api/v1/ncrs').set(h).send({ source: 'internal', title: 'Cracked weld', severity: 'major', quantityAffected: 4, description: 'Crack at the weld toe', siteId: ids.siteA, partId: part, open: true, categoryId: await categoryId(admin, ids.orgA) }).expect(201)
    ).body.id;
    await api().get(`/api/v1/risk-draft?kind=supplier&id=${ncr}`).set(h).expect(400);
    await api().get(`/api/v1/risk-draft?kind=ncr&id=${ncr}`).set(await as(ids.ownerB, ids.orgB)).expect(404);
    const draft = (await api().get(`/api/v1/risk-draft?kind=ncr&id=${ncr}`).set(h).expect(200)).body;
    expect(draft).toMatchObject({ kind: 'risk', title: 'Cracked weld', description: 'Crack at the weld toe', source: { kind: 'ncr', id: ncr, title: 'Cracked weld' } });
    expect(draft.links.map((l: { kind: string; id: string }) => [l.kind, l.id])).toEqual([['ncr', ncr], ['part', part]]);
    expect(draft.links[1]).toMatchObject({ reference: 'RK3-1', name: 'Bracket', readable: true });
    await api().post('/api/v1/risks').set(await as(ids.inspectorA)).send({ title: 'x', categoryId: draft.categoryId, raisedFrom: { kind: 'ncr', id: ncr } }).expect(403);
    const made = (
      await api().post('/api/v1/risks').set(h).send({ title: 'Weld cracking on brackets', categoryId: draft.categoryId, description: draft.description, raisedFrom: { kind: 'ncr', id: ncr }, links: [{ kind: 'part', id: part }] }).expect(201)
    ).body;
    risk = made.id;
    expect(made.origin).toMatchObject({ kind: 'ncr', id: ncr, name: 'Cracked weld', readable: true });
    expect(made.links.map((l: { kind: string }) => l.kind).sort()).toEqual(['ncr', 'part']);
    const onNc = (await api().get(`/api/v1/risks/linked?kind=ncr&id=${ncr}`).set(await as(ids.inspectorA)).expect(200)).body;
    expect(onNc).toMatchObject({ canRaise: false, data: [{ id: risk, title: 'Weld cracking on brackets' }] });
    expect((await api().get(`/api/v1/risks/linked?kind=part&id=${part}`).set(h).expect(200)).body).toMatchObject({ canRaise: true, data: [{ id: risk }] });
    await api().get('/api/v1/risks/linked?kind=operation_code&id=x').set(h).expect(400);
  });

  it('replaces the links as a whole, keeping the origin, refusing another organisation\'s records', async () => {
    const h = await as(ids.ownerA);
    await api().put(`/api/v1/risks/${risk}/links`).set(await as(ids.inspectorA)).send({ links: [] }).expect(403);
    await api().put(`/api/v1/risks/${risk}/links`).set(h).send({ links: [{ kind: 'lot', id: part }] }).expect(400);
    const kept = await api().put(`/api/v1/risks/${risk}/links`).set(h).send({ links: [{ kind: 'part', id: part }] }).expect(409);
    expect(kept.body.error).toMatchObject({ code: 'risk_rule' });
    expect(kept.body.error.message).toMatch(/stays linked/);
    const theirs = (await admin.query(`select id from public.parts where organisation_id = $1 limit 1`, [ids.orgB])).rows[0]?.id
      ?? (await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'B-1', 'Theirs') returning id`, [ids.orgB])).rows[0].id;
    const other = await api().put(`/api/v1/risks/${risk}/links`).set(h).send({ links: [{ kind: 'ncr', id: ncr }, { kind: 'part', id: theirs }] }).expect(409);
    expect(other.body.error.message).toBe('That part is not in this organisation');
    const saved = (await api().put(`/api/v1/risks/${risk}/links`).set(h).send({ links: [{ kind: 'ncr', id: ncr }, { kind: 'operation_code', code: 'OP30' }] }).expect(200)).body;
    expect(saved.links).toMatchObject([{ kind: 'ncr', id: ncr }, { kind: 'operation_code', code: 'OP30', reference: 'OP30', readable: true }]);
    expect((await api().get(`/api/v1/risks/linked?kind=part&id=${part}`).set(h).expect(200)).body.data).toEqual([]);
  });

  it('shows the links to a reader, and nothing to another organisation', async () => {
    const h = await as(ids.dual);
    const seen = (await api().get(`/api/v1/risks/${risk}`).set(h).expect(200)).body;
    expect(seen.links.find((l: { kind: string }) => l.kind === 'ncr')).toMatchObject({ id: ncr });
    await api().get(`/api/v1/risks/${risk}`).set(await as(ids.ownerB, ids.orgB)).expect(404);
  });
});
