/**
 * FMEA (FM4) through the API: actions on causes (who may add, finish and reopen), the revised figures the database works out, My actions, adopting finished actions into a
 * new revision, comparing revisions, the changes in a base, and the periodic review. The rules themselves are in supabase/tests/fmea_actions.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a2f');
const QM = 'a2f00000-0000-0000-0000-0000000000e1';
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const ctx: Record<string, string> = {};

/* eslint-disable @typescript-eslint/no-explicit-any */
const cause = (rev: any) => rev.net.items[0].functions[0].failureModes[0].causes[0];

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-fa');
  await admin.query(`insert into auth.users (id, email) values ($1, 'qm-fa@example.test')`, [QM]);
  const m = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, QM]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'quality_manager'`, [ids.orgA, m.rows[0].id]);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('actions on a cause', () => {
  it('builds a cause that needs attention and gives an action to a member who only reads', async () => {
    const h = await as(ids.ownerA);
    const made = await api().post('/api/v1/fmeas').set(h).send({ kind: 'process', title: 'Machining' }).expect(201);
    ctx.fmea = made.body.id;
    ctx.rev = made.body.inProgress.id;
    let rev = (await api().post(`/api/v1/fmea-revisions/${ctx.rev}/items`).set(h).send({ kind: 'item', name: 'Bracket' }).expect(201)).body;
    const item = rev.net.items[0].id;
    rev = (await api().post(`/api/v1/fmea-items/${item}/functions`).set(h).send({ text: 'Hold the bore' }).expect(201)).body;
    const fn = rev.net.items[0].functions[0].id;
    rev = (await api().post(`/api/v1/fmea-functions/${fn}/failure-modes`).set(h).send({ text: 'Bore oversize' }).expect(201)).body;
    const mode = rev.net.items[0].functions[0].failureModes[0].id;
    await api().post(`/api/v1/fmea-failure-modes/${mode}/effects`).set(h).send({ level: 'end_user', text: 'Leaks', severity: 8 }).expect(201);
    rev = (await api().post(`/api/v1/fmea-failure-modes/${mode}/causes`).set(h).send({ text: 'Tool wear', occurrence: 8, detection: 8 }).expect(201)).body;
    ctx.cause = cause(rev).id;
    expect(cause(rev)).toMatchObject({ rpn: 512, priority: 'high', needsAttention: true, actions: [] });
    expect(rev.problems.join(' ')).toMatch(/needs attention/);

    const added = (
      await api().post(`/api/v1/fmea-causes/${ctx.cause}/actions`).set(h).send({ kind: 'prevention', description: 'Change the tool every 50 parts', ownerUserId: ids.inspectorA, dueOn: inDays(30) }).expect(201)
    ).body;
    expect(cause(added).actions).toHaveLength(1);
    expect(cause(added).actions[0]).toMatchObject({ kind: 'prevention', status: 'open', carried: false, adopted: false, canEdit: true, canComplete: true, isMine: false });
    expect(cause(added).actions[0].owner).toMatchObject({ kind: 'member', id: ids.inspectorA });
    ctx.action = cause(added).actions[0].id;
    expect(added.net.counts).toMatchObject({ openActions: 1, doneActions: 0, overdueActions: 0 });
    // a live action answers "no control" and "needs attention"
    expect(added.problems.join(' ')).not.toMatch(/needs attention|no prevention or detection control/);
  });

  it('refuses what the database refuses, in words', async () => {
    const h = await as(ids.ownerA);
    const bad = (body: object) => api().post(`/api/v1/fmea-causes/${ctx.cause}/actions`).set(h).send(body);
    const ok = { kind: 'detection', description: 'Gauge every part', ownerUserId: ids.inspectorA, dueOn: inDays(10) };
    expect((await bad({ ...ok, dueOn: inDays(-3) }).expect(409)).body.error).toMatchObject({ code: 'fmea_rule' });
    expect((await bad({ ...ok, ownerUserId: undefined }).expect(409)).body.error.message).toMatch(/member or to an employee/);
    expect((await bad({ ...ok, ownerUserId: ids.ownerB }).expect(409)).body.error.message).toMatch(/active member of this organisation/);
    await bad({ ...ok, kind: 'sorting' }).expect(400);
    await bad({ ...ok, colour: 'red' }).expect(400);
    await bad({ ...ok, description: 'ok' }).expect(400);
    await bad({ ...ok, dueOn: 'next week' }).expect(400);
  });

  it('lets the person it is given to finish it with only the read right, and works out the revised figures', async () => {
    const reader = await as(ids.inspectorA);
    const mine = (await api().get('/api/v1/fmea-actions/mine').set(reader).expect(200)).body;
    expect(mine).toMatchObject({ openCount: 1, overdueCount: 0 });
    expect(mine.data[0]).toMatchObject({ id: ctx.action, fmeaNumber: 'FMEA-001', fmeaTitle: 'Machining', status: 'open' });
    // they may not change or cancel it
    await api().patch(`/api/v1/fmea-actions/${ctx.action}`).set(reader).send({ description: 'Something else' }).expect(403);
    await api().post(`/api/v1/fmea-actions/${ctx.action}/cancel`).set(reader).send({ reason: 'No longer needed' }).expect(403);
    await api().post(`/api/v1/fmea-causes/${ctx.cause}/actions`).set(reader).send({ kind: 'detection', description: 'Mine too', ownerUserId: ids.inspectorA, dueOn: inDays(5) }).expect(403);
    // findings are needed; ratings are 1 to 10
    await api().post(`/api/v1/fmea-actions/${ctx.action}/complete`).set(reader).send({ note: '' }).expect(400);
    await api().post(`/api/v1/fmea-actions/${ctx.action}/complete`).set(reader).send({ note: 'Tool changed', revisedOccurrence: 11 }).expect(400);
    const done = (await api().post(`/api/v1/fmea-actions/${ctx.action}/complete`).set(reader).send({ note: 'Tool changed every 50 parts', revisedOccurrence: 3 }).expect(200)).body;
    expect(done).toMatchObject({ id: ctx.action, status: 'done', revisedOccurrence: 3 });
    expect((await api().get('/api/v1/fmea-actions/mine?status=done').set(reader).expect(200)).body.data[0]).toMatchObject({ revisedRpn: 192, revisedPriority: 'medium', status: 'done' });
    // a manager sees the figures worked out by the database
    const rev = (await api().get(`/api/v1/fmea-revisions/${ctx.rev}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(cause(rev).actions[0]).toMatchObject({ status: 'done', revisedRpn: 192, revisedPriority: 'medium', revisedNeedsAttention: false, canReopen: true, canComplete: false });
    expect(rev.net.counts).toMatchObject({ openActions: 0, doneActions: 1 });
    // reopened, then finished again
    const reopened = (await api().post(`/api/v1/fmea-actions/${ctx.action}/reopen`).set(reader).expect(200)).body;
    expect(reopened).toMatchObject({ status: 'open', evidenceNote: null, revisedRpn: null });
    await api().post(`/api/v1/fmea-actions/${ctx.action}/complete`).set(reader).send({ note: 'Tool changed every 50 parts', revisedOccurrence: 3 }).expect(200);
    // a stranger to the organisation is told nothing exists
    await api().post(`/api/v1/fmea-actions/${ctx.action}/reopen`).set(await as(ids.outsider)).expect(404);
  });

  it('changes and cancels an open action (a manager), and the owner is told', async () => {
    const h = await as(ids.ownerA);
    const extra = (
      await api().post(`/api/v1/fmea-causes/${ctx.cause}/actions`).set(h).send({ kind: 'detection', description: 'Gauge every part at OP10', ownerUserId: ids.inspectorA, dueOn: inDays(20) }).expect(201)
    ).body;
    const id = cause(extra).actions.find((a: any) => a.kind === 'detection').id;
    const edited = (await api().patch(`/api/v1/fmea-actions/${id}`).set(h).send({ description: 'Gauge every part at OP10 and OP20', dueOn: inDays(40) }).expect(200)).body;
    expect(edited).toMatchObject({ id, description: 'Gauge every part at OP10 and OP20', dueOn: inDays(40), status: 'open' });
    await api().patch(`/api/v1/fmea-actions/${id}`).set(h).send({}).expect(400);
    await api().post(`/api/v1/fmea-actions/${id}/cancel`).set(h).send({ reason: 'x' }).expect(400);
    expect((await api().post(`/api/v1/fmea-actions/${id}/cancel`).set(h).send({ reason: 'The gauge went out for repair' }).expect(200)).body).toMatchObject({ status: 'cancelled', cancelReason: 'The gauge went out for repair' });
    await api().patch(`/api/v1/fmea-actions/${id}`).set(h).send({ description: 'Too late now' }).expect(409);
    const notices = await admin.query(`select count(*)::int as n from public.notifications where entity_type = 'fmea_actions' and recipient_user_id = $1`, [ids.inspectorA]);
    expect(notices.rows[0].n).toBe(2);
  });
});

