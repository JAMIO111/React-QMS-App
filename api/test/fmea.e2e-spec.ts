/**
 * FMEA (FM1) through the API: starting an FMEA, its team, scope and approver, what a draft still needs, submitting, approving (the named approver, never the
 * preparer), becoming effective, a new revision, withdrawing, discarding, the register's filters, edit conflicts, permissions and tenancy. The rules are in
 * supabase/tests/fmea_foundation.test.sql; this checks the routes and that errors reach the caller in words.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a1e');
const QM = 'a1e00000-0000-0000-0000-0000000000e1';
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const today = () => new Date().toISOString().slice(0, 10);
const ctx: Record<string, string> = {};

/** The smallest analysis that lets a draft be submitted: one item, function, failure mode, effect and a rated, controlled cause. */
async function buildNet(h: Record<string, string>, revision: string) {
  const item = (await api().post(`/api/v1/fmea-revisions/${revision}/items`).set(h).send({ kind: 'item', name: 'Turning' }).expect(201)).body.net.items[0].id;
  const fn = (await api().post(`/api/v1/fmea-items/${item}/functions`).set(h).send({ text: 'Turn the bore to size' }).expect(201)).body.net.items[0].functions[0].id;
  const mode = (await api().post(`/api/v1/fmea-functions/${fn}/failure-modes`).set(h).send({ text: 'Bore oversize' }).expect(201)).body.net.items[0].functions[0].failureModes[0].id;
  await api().post(`/api/v1/fmea-failure-modes/${mode}/effects`).set(h).send({ level: 'own_plant', text: 'Scrap', severity: 5 }).expect(201);
  await api().post(`/api/v1/fmea-failure-modes/${mode}/causes`).set(h).send({ text: 'Tool wear', preventionControls: 'Tool life counter', occurrence: 3, detection: 3 }).expect(201);
}

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-fm');
  await admin.query(`insert into auth.users (id, email) values ($1, 'qm@example.test')`, [QM]);
  await admin.query(`update public.profiles set first_name = 'Quinn', surname = 'Manager' where id = $1`, [QM]);
  const m = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, QM]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'quality_manager'`, [ids.orgA, m.rows[0].id]);
  ctx.part = (await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'FM-P1', 'Bracket') returning id`, [ids.orgA])).rows[0].id;
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('starting an FMEA', () => {
  it('lets a manager start one and not a reader', async () => {
    await api().post('/api/v1/fmeas').set(await as(ids.inspectorA)).send({ kind: 'process', title: 'x' }).expect(403);
    const h = await as(ids.ownerA);
    await api().post('/api/v1/fmeas').set(h).send({ kind: 'process' }).expect(400);
    await api().post('/api/v1/fmeas').set(h).send({ kind: 'service', title: 'x' }).expect(400);
    await api().post('/api/v1/fmeas').set(h).send({ kind: 'process', title: 'x', colour: 'red' }).expect(400);
    const made = await api().post('/api/v1/fmeas').set(h).send({ kind: 'process', title: 'Machining of the bracket', scopeText: 'Turning and drilling' }).expect(201);
    expect(made.body).toMatchObject({
      number: 'FMEA-001', kind: 'process', status: 'draft', title: 'Machining of the bracket', canManage: true, canApprove: true, canStartRevision: false, nextLetter: 'A',
      inProgress: { status: 'draft', letter: null, sequence: 1 },
    });
    ctx.fmea = made.body.id;
    ctx.rev = made.body.inProgress.id;
    expect((await api().get(`/api/v1/fmeas/${ctx.fmea}`).set(h).expect(200)).body.rowVersion).toMatch(/^[0-9]{10,20}$/);
  });

  it('names who may be team members or approver', async () => {
    const people = (await api().get('/api/v1/fmea-people').set(await as(ids.inspectorA)).expect(200)).body.data;
    expect(people.find((p: { id: string }) => p.id === QM)).toMatchObject({ name: 'Quinn Manager', canApprove: true });
    expect(people.find((p: { id: string }) => p.id === ids.inspectorA)).toMatchObject({ canApprove: false });
  });
});

