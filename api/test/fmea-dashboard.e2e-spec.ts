/**
 * FMEA (FM6a) through the API: the dashboard (as of today and for a period) and the FMEA area of the home page, which must agree because they share their SQL.
 * The rules for the analysis itself are in fmea-analysis.e2e-spec.ts and supabase/tests/fmea_*.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a8d');
const QM = 'a8d00000-0000-0000-0000-0000000000e1';
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const period = () => `from=${day(-89)}&to=${day(0)}`;
const dashboard = async (user = ids.ownerA, org = ids.orgA) => (await api().get(`/api/v1/fmea-dashboard?${period()}`).set(await as(user, org)).expect(200)).body;
const home = async (user = ids.ownerA, org = ids.orgA) => (await api().get('/api/v1/home-dashboard').set(await as(user, org)).expect(200)).body;
const ctx: Record<string, string> = {};

/* eslint-disable @typescript-eslint/no-explicit-any */
/** An FMEA with one cause that needs attention (S 8, O 8, D 8), an action on it for the inspector, and the quality manager as approver; submitted when `submit`. */
const build = async (title: string, submit: boolean) => {
  const h = await as(ids.ownerA);
  const made = await api().post('/api/v1/fmeas').set(h).send({ kind: 'process', title }).expect(201);
  const fmea = made.body.id as string;
  const rev = made.body.inProgress.id as string;
  let r = (await api().post(`/api/v1/fmea-revisions/${rev}/items`).set(h).send({ kind: 'item', name: 'Bracket' }).expect(201)).body;
  r = (await api().post(`/api/v1/fmea-items/${r.net.items[0].id}/functions`).set(h).send({ text: 'Hold the bore' }).expect(201)).body;
  r = (await api().post(`/api/v1/fmea-functions/${r.net.items[0].functions[0].id}/failure-modes`).set(h).send({ text: 'Bore oversize' }).expect(201)).body;
  const mode = r.net.items[0].functions[0].failureModes[0].id;
  await api().post(`/api/v1/fmea-failure-modes/${mode}/effects`).set(h).send({ level: 'end_user', text: 'Leaks', severity: 8 }).expect(201);
  r = (await api().post(`/api/v1/fmea-failure-modes/${mode}/causes`).set(h).send({ text: 'Tool wear', occurrence: 8, detection: 8 }).expect(201)).body;
  const cause = r.net.items[0].functions[0].failureModes[0].causes[0].id;
  const withAction = (await api().post(`/api/v1/fmea-causes/${cause}/actions`).set(h).send({ kind: 'prevention', description: 'Change the tool every 50 parts', ownerUserId: ids.inspectorA, dueOn: day(30) }).expect(201)).body;
  const action = withAction.net.items[0].functions[0].failureModes[0].causes[0].actions[0].id as string;
  await api().put(`/api/v1/fmea-revisions/${rev}/team`).set(h).send({ team: [{ userId: ids.ownerA, role: 'lead' }, { userId: QM, role: 'quality' }] }).expect(200);
  await api().put(`/api/v1/fmea-revisions/${rev}/links`).set(h).send({ links: [{ kind: 'operation_code', code: 'OP10' }] }).expect(200);
  await api().put(`/api/v1/fmea-revisions/${rev}/approver`).set(h).send({ approverId: QM }).expect(200);
  if (submit) await api().post(`/api/v1/fmea-revisions/${rev}/submit`).set(h).expect(200);
  return { fmea, rev, cause, action };
};
const approve = (rev: string) => async () => api().post(`/api/v1/fmea-revisions/${rev}/approve`).set(await as(QM)).send({ effectiveFrom: day(0) }).expect(200);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-fd');
  await admin.query(`insert into auth.users (id, email) values ($1, 'qm-fd@example.test')`, [QM]);
  const m = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, QM]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'quality_manager'`, [ids.orgA, m.rows[0].id]);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('an organisation with no FMEA', () => {
  it('answers zeros and the home page agrees', async () => {
    const d = await dashboard();
    expect(d.kpis).toMatchObject({ inForce: 0, drafts: 0, awaitingApproval: 0, reviewsOverdue: 0, needAttention: 0, highPriority: 0, openActions: 0, overdueActions: 0 });
    expect(d.byPriority.map((p: any) => p.count)).toEqual([0, 0, 0, 0]);
    expect(d.topCauses).toEqual([]);
    expect((await home()).fmea).toEqual({ inForce: 0, reviewsOverdue: 0, awaitingApproval: 0, overdueActions: 0, highPriority: 0 });
  });
});

describe('with an FMEA in force, one waiting and one draft', () => {
  beforeAll(async () => {
    const inForce = await build('Machining', true);
    await approve(inForce.rev)();
    ctx.fmea = inForce.fmea;
    ctx.rev = inForce.rev;
    ctx.action = inForce.action;
    ctx.cause = inForce.cause;
    ctx.waiting = (await build('Assembly', true)).rev;
    await build('Painting', false);
  });

  it('counts what is in force, what waits and what needs attention', async () => {
    const d = await dashboard();
    expect(d.kpis).toMatchObject({ inForce: 1, drafts: 1, awaitingApproval: 1, needAttention: 1, highPriority: 1, notInPlan: 1, openActions: 3, overdueActions: 0, reviewsOverdue: 0, revisionsApproved: 1, started: 3 });
    expect(d.byPriority).toEqual([{ priority: 'high', count: 1 }, { priority: 'medium', count: 0 }, { priority: 'low', count: 0 }, { priority: 'unrated', count: 0 }]);
    expect(d.byKind).toEqual([{ kind: 'process', count: 1 }]);
    expect(d.topCauses).toHaveLength(1);
    expect(d.topCauses[0]).toMatchObject({ number: 'FMEA-001', failureMode: 'Bore oversize', cause: 'Tool wear', severity: 8, occurrence: 8, detection: 8, rpn: 512, priority: 'high', hasAction: true });
    expect(d.awaitingApproval).toHaveLength(1);
    expect(d.awaitingApproval[0]).toMatchObject({ number: 'FMEA-002', revisionId: ctx.waiting });
    expect(d.trend.reduce((n: number, b: any) => n + b.approved, 0)).toBe(1);
  });

  it('lists late actions and reviews once their dates pass', async () => {
    await admin.query(`update public.fmea_actions set due_on = current_date - 4 where id = $1`, [ctx.action]);
    await admin.query(`update public.fmeas set next_review_on = current_date - 9 where id = $1`, [ctx.fmea]);
    const d = await dashboard();
    expect(d.kpis).toMatchObject({ overdueActions: 1, reviewsOverdue: 1 });
    expect(d.overdueActions[0]).toMatchObject({ id: ctx.action, number: 'FMEA-001', days: 4, description: 'Change the tool every 50 parts' });
    expect(d.reviewsOverdue[0]).toMatchObject({ number: 'FMEA-001', days: 9, kind: 'process' });
  });

  it('is read as the caller: the home page says the same, and a finished action stops being late', async () => {
    let d = await dashboard();
    let h = (await home()).fmea;
    expect(h).toEqual({ inForce: d.kpis.inForce, reviewsOverdue: d.kpis.reviewsOverdue, awaitingApproval: d.kpis.awaitingApproval, overdueActions: d.kpis.overdueActions, highPriority: d.kpis.highPriority });
    await api().post(`/api/v1/fmea-actions/${ctx.action}/complete`).set(await as(ids.inspectorA)).send({ note: 'Tool changed' }).expect(200);
    d = await dashboard();
    h = (await home()).fmea;
    expect(d.kpis).toMatchObject({ overdueActions: 0, actionsDone: 1 });
    expect(h.overdueActions).toBe(0);
  });
});

describe('who may look', () => {
  it('lets a reader in, refuses strangers and a bad period, and keeps organisations apart', async () => {
    expect((await dashboard(ids.inspectorA)).kpis.inForce).toBe(1);
    const other = await dashboard(ids.ownerB, ids.orgB);
    expect(other.kpis).toMatchObject({ inForce: 0, drafts: 0, awaitingApproval: 0 });
    expect((await home(ids.ownerB, ids.orgB)).fmea).toMatchObject({ inForce: 0 });
    await api().get(`/api/v1/fmea-dashboard?${period()}`).set(await as(ids.ownerB, ids.orgA)).expect(404);
    await api().get(`/api/v1/fmea-dashboard?${period()}`).set({ 'X-Organisation-Id': ids.orgA }).expect(401);
    await api().get(`/api/v1/fmea-dashboard?from=${day(0)}&to=${day(-5)}`).set(await as(ids.ownerA)).expect(400);
    await api().get('/api/v1/fmea-dashboard').set(await as(ids.ownerA)).expect(400);
  });
});