describe('a new revision', () => {
  it('can take the finished actions in, and says how many it could', async () => {
    const h = await as(ids.ownerA);
    await api().put(`/api/v1/fmea-revisions/${ctx.rev}/team`).set(h).send({ team: [{ userId: ids.ownerA, role: 'lead' }, { userId: QM, role: 'quality' }] }).expect(200);
    await api().put(`/api/v1/fmea-revisions/${ctx.rev}/links`).set(h).send({ links: [{ kind: 'operation_code', code: 'OP10' }] }).expect(200);
    await api().put(`/api/v1/fmea-revisions/${ctx.rev}/approver`).set(h).send({ approverId: QM }).expect(200);
    await api().post(`/api/v1/fmea-revisions/${ctx.rev}/submit`).set(h).expect(200);
    await api().post(`/api/v1/fmea-revisions/${ctx.rev}/approve`).set(await as(QM)).send({ effectiveFrom: today() }).expect(200);
    // started from the base before the base moves on
    const child = await api().post('/api/v1/fmeas').set(h).send({ kind: 'process', title: 'Machining (customer B)', baseFmeaId: ctx.fmea }).expect(201);
    ctx.child = child.body.inProgress.id;
    const detail = (await api().get(`/api/v1/fmeas/${ctx.fmea}`).set(h).expect(200)).body;
    expect(detail).toMatchObject({ adoptableActions: 1, canReview: true, reviews: [] });

    const started = (await api().post(`/api/v1/fmeas/${ctx.fmea}/revisions`).set(h).send({ adopt: true }).expect(201)).body;
    ctx.rev2 = started.inProgress.id;
    const copy = (await api().get(`/api/v1/fmea-revisions/${ctx.rev2}`).set(h).expect(200)).body;
    expect(cause(copy)).toMatchObject({ occurrence: 3, rpn: 192, priority: 'medium', preventionControls: 'Change the tool every 50 parts' });
    expect(((await api().get(`/api/v1/fmeas/${ctx.fmea}`).set(h).expect(200)).body as any).adoptableActions).toBe(0);
    await api().post(`/api/v1/fmeas/${ctx.fmea}/revisions`).set(h).send({ adopt: 'yes' }).expect(400);
  });

  it('compares itself with the revision before it, row by row', async () => {
    const h = await as(ids.ownerA);
    const diff = (await api().get(`/api/v1/fmea-revisions/${ctx.rev2}/compare`).set(h).expect(200)).body;
    expect(diff).toMatchObject({ comparable: true, older: { id: ctx.rev, letter: 'A' }, newer: { id: ctx.rev2 } });
    expect(diff.counts).toMatchObject({ added: 0, removed: 0, changed: 1 });
    const changed = diff.changes[0];
    expect(changed).toMatchObject({ kind: 'cause', change: 'changed', label: 'Tool wear', path: ['Bracket', 'Hold the bore', 'Bore oversize'] });
    expect(changed.fields.map((f: any) => f.field)).toEqual(expect.arrayContaining(['occurrence', 'rpn', 'preventionControls']));
    expect(changed.fields.find((f: any) => f.field === 'occurrence')).toEqual({ field: 'occurrence', from: 8, to: 3 });
    // the first revision has nothing before it; a revision cannot be compared with a later one or with another FMEA's
    expect((await api().get(`/api/v1/fmea-revisions/${ctx.rev}/compare`).set(h).expect(200)).body).toMatchObject({ comparable: false });
    await api().get(`/api/v1/fmea-revisions/${ctx.rev}/compare?with=${ctx.rev2}`).set(h).expect(400);
    await api().get(`/api/v1/fmea-revisions/${ctx.rev2}/compare?with=${ctx.child}`).set(h).expect(400);
    await api().get(`/api/v1/fmea-revisions/${ctx.rev2}/compare?with=nope`).set(h).expect(400);
  });

  it('tells a part FMEA what has changed in its base since it was copied', async () => {
    const h = await as(ids.ownerA);
    const quiet = (await api().get(`/api/v1/fmea-revisions/${ctx.child}/base-changes`).set(h).expect(200)).body;
    expect(quiet).toMatchObject({ hasBase: true, readable: true, moved: false, base: { number: 'FMEA-001', copiedLetter: 'A' } });
    // the base moves on to revision B
    await api().patch(`/api/v1/fmea-revisions/${ctx.rev2}`).set(h).send({ changeSummary: 'Tool change schedule revised' }).expect(200);
    await api().put(`/api/v1/fmea-revisions/${ctx.rev2}/approver`).set(h).send({ approverId: QM }).expect(200);
    await api().post(`/api/v1/fmea-revisions/${ctx.rev2}/submit`).set(h).expect(200);
    await api().post(`/api/v1/fmea-revisions/${ctx.rev2}/approve`).set(await as(QM)).send({ effectiveFrom: today() }).expect(200);
    const moved = (await api().get(`/api/v1/fmea-revisions/${ctx.child}/base-changes`).set(h).expect(200)).body;
    expect(moved).toMatchObject({ hasBase: true, readable: true, moved: true, base: { copiedLetter: 'A', currentLetter: 'B' } });
    expect(moved.counts).toMatchObject({ changed: 1, added: 0, removed: 0 });
    expect(moved.changes[0]).toMatchObject({ label: 'Tool wear', change: 'changed' });
    // an FMEA with no base has nothing to show
    expect((await api().get(`/api/v1/fmea-revisions/${ctx.rev}/base-changes`).set(h).expect(200)).body).toEqual({ hasBase: false });
  });
});