describe('a draft revision', () => {
  it('says what it still needs', async () => {
    const rev = (await api().get(`/api/v1/fmea-revisions/${ctx.rev}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(rev).toMatchObject({ status: 'draft', letter: null, canEdit: true, canDecide: false, team: [], links: [] });
    expect(rev.problems).toEqual(expect.arrayContaining(['Name the team lead', 'Name the approver']));
    const refused = await api().post(`/api/v1/fmea-revisions/${ctx.rev}/submit`).set(await as(ids.ownerA)).expect(409);
    expect(refused.body.error.code).toBe('fmea_rule');
    expect(refused.body.error.message).toMatch(/Still needed/);
  });

  it('takes a team, a scope and an approver, each saved as given', async () => {
    const h = await as(ids.ownerA);
    await api().put(`/api/v1/fmea-revisions/${ctx.rev}/team`).set(h).send({ team: [{ userId: ids.ownerA }] }).expect(400);
    await api().put(`/api/v1/fmea-revisions/${ctx.rev}/team`).set(h).send({ team: [{ userId: ids.ownerA, role: 'lead' }, { userId: ids.ownerA, role: 'quality' }] }).expect(409);
    const team = await api().put(`/api/v1/fmea-revisions/${ctx.rev}/team`).set(h).send({ team: [{ userId: ids.ownerA, role: 'lead' }, { userId: QM, role: 'quality' }] }).expect(200);
    expect(team.body.team.map((t: { role: string }) => t.role)).toEqual(['lead', 'quality']);
    const links = await api().put(`/api/v1/fmea-revisions/${ctx.rev}/links`).set(h).send({ links: [{ kind: 'part', id: ctx.part }, { kind: 'part', id: ctx.part }, { kind: 'operation_code', code: 'OP10' }] }).expect(200);
    expect(links.body.links).toEqual([expect.objectContaining({ kind: 'part', reference: 'FM-P1', readable: true }), expect.objectContaining({ kind: 'operation_code', code: 'OP10' })]);
    const other = (await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'FM-X1', 'Other') returning id`, [ids.orgB])).rows[0].id;
    const bad = await api().put(`/api/v1/fmea-revisions/${ctx.rev}/links`).set(h).send({ links: [{ kind: 'part', id: other }] }).expect(409);
    expect(bad.body.error.message).toMatch(/not in this organisation/);
    await api().put(`/api/v1/fmea-revisions/${ctx.rev}/approver`).set(h).send({ approverId: ids.ownerA }).expect(409);
    await api().put(`/api/v1/fmea-revisions/${ctx.rev}/approver`).set(h).send({ approverId: ids.inspectorA }).expect(409);
    const ready = await api().put(`/api/v1/fmea-revisions/${ctx.rev}/approver`).set(h).send({ approverId: QM }).expect(200);
    expect(ready.body.approver).toMatchObject({ id: QM, name: 'Quinn Manager' });
    expect(ready.body.problems).toEqual(['Build the structure: add at least one item']);
    await buildNet(h, ctx.rev);
    expect((await api().get(`/api/v1/fmea-revisions/${ctx.rev}`).set(h).expect(200)).body.problems).toEqual([]);
  });

  it('refuses a stale save and keeps a current one', async () => {
    const h = await as(ids.ownerA);
    const opened = (await api().get(`/api/v1/fmea-revisions/${ctx.rev}`).set(h).expect(200)).body.rowVersion;
    await api().patch(`/api/v1/fmea-revisions/${ctx.rev}`).set(h).send({ changeSummary: 'First wording', rowVersion: opened }).expect(200);
    const stale = await api().patch(`/api/v1/fmea-revisions/${ctx.rev}`).set(h).send({ changeSummary: 'Second wording', rowVersion: opened }).expect(409);
    expect(stale.body.error.code).toBe('edit_conflict');
    await api().patch(`/api/v1/fmea-revisions/${ctx.rev}`).set(h).send({ changeSummary: null }).expect(200);
  });
});

