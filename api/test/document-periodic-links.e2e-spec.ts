/**
 * Document control (DC4) through the API: next review dates and periodic reviews, change requests (raise, accept into a draft, decline, withdraw),
 * links, and the documents in force where work happens. The rules are in supabase/tests/document_control_periodic_links.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('d4c');
const QM = 'd4c00000-0000-0000-0000-0000000000e1';
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const monthsOn = (n: number) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
const BODY = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Deburr all edges' }] }] };

const issue = async (revisionId: string) => {
  await api().put(`/api/v1/document-revisions/${revisionId}/signers`).set(await as(ids.ownerA)).send({ reviewerIds: [ids.inspectorA], approverId: QM }).expect(200);
  await api().post(`/api/v1/document-revisions/${revisionId}/submit`).set(await as(ids.ownerA)).expect(200);
  await api().post(`/api/v1/document-revisions/${revisionId}/review`).set(await as(ids.inspectorA)).send({ accept: true }).expect(200);
  await api().post(`/api/v1/document-revisions/${revisionId}/approve`).set(await as(QM)).send({ effectiveFrom: day() }).expect(200);
};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-dp');
  await admin.query(`insert into auth.users (id, email) values ($1, 'qm4@example.test')`, [QM]);
  const m = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, QM]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'quality_manager'`, [ids.orgA, m.rows[0].id]);
  ctx.family = (await admin.query(`insert into public.part_families (organisation_id, code, name) values ($1, 'BRK', 'Brackets') returning id`, [ids.orgA])).rows[0].id;
  ctx.part = (await admin.query(`insert into public.parts (organisation_id, part_number, name, part_family_id) values ($1, 'P-100', 'Bracket', $2) returning id`, [ids.orgA, ctx.family])).rows[0].id;
  ctx.machine = (await admin.query(`insert into public.machines (organisation_id, code, name) values ($1, 'M-1', 'Deburr cell') returning id`, [ids.orgA])).rows[0].id;
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  ctx.sop = (await api().get('/api/v1/document-types').set(await as(ids.ownerA)).expect(200)).body.data[0].id;
});
afterAll(async () => {
  await admin?.query(`delete from public.email_outbox where organisation_id = $1`, [ids.orgA]);
  await app?.close();
  await admin?.end();
});

describe('periodic review', () => {
  it('sets the next review date when it takes effect, and moves it with the document\'s own interval', async () => {
    const h = await as(ids.ownerA);
    const doc = await api().post('/api/v1/documents').set(h).send({ typeId: ctx.sop, title: 'Deburring', contentKind: 'text' }).expect(201);
    ctx.doc = doc.body.id;
    expect(doc.body).toMatchObject({ nextReviewOn: null, reviewMonths: null, reviewMonthsEffective: 24 });
    await api().patch(`/api/v1/document-revisions/${doc.body.revisions[0].id}`).set(h).send({ body: BODY }).expect(200);
    await issue(doc.body.revisions[0].id);
    let d = await api().get(`/api/v1/documents/${ctx.doc}`).set(h).expect(200);
    expect(d.body).toMatchObject({ nextReviewOn: monthsOn(24), reviewOverdue: false });
    d = await api().patch(`/api/v1/documents/${ctx.doc}`).set(h).send({ reviewMonths: 6 }).expect(200);
    expect(d.body).toMatchObject({ reviewMonths: 6, reviewMonthsEffective: 6, nextReviewOn: monthsOn(6) });
  });

  it('lists documents overdue for review', async () => {
    await admin.query(`update public.documents set next_review_on = current_date - 1 where id = $1`, [ctx.doc]);
    const overdue = await api().get('/api/v1/documents?reviewOverdue=true').set(await as(ids.ownerA)).expect(200);
    expect(overdue.body.data).toMatchObject([{ id: ctx.doc, reviewOverdue: true }]);
  });

  it('records "no change needed" with a note, or starts a revision', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/documents/${ctx.doc}/reviews`).set(h).send({ outcome: 'no_change' }).expect(400);
    await api().post(`/api/v1/documents/${ctx.doc}/reviews`).set(await as(ids.inspectorA)).send({ outcome: 'no_change', note: 'Fine' }).expect(403);
    const ok = await api().post(`/api/v1/documents/${ctx.doc}/reviews`).set(h).send({ outcome: 'no_change', note: 'Checked against the drawing' }).expect(201);
    expect(ok.body).toMatchObject({ nextReviewOn: monthsOn(6), reviewOverdue: false, startedRevisionId: null });
    expect(ok.body.reviews[0]).toMatchObject({ outcome: 'no_change', note: 'Checked against the drawing', revisionLetter: 'A', wasDueOn: day(-1) });
    const started = await api().post(`/api/v1/documents/${ctx.doc}/reviews`).set(h).send({ outcome: 'revision_started' }).expect(201);
    expect(started.body.startedRevisionId).toBeTruthy();
    expect(started.body.inProgress).toMatchObject({ id: started.body.startedRevisionId, status: 'draft' });
    ctx.revB = started.body.startedRevisionId;
  });
});

describe('change requests', () => {
  it('lets a reader ask for a change and see only their own requests', async () => {
    const d = await as(ids.dual);
    await api().post(`/api/v1/documents/${ctx.doc}/change-requests`).set(d).send({ what: 'x', why: 'Because' }).expect(400);
    const cr = await api().post(`/api/v1/documents/${ctx.doc}/change-requests`).set(d).send({ what: 'Add the burr height limit', why: 'Customer complaint' }).expect(201);
    expect(cr.body).toMatchObject({ status: 'open', document: { id: ctx.doc, number: 'SOP-001' }, what: 'Add the burr height limit' });
    expect(cr.body.reference).toMatch(/^DCR-\d{2}-0001$/);
    ctx.cr1 = cr.body.id;
    ctx.cr2 = (await api().post(`/api/v1/documents/${ctx.doc}/change-requests`).set(d).send({ what: 'Mention the new tool', why: 'New tool' }).expect(201)).body.id;
    ctx.cr3 = (await api().post(`/api/v1/documents/${ctx.doc}/change-requests`).set(await as(ids.inspectorA)).send({ what: 'Typo in step 2', why: 'Reads badly' }).expect(201)).body.id;
    const mine = await api().get('/api/v1/document-change-requests').set(d).expect(200);
    expect(mine.body.data.map((c: { id: string }) => c.id).sort()).toEqual([ctx.cr1, ctx.cr2].sort());
    const all = await api().get(`/api/v1/document-change-requests?documentId=${ctx.doc}`).set(await as(ids.ownerA)).expect(200);
    expect(all.body.data).toHaveLength(3);
  });

  it('accepts into the draft in progress, declines with a reason, and lets the person who asked withdraw', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/document-change-requests/${ctx.cr1}/accept`).set(await as(ids.dual)).expect(403);
    const accepted = await api().post(`/api/v1/document-change-requests/${ctx.cr1}/accept`).set(h).expect(200);
    expect(accepted.body).toMatchObject({ status: 'accepted', revision: { id: ctx.revB, status: 'draft' } });
    await api().post(`/api/v1/document-change-requests/${ctx.cr2}/decline`).set(h).send({ reason: 'no' }).expect(400);
    const declined = await api().post(`/api/v1/document-change-requests/${ctx.cr2}/decline`).set(h).send({ reason: 'Covered by the tool manual' }).expect(200);
    expect(declined.body).toMatchObject({ status: 'declined', decisionReason: 'Covered by the tool manual' });
    await api().post(`/api/v1/document-change-requests/${ctx.cr3}/withdraw`).set(h).expect(403);
    expect((await api().post(`/api/v1/document-change-requests/${ctx.cr3}/withdraw`).set(await as(ids.inspectorA)).expect(200)).body.status).toBe('withdrawn');
    const again = await api().post(`/api/v1/document-change-requests/${ctx.cr2}/accept`).set(h).expect(409);
    expect(again.body.error.code).toBe('document_rule');
    const notices = await admin.query(`select body from public.notifications where entity_type = 'document_change_requests' and recipient_user_id = $1 order by created_at`, [ids.dual]);
    expect(notices.rows.map((n: { body: string }) => n.body.split(' — ')[1])).toEqual(['Accepted: a revision is being written', 'Declined: Covered by the tool manual']);
    const doc = await api().get(`/api/v1/documents/${ctx.doc}`).set(h).expect(200);
    expect(doc.body.changeRequests.map((c: { status: string }) => c.status).sort()).toEqual(['accepted', 'declined', 'withdrawn']);
  });
});

describe('links and documents in force where work happens', () => {
  it('links a document to a part family, machine and operation, and lists it where work happens', async () => {
    const h = await as(ids.ownerA);
    const linked = await api().put(`/api/v1/documents/${ctx.doc}/links`).set(h).send({ links: [{ partFamilyId: ctx.family }, { machineId: ctx.machine }, { operationCode: 'OP-20' }] }).expect(200);
    expect(linked.body.links.map((l: { kind: string; label: string }) => `${l.kind}:${l.label}`)).toEqual(['part_family:BRK · Brackets', 'machine:M-1 · Deburr cell', 'operation:OP-20']);
    await api().put(`/api/v1/documents/${ctx.doc}/links`).set(h).send({ links: [{ partId: ctx.part, machineId: ctx.machine }] }).expect(400);
    const byPart = await api().get(`/api/v1/documents-in-force?partId=${ctx.part}`).set(await as(ids.dual)).expect(200);
    expect(byPart.body.data).toMatchObject([{ id: ctx.doc, number: 'SOP-001', revision: { letter: 'A' }, matched: ['part family'] }]);
    const byOp = await api().get('/api/v1/documents-in-force?operationCode=op-20').set(await as(ids.dual)).expect(200);
    expect(byOp.body.data).toHaveLength(1);
    const nothing = await api().get('/api/v1/documents-in-force?operationCode=OP-99').set(await as(ids.dual)).expect(200);
    expect(nothing.body.data).toEqual([]);
    await api().get('/api/v1/documents-in-force').set(await as(ids.dual)).expect(400);
  });

  it('keeps another organisation out', async () => {
    const b = await as(ids.ownerB, ids.orgB);
    await api().post(`/api/v1/documents/${ctx.doc}/change-requests`).set(b).send({ what: 'Hijack', why: 'Hijack' }).expect(404);
    await api().post(`/api/v1/document-change-requests/${ctx.cr1}/decline`).set(b).send({ reason: 'Hijack' }).expect(404);
    expect((await api().get(`/api/v1/documents-in-force?machineId=${ctx.machine}`).set(b).expect(200)).body.data).toEqual([]);
  });
});