describe('the periodic review', () => {
  it('records "no change needed" with a note, and "revision started"', async () => {
    const h = await as(ids.ownerA);
    expect((await api().post(`/api/v1/fmeas/${ctx.fmea}/reviews`).set(h).send({ outcome: 'no_change' }).expect(409)).body.error.code).toBe('fmea_rule');
    await api().post(`/api/v1/fmeas/${ctx.fmea}/reviews`).set(h).send({ outcome: 'looked' }).expect(400);
    await api().post(`/api/v1/fmeas/${ctx.fmea}/reviews`).set(h).send({ outcome: 'no_change', note: 'x', colour: 'red' }).expect(400);
    const done = (await api().post(`/api/v1/fmeas/${ctx.fmea}/reviews`).set(h).send({ outcome: 'no_change', note: 'Checked the ratings against this year\'s scrap data' }).expect(201)).body;
    expect(done.reviews).toHaveLength(1);
    expect(done.reviews[0]).toMatchObject({ outcome: 'no_change', revisionLetter: 'B', by: { id: ids.ownerA } });
    expect(new Date(done.nextReviewOn).getTime()).toBeGreaterThan(Date.now() + 300 * 86400000);
    const started = (await api().post(`/api/v1/fmeas/${ctx.fmea}/reviews`).set(h).send({ outcome: 'revision_started' }).expect(201)).body;
    expect(started.inProgress).toMatchObject({ status: 'draft' });
    expect(started.reviews).toHaveLength(2);
    await api().post(`/api/v1/fmeas/${ctx.fmea}/reviews`).set(await as(ids.inspectorA)).send({ outcome: 'no_change', note: 'Looks right' }).expect(403);
  });
});