describe('approval', () => {
  it('submits, and only the named approver who is not the preparer approves', async () => {
    const h = await as(ids.ownerA);
    const sent = await api().post(`/api/v1/fmea-revisions/${ctx.rev}/submit`).set(h).expect(200);
    expect(sent.body).toMatchObject({ status: 'pending_approval', letter: 'A', canEdit: false, canRecall: true });
    const refused = await api().put(`/api/v1/fmea-revisions/${ctx.rev}/team`).set(h).send({ team: [] }).expect(409);
    expect(refused.body.error.code).toBe('fmea_rule');
    await api().post(`/api/v1/fmea-revisions/${ctx.rev}/approve`).set(h).send({ effectiveFrom: today() }).expect(403);
    await api().post(`/api/v1/fmea-revisions/${ctx.rev}/approve`).set(await as(ids.inspectorA)).send({ effectiveFrom: today() }).expect(404); // a reader cannot even see a revision waiting for approval
    const waiting = (await api().get('/api/v1/fmeas?waiting=me').set(await as(QM)).expect(200)).body;
    expect(waiting.data.map((f: { id: string }) => f.id)).toEqual([ctx.fmea]);
    expect((await api().get(`/api/v1/fmea-revisions/${ctx.rev}`).set(await as(QM)).expect(200)).body.canDecide).toBe(true);
    const back = await api().post(`/api/v1/fmea-revisions/${ctx.rev}/send-back`).set(await as(QM)).send({ comment: 'ok' }).expect(400);
    expect(back.body).toBeDefined();
    const returned = await api().post(`/api/v1/fmea-revisions/${ctx.rev}/send-back`).set(await as(QM)).send({ comment: 'Add the detection controls' }).expect(200);
    expect(returned.body).toMatchObject({ status: 'draft', letter: 'A', returnedComment: 'Add the detection controls' });
    await api().post(`/api/v1/fmea-revisions/${ctx.rev}/submit`).set(h).expect(200);
    await api().post(`/api/v1/fmea-revisions/${ctx.rev}/approve`).set(await as(QM)).send({ effectiveFrom: '2000-01-01' }).expect(409);
    const done = await api().post(`/api/v1/fmea-revisions/${ctx.rev}/approve`).set(await as(QM)).send({ effectiveFrom: today(), comment: 'Looks right' }).expect(200);
    expect(done.body).toMatchObject({ status: 'effective', approvalComment: 'Looks right', approvedBy: { id: QM } });
  });

  it('shows the FMEA in force to a reader, in the register and on its page', async () => {
    const h = await as(ids.inspectorA);
    const fmea = (await api().get(`/api/v1/fmeas/${ctx.fmea}`).set(h).expect(200)).body;
    expect(fmea).toMatchObject({ status: 'active', currentLetter: 'A', currentRevisionId: ctx.rev, canManage: false, canStartRevision: false, reviewOverdue: false });
    expect(fmea.nextReviewOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fmea.revisions).toEqual([expect.objectContaining({ id: ctx.rev, letter: 'A', status: 'effective' })]);
    const list = (await api().get('/api/v1/fmeas').set(h).expect(200)).body;
    expect(list).toMatchObject({ page: 1, total: 1 });
    expect(list.data[0]).toMatchObject({ number: 'FMEA-001', status: 'active', currentLetter: 'A', teamCount: 2 });
    // what it covers is written in the words of the records named, for the register (a part number, a plan or family code, an operation)
    expect(typeof list.data[0].covers === 'string' || list.data[0].covers === null).toBe(true);
  });
});

