/**
 * Document control (DC2) through the API: reviewers and approver, submitting, sending back, approving with an effective date, settling on read,
 * a new revision superseding the old, comparing revisions, withdrawing, and what is waiting for whom.
 * The rules are in supabase/tests/document_control_review.test.sql; this checks the routes, permissions, the answers and that errors reach the caller in words.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('d2c');
const QM = 'd2c00000-0000-0000-0000-0000000000e1';
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const doc = (...texts: string[]) => ({ type: 'doc', content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-dr');
  await admin.query(`insert into auth.users (id, email) values ($1, 'qm@example.test')`, [QM]);
  await admin.query(`update public.profiles set first_name = 'Quinn', surname = 'Manager' where id = $1`, [QM]);
  const m = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, QM]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'quality_manager'`, [ids.orgA, m.rows[0].id]);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const types = await api().get('/api/v1/document-types').set(await as(ids.ownerA)).expect(200);
  ctx.sop = types.body.data[0].id;
});
afterAll(async () => {
  // The "waiting for you" notices are emailed by default; leave no queued email for the suites that drain the shared queue.
  await admin?.query(`delete from public.email_outbox where organisation_id = $1`, [ids.orgA]);
  await app?.close();
  await admin?.end();
});

describe('review and approval', () => {
  it('lists who can be named, with who can approve', async () => {
    const res = await api().get('/api/v1/document-signers').set(await as(ids.ownerA)).expect(200);
    const byId = Object.fromEntries(res.body.data.map((p: { id: string; canApprove: boolean }) => [p.id, p.canApprove]));
    expect(byId[QM]).toBe(true);
    expect(byId[ids.inspectorA]).toBe(false);
    await api().get('/api/v1/document-signers').set(await as(ids.inspectorA)).expect(403);
  });

  it('shows what a draft still needs, names signers, and submits with letter A', async () => {
    const h = await as(ids.ownerA);
    const created = await api().post('/api/v1/documents').set(h).send({ typeId: ctx.sop, title: 'Nonconforming product', contentKind: 'text' }).expect(201);
    ctx.doc = created.body.id;
    ctx.rev = created.body.revisions[0].id;
    const draft = await api().get(`/api/v1/document-revisions/${ctx.rev}`).set(h).expect(200);
    expect(draft.body.problems).toEqual(["Write the document's text", 'Name at least one reviewer', 'Name the approver']);
    const early = await api().post(`/api/v1/document-revisions/${ctx.rev}/submit`).set(h).expect(409);
    expect(early.body.error.message).toMatch(/Still needed: Write/);
    await api().patch(`/api/v1/document-revisions/${ctx.rev}`).set(h).send({ body: doc('Purpose', 'Old step') }).expect(200);
    const self = await api().put(`/api/v1/document-revisions/${ctx.rev}/signers`).set(h).send({ reviewerIds: [ids.ownerA], approverId: QM }).expect(409);
    expect(self.body.error.message).toMatch(/cannot review their own/);
    const named = await api().put(`/api/v1/document-revisions/${ctx.rev}/signers`).set(h).send({ reviewerIds: [ids.inspectorA], approverId: QM }).expect(200);
    expect(named.body).toMatchObject({ reviewers: [{ id: ids.inspectorA }], approver: { id: QM, name: 'Quinn Manager' }, problems: [] });
    const sent = await api().post(`/api/v1/document-revisions/${ctx.rev}/submit`).set(h).expect(200);
    expect(sent.body).toMatchObject({ status: 'in_review', letter: 'A', reviewRound: 1, canEdit: false, myTurn: null });
    expect(sent.body.signoffs).toMatchObject([{ round: 1, role: 'reviewer', person: { id: ids.inspectorA }, decision: 'pending' }]);
  });

  it('lets the reviewer (an inspector) see it waiting, read it and send it back', async () => {
    const h = await as(ids.inspectorA);
    const waiting = await api().get('/api/v1/document-reviews/mine').set(h).expect(200);
    expect(waiting.body.data).toMatchObject([{ role: 'reviewer', document: { id: ctx.doc, number: 'SOP-001' }, revision: { id: ctx.rev, letter: 'A' } }]);
    const rev = await api().get(`/api/v1/document-revisions/${ctx.rev}`).set(h).expect(200);
    expect(rev.body.myTurn).toBe('review');
    await api().post(`/api/v1/document-revisions/${ctx.rev}/review`).set(h).send({ accept: false }).expect(409);
    const back = await api().post(`/api/v1/document-revisions/${ctx.rev}/review`).set(h).send({ accept: false, comment: 'Add the quarantine label' }).expect(200);
    expect(back.body).toMatchObject({ status: 'draft', letter: 'A' });
    expect(back.body.signoffs[0]).toMatchObject({ decision: 'returned', comment: 'Add the quarantine label' });
    expect((await api().get('/api/v1/document-reviews/mine').set(h).expect(200)).body.data).toEqual([]);
  });

  it('runs round 2 through review and approval for today, so it is in force at once', async () => {
    await api().patch(`/api/v1/document-revisions/${ctx.rev}`).set(await as(ids.ownerA)).send({ body: doc('Purpose', 'Old step', 'Label it') }).expect(200);
    await api().post(`/api/v1/document-revisions/${ctx.rev}/submit`).set(await as(ids.ownerA)).expect(200);
    const accepted = await api().post(`/api/v1/document-revisions/${ctx.rev}/review`).set(await as(ids.inspectorA)).send({ accept: true }).expect(200);
    expect(accepted.body).toMatchObject({ status: 'awaiting_approval', reviewRound: 2 });
    await api().post(`/api/v1/document-revisions/${ctx.rev}/approve`).set(await as(ids.inspectorA)).send({ effectiveFrom: day() }).expect(403);
    const q = await as(QM);
    expect((await api().get('/api/v1/document-reviews/mine').set(q).expect(200)).body.data).toMatchObject([{ role: 'approver' }]);
    const past = await api().post(`/api/v1/document-revisions/${ctx.rev}/approve`).set(q).send({ effectiveFrom: day(-1) }).expect(409);
    expect(past.body.error.message).toMatch(/before today/);
    const approved = await api().post(`/api/v1/document-revisions/${ctx.rev}/approve`).set(q).send({ effectiveFrom: day(), comment: 'Good' }).expect(200);
    expect(approved.body).toMatchObject({ status: 'effective', approvedBy: 'Quinn Manager', effectiveFrom: day() });
    const d = await api().get(`/api/v1/documents/${ctx.doc}`).set(await as(ids.ownerA)).expect(200);
    expect(d.body).toMatchObject({ status: 'active', currentRevision: { id: ctx.rev, letter: 'A' }, inProgress: null, canStartRevision: true, canIssue: true });
    const list = await api().get('/api/v1/documents').set(await as(ids.dual)).expect(200);
    expect(list.body.data.map((x: { number: string }) => x.number)).toEqual(['SOP-001']);
  });

  it('starts rev B from rev A, compares them, approves it for later and settles it when the date comes', async () => {
    const h = await as(ids.ownerA);
    const b = await api().post(`/api/v1/documents/${ctx.doc}/revisions`).set(h).expect(201);
    ctx.revB = b.body.id;
    expect(b.body).toMatchObject({ status: 'draft', plannedLetter: 'B', previousRevisionId: ctx.rev, body: doc('Purpose', 'Old step', 'Label it') });
    expect(b.body.problems).toEqual(['Say what changed and why', 'Name at least one reviewer', 'Name the approver']);
    await api().post(`/api/v1/documents/${ctx.doc}/revisions`).set(h).expect(409);
    await api().patch(`/api/v1/document-revisions/${ctx.revB}`).set(h).send({ changeSummary: 'Replaced the old step', body: doc('Purpose', 'Label it', 'New step') }).expect(200);
    const cmp = await api().get(`/api/v1/document-revisions/${ctx.revB}/compare`).set(h).expect(200);
    expect(cmp.body.against).toEqual({ id: ctx.rev, label: 'Rev A' });
    expect(cmp.body.text.map((c: { kind: string; text: string }) => `${c.kind}:${c.text}`)).toEqual(['same:Purpose', 'removed:Old step', 'same:Label it', 'added:New step']);
    expect(cmp.body.textSummary).toEqual({ added: 1, removed: 1, same: 2 });
    await api().put(`/api/v1/document-revisions/${ctx.revB}/signers`).set(h).send({ reviewerIds: [ids.inspectorA], approverId: QM }).expect(200);
    await api().post(`/api/v1/document-revisions/${ctx.revB}/submit`).set(h).expect(200);
    await api().post(`/api/v1/document-revisions/${ctx.revB}/review`).set(await as(ids.inspectorA)).send({ accept: true }).expect(200);
    const later = await api().post(`/api/v1/document-revisions/${ctx.revB}/approve`).set(await as(QM)).send({ effectiveFrom: day(3) }).expect(200);
    expect(later.body).toMatchObject({ status: 'approved', letter: 'B' });
    let d = await api().get(`/api/v1/documents/${ctx.doc}`).set(h).expect(200);
    expect(d.body).toMatchObject({ currentRevision: { letter: 'A' }, inProgress: { status: 'approved', letter: 'B', effectiveFrom: day(3) } });
    // The date comes.
    await admin.query(`alter table public.document_revisions disable trigger document_revisions_rules`);
    await admin.query(`update public.document_revisions set effective_from = current_date where id = $1`, [ctx.revB]);
    await admin.query(`alter table public.document_revisions enable trigger document_revisions_rules`);
    d = await api().get(`/api/v1/documents/${ctx.doc}`).set(h).expect(200);
    expect(d.body).toMatchObject({ currentRevision: { id: ctx.revB, letter: 'B' }, inProgress: null });
    expect(d.body.revisions.map((r: { letter: string; status: string }) => `${r.letter}:${r.status}`)).toEqual(['B:effective', 'A:superseded']);
  });

  it('withdraws a document with a reason (documentation.issue only) and revises it back into use', async () => {
    await api().post(`/api/v1/documents/${ctx.doc}/withdraw`).set(await as(ids.inspectorA)).send({ reason: 'Obsolete' }).expect(403);
    const w = await api().post(`/api/v1/documents/${ctx.doc}/withdraw`).set(await as(ids.ownerA)).send({ reason: 'Replaced by the manual' }).expect(200);
    expect(w.body).toMatchObject({ status: 'withdrawn', withdrawReason: 'Replaced by the manual', canStartRevision: true });
    const again = await api().post(`/api/v1/documents/${ctx.doc}/withdraw`).set(await as(ids.ownerA)).send({ reason: 'Again' }).expect(409);
    expect(again.body.error.code).toBe('document_rule');
    const c = await api().post(`/api/v1/documents/${ctx.doc}/revisions`).set(await as(ids.ownerA)).expect(201);
    expect(c.body.plannedLetter).toBe('C');
  });

  it('keeps another organisation out', async () => {
    const b = await as(ids.ownerB, ids.orgB);
    await api().get(`/api/v1/document-revisions/${ctx.rev}/compare`).set(b).expect(404);
    await api().post(`/api/v1/document-revisions/${ctx.revB}/review`).set(b).send({ accept: true }).expect(404);
  });
});