describe('another organisation', () => {
  it('sees nothing and answers 404 for these ids', async () => {
    const hb = await as(ids.ownerB, ids.orgB);
    await api().post(`/api/v1/fmea-causes/${ctx.cause}/actions`).set(hb).send({ kind: 'detection', description: 'Gauge every part', ownerUserId: ids.ownerB, dueOn: inDays(5) }).expect(404);
    await api().patch(`/api/v1/fmea-actions/${ctx.action}`).set(hb).send({ description: 'Hijacked' }).expect(404);
    await api().post(`/api/v1/fmea-actions/${ctx.action}/complete`).set(hb).send({ note: 'Hijacked' }).expect(404);
    await api().post(`/api/v1/fmea-actions/${ctx.action}/reopen`).set(hb).expect(404);
    await api().get(`/api/v1/fmea-revisions/${ctx.rev2}/compare`).set(hb).expect(404);
    await api().get(`/api/v1/fmea-revisions/${ctx.child}/base-changes`).set(hb).expect(404);
    await api().post(`/api/v1/fmeas/${ctx.fmea}/reviews`).set(hb).send({ outcome: 'no_change', note: 'Hijacked' }).expect(404);
    expect((await api().get('/api/v1/fmea-actions/mine').set(hb).expect(200)).body).toMatchObject({ data: [], openCount: 0 });
  });
});
