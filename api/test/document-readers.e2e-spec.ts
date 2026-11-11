/**
 * Document control (DC3) through the API: readers, recipients fixed when a revision takes effect, viewing on open, acknowledging, my documents and
 * the badge count, restricted documents, adding a reader later, skills and the competence evidence.
 * The rules are in supabase/tests/document_control_readers.test.sql; this checks the routes, permissions and the answers.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('d3c');
const QM = 'd3c00000-0000-0000-0000-0000000000e1';
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const BODY = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Torque to 25 Nm' }] }] };

/** Writes, reviews (inspector) and approves (QM) a revision for today. */
const issue = async (revisionId: string) => {
  await api().put(`/api/v1/document-revisions/${revisionId}/signers`).set(await as(ids.ownerA)).send({ reviewerIds: [ids.inspectorA], approverId: QM }).expect(200);
  await api().post(`/api/v1/document-revisions/${revisionId}/submit`).set(await as(ids.ownerA)).expect(200);
  await api().post(`/api/v1/document-revisions/${revisionId}/review`).set(await as(ids.inspectorA)).send({ accept: true }).expect(200);
  return api().post(`/api/v1/document-revisions/${revisionId}/approve`).set(await as(QM)).send({ effectiveFrom: day() }).expect(200);
};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-dd');
  await admin.query(`insert into auth.users (id, email) values ($1, 'qm3@example.test')`, [QM]);
  const m = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, QM]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'quality_manager'`, [ids.orgA, m.rows[0].id]);
  ctx.dualMembership = (await admin.query(`select id from public.organisation_users where organisation_id = $1 and user_id = $2`, [ids.orgA, ids.dual])).rows[0].id;
  ctx.inspectorRole = (await admin.query(`select id from public.roles where organisation_id = $1 and key = 'inspector'`, [ids.orgA])).rows[0].id;
  ctx.dualEmployee = (await admin.query(`insert into public."Employees" (organisation_id, first_name, surname, auth_id) values ($1, 'Dee', 'Dual', $2) returning id`, [ids.orgA, ids.dual])).rows[0].id;
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  ctx.sop = (await api().get('/api/v1/document-types').set(await as(ids.ownerA)).expect(200)).body.data[0].id;
  ctx.category = (await admin.query(`select id from public.competence_categories where organisation_id = $1 and key = 'machine_operation'`, [ids.orgA])).rows[0].id;
  ctx.skill = (await api().post('/api/v1/competence/skills').set(await as(ids.ownerA)).send({ code: 'TORQ', name: 'Torque tightening', categoryId: ctx.category }).expect(201)).body.id;
});
afterAll(async () => {
  // Reading notices are emailed by default; leave no queued email for the suites that drain the shared queue.
  await admin?.query(`delete from public.email_outbox where organisation_id = $1`, [ids.orgA]);
  await app?.close();
  await admin?.end();
});

describe('readers and acknowledgement', () => {
  it('names readers and skills on a document and a deadline on its draft', async () => {
    const h = await as(ids.ownerA);
    const doc = await api().post('/api/v1/documents').set(h).send({ typeId: ctx.sop, title: 'Torque procedure', contentKind: 'text' }).expect(201);
    ctx.doc = doc.body.id;
    ctx.rev = doc.body.revisions[0].id;
    const readers = await api().put(`/api/v1/documents/${ctx.doc}/readers`).set(h).send({ targets: [{ roleId: ctx.inspectorRole }, { membershipId: ctx.dualMembership }] }).expect(200);
    expect(readers.body.targets.map((t: { kind: string; label: string }) => `${t.kind}:${t.label}`)).toEqual(['role:Inspector', 'person:Unnamed'.replace('Unnamed', readers.body.targets[1].label)]);
    await api().put(`/api/v1/documents/${ctx.doc}/readers`).set(h).send({ targets: [{ roleId: ctx.inspectorRole, departmentId: ctx.inspectorRole }] }).expect(400);
    const skills = await api().put(`/api/v1/documents/${ctx.doc}/skills`).set(h).send({ skillIds: [ctx.skill] }).expect(200);
    expect(skills.body.skills).toEqual([{ id: ctx.skill, code: 'TORQ', name: 'Torque tightening' }]);
    const rev = await api().patch(`/api/v1/document-revisions/${ctx.rev}`).set(h).send({ body: BODY, acknowledgeWithinDays: 7 }).expect(200);
    expect(rev.body.acknowledgeWithinDays).toBe(7);
    await api().patch(`/api/v1/document-revisions/${ctx.rev}`).set(h).send({ acknowledgeWithinDays: 0 }).expect(400);
  });

  it('asks the readers when it takes effect, and shows each their own to-do with a count', async () => {
    await issue(ctx.rev);
    const d = await as(ids.dual);
    const count = await api().get('/api/v1/my-documents/count').set(d).expect(200);
    expect(count.body).toEqual({ toRead: 1, overdue: 0, reviews: 0, total: 1 });
    const mine = await api().get('/api/v1/my-documents').set(d).expect(200);
    expect(mine.body.toRead).toMatchObject([{ document: { id: ctx.doc, number: 'SOP-001' }, revision: { id: ctx.rev, letter: 'A' }, dueOn: day(7), overdue: false, viewedAt: null }]);
    const list = await api().get('/api/v1/documents').set(d).expect(200);
    expect(list.body.data[0]).toMatchObject({ toAcknowledge: { dueOn: day(7) } });
    const insp = await api().get('/api/v1/my-documents/count').set(await as(ids.inspectorA)).expect(200);
    expect(insp.body.toRead).toBe(1);
  });

  it('records the first view on opening, then the acknowledgement once', async () => {
    const d = await as(ids.dual);
    const opened = await api().get(`/api/v1/document-revisions/${ctx.rev}`).set(d).expect(200);
    expect(opened.body.myReading).toMatchObject({ dueOn: day(7), acknowledgedAt: null });
    expect(opened.body.myReading.viewedAt).not.toBeNull();
    const ack = await api().post(`/api/v1/document-revisions/${ctx.rev}/acknowledge`).set(d).send({ note: 'Read at the briefing' }).expect(200);
    expect(ack.body.myReading).toMatchObject({ note: 'Read at the briefing' });
    const again = await api().post(`/api/v1/document-revisions/${ctx.rev}/acknowledge`).set(d).send({}).expect(409);
    expect(again.body.error.message).toMatch(/already acknowledged/);
    expect((await api().get('/api/v1/my-documents/count').set(d).expect(200)).body.toRead).toBe(0);
    expect((await api().get('/api/v1/my-documents').set(d).expect(200)).body.acknowledged).toHaveLength(1);
  });

  it('shows managers every reader, lets them add one later, and others only themselves', async () => {
    const h = await as(ids.ownerA);
    const all = await api().get(`/api/v1/document-revisions/${ctx.rev}/recipients`).set(h).expect(200);
    expect(all.body.data).toHaveLength(2);
    expect(all.body.data.find((x: { person: { id: string } }) => x.person.id === ids.dual)).toMatchObject({ reachedVia: ['Named'], note: 'Read at the briefing' });
    const added = await api().post(`/api/v1/document-revisions/${ctx.rev}/recipients`).set(h).send({ userId: QM }).expect(201);
    expect(added.body.data.find((x: { person: { id: string } }) => x.person.id === QM)).toMatchObject({ reachedVia: ['Added'], acknowledgedAt: null });
    await api().post(`/api/v1/document-revisions/${ctx.rev}/recipients`).set(h).send({ userId: QM }).expect(409);
    await api().post(`/api/v1/document-revisions/${ctx.rev}/recipients`).set(await as(ids.inspectorA)).send({ userId: QM }).expect(403);
    const own = await api().get(`/api/v1/document-revisions/${ctx.rev}/recipients`).set(await as(ids.inspectorA)).expect(200);
    expect(own.body.data.map((x: { person: { id: string } }) => x.person.id)).toEqual([ids.inspectorA]);
    const doc = await api().get(`/api/v1/documents/${ctx.doc}`).set(h).expect(200);
    expect(doc.body.readers).toEqual({ total: 3, acknowledged: 1, overdue: 0 });
  });

  it('hides a restricted document from members it does not reach', async () => {
    await admin.query(`insert into auth.users (id, email) values ('d3c00000-0000-0000-0000-0000000000e2', 'viewer3@example.test')`);
    await admin.query(
      `with m as (insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, 'd3c00000-0000-0000-0000-0000000000e2', 'active', now()) returning id)
       insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, m.id, r.id from m, public.roles r where r.organisation_id = $1 and r.key = 'viewer'`,
      [ids.orgA],
    );
    const v = await as('d3c00000-0000-0000-0000-0000000000e2');
    await api().get(`/api/v1/documents/${ctx.doc}`).set(v).expect(200);
    const r = await api().patch(`/api/v1/documents/${ctx.doc}`).set(await as(ids.ownerA)).send({ restricted: true }).expect(200);
    expect(r.body.restricted).toBe(true);
    await api().get(`/api/v1/documents/${ctx.doc}`).set(v).expect(404);
    await api().get(`/api/v1/document-revisions/${ctx.rev}`).set(v).expect(404);
    await api().get(`/api/v1/documents/${ctx.doc}`).set(await as(ids.dual)).expect(200);
  });

  it('shows the acknowledgement on the person\'s competence record as evidence', async () => {
    const own = await api().get('/api/v1/competence/me').set(await as(ids.dual)).expect(200);
    expect(own.body.documentsRead).toMatchObject([{ number: 'SOP-001', letter: 'A', skills: [{ code: 'TORQ' }] }]);
    const byManager = await api().get(`/api/v1/competence/people/${ctx.dualEmployee}`).set(await as(ids.ownerA)).expect(200);
    expect(byManager.body.documentsRead).toHaveLength(1);
  });

  it('keeps another organisation out', async () => {
    const b = await as(ids.ownerB, ids.orgB);
    await api().put(`/api/v1/documents/${ctx.doc}/readers`).set(b).send({ targets: [] }).expect(404);
    await api().post(`/api/v1/document-revisions/${ctx.rev}/acknowledge`).set(b).send({}).expect(404);
    expect((await api().get('/api/v1/my-documents/count').set(b).expect(200)).body.total).toBe(0);
  });
});