describe('the register', () => {
  it('filters by what an FMEA covers, its kind, status and search', async () => {
    const h = await as(ids.ownerA);
    expect((await api().get(`/api/v1/fmeas?partId=${ctx.part}`).set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/fmeas?partId=00000000-0000-0000-0000-000000000001').set(h).expect(200)).body.total).toBe(0);
    expect((await api().get('/api/v1/fmeas?kind=design').set(h).expect(200)).body.total).toBe(0);
    expect((await api().get('/api/v1/fmeas?kind=process,design').set(h).expect(200)).body.total).toBe(1);
    const covered = (await api().get(`/api/v1/fmeas?partId=${ctx.part}`).set(h).expect(200)).body.data[0];
    expect(covered.covers).toContain('FM-P1');
    expect((await api().get('/api/v1/fmeas?q=FM-P1').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/fmeas?q=bracket').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/fmeas?q=nothing-like-this').set(h).expect(200)).body.total).toBe(0);
    expect((await api().get('/api/v1/fmeas?status=withdrawn').set(h).expect(200)).body.total).toBe(0);
    expect((await api().get('/api/v1/fmeas?owner=me').set(h).expect(200)).body.total).toBe(1);
    await api().get('/api/v1/fmeas?status=dancing').set(h).expect(400);
    await api().get('/api/v1/fmeas?sort=colour').set(h).expect(400);
  });
});

describe('a new revision, withdrawing and discarding', () => {
  it('starts a revision that copies the team and scope, and needs a summary', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/fmeas/${ctx.fmea}/revisions`).set(await as(ids.inspectorA)).expect(403);
    const started = await api().post(`/api/v1/fmeas/${ctx.fmea}/revisions`).set(h).expect(201);
    expect(started.body.inProgress).toMatchObject({ status: 'draft', letter: null, sequence: 2 });
    ctx.rev2 = started.body.inProgress.id;
    expect((await api().post(`/api/v1/fmeas/${ctx.fmea}/revisions`).set(h).expect(409)).body.error.code).toBe('fmea_rule');
    const rev = (await api().get(`/api/v1/fmea-revisions/${ctx.rev2}`).set(h).expect(200)).body;
    expect(rev.team).toHaveLength(2);
    expect(rev.links).toHaveLength(2);
    expect(rev.previousRevisionId).toBe(ctx.rev);
    expect(rev.net.counts).toMatchObject({ items: 1, functions: 1, failureModes: 1, effects: 1, causes: 1 });
    expect(rev.problems).toEqual(expect.arrayContaining(['Say what changed and why', 'Name the approver']));
  });

  it('discards the draft, then withdraws the FMEA with a reason and starts it again', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/fmea-revisions/${ctx.rev2}/discard`).set(h).send({ reason: 'x' }).expect(400);
    const discarded = await api().post(`/api/v1/fmea-revisions/${ctx.rev2}/discard`).set(h).send({ reason: 'Started by mistake' }).expect(200);
    expect(discarded.body).toMatchObject({ status: 'active', inProgress: null, canStartRevision: true, canWithdraw: true });
    await api().post(`/api/v1/fmeas/${ctx.fmea}/withdraw`).set(await as(QM)).send({ reason: 'x' }).expect(400);
    const withdrawn = await api().post(`/api/v1/fmeas/${ctx.fmea}/withdraw`).set(await as(QM)).send({ reason: 'Product no longer made' }).expect(200);
    expect(withdrawn.body).toMatchObject({ status: 'withdrawn', withdrawReason: 'Product no longer made', nextReviewOn: null, canStartRevision: true });
    expect((await api().get('/api/v1/fmeas').set(h).expect(200)).body.total).toBe(0);
    expect((await api().get('/api/v1/fmeas?status=withdrawn').set(h).expect(200)).body.total).toBe(1);
    const again = await api().post(`/api/v1/fmeas/${ctx.fmea}/revisions`).set(h).expect(201);
    expect(again.body.inProgress.sequence).toBe(3);
  });

  it('changes the title, scope and owner of an FMEA, never its kind', async () => {
    const h = await as(ids.ownerA);
    const res = await api().patch(`/api/v1/fmeas/${ctx.fmea}`).set(h).send({ title: 'Machining of the bracket (line 2)', scopeText: null, reviewMonths: 6 }).expect(200);
    expect(res.body).toMatchObject({ title: 'Machining of the bracket (line 2)', scopeText: null, reviewMonths: 6 });
    await api().patch(`/api/v1/fmeas/${ctx.fmea}`).set(h).send({ kind: 'design' }).expect(400);
    await api().patch(`/api/v1/fmeas/${ctx.fmea}`).set(h).send({}).expect(400);
    await api().patch(`/api/v1/fmeas/${ctx.fmea}`).set(h).send({ ownerId: ids.ownerB }).expect(409);
  });
});

describe('tenancy', () => {
  it('shows another organisation nothing, and answers 404 for its ids', async () => {
    const hb = await as(ids.ownerB, ids.orgB);
    expect((await api().get('/api/v1/fmeas?status=all').set(hb).expect(200)).body.total).toBe(0);
    await api().get(`/api/v1/fmeas/${ctx.fmea}`).set(hb).expect(404);
    await api().get(`/api/v1/fmea-revisions/${ctx.rev}`).set(hb).expect(404);
    await api().post(`/api/v1/fmeas/${ctx.fmea}/revisions`).set(hb).expect(404);
  });
});
