/**
 * FMEA (FM5a) through the API: carrying a cause's control to a control plan characteristic, the coverage report, ending a link, the characteristics offered (with the special
 * class suggestion), what a control plan revision page learns about its characteristics, and a new revision taking the links. The rules themselves are in
 * supabase/tests/fmea_control_links.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a3b');
const QM = 'a3b00000-0000-0000-0000-0000000000e1';
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const today = () => new Date().toISOString().slice(0, 10);
const ctx: Record<string, string> = {};

/* eslint-disable @typescript-eslint/no-explicit-any */
const cause = (rev: any, index = 0) => rev.net.items[0].functions[0].failureModes[index].causes[0];
const q = (text: string, params: unknown[] = []) => admin.query(text, params);
/** One statement as the signed-in owner of Alpha (row-level security and the lifecycle triggers see a person), in its own transaction. */
const qa = async (text: string, params: unknown[] = []) => {
  const client = await admin.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: ids.ownerA, role: 'authenticated' })]);
    await client.query('set local role authenticated');
    const res = await client.query(text, params);
    await client.query('commit');
    return res;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-fl');
  await admin.query(`insert into auth.users (id, email) values ($1, 'qm-fl@example.test')`, [QM]);
  const m = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, QM]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'quality_manager'`, [ids.orgA, m.rows[0].id]);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });

  // A control plan in force (operation OP-020 with a critical characteristic OD and a minor one, VISUAL), another that is only a draft, and one of the other organisation.
  const plan = async (org: string, code: string, run = qa) => (await run(`insert into public.control_plans (organisation_id, plan_code, title) values ($1, $2, $3) returning id`, [org, code, `${code} plan`])).rows[0].id as string;
  ctx.plan = await plan(ids.orgA, 'FL-CP1');
  const rev = (await qa(`insert into public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) values ($1, $2, 'A', 'First') returning id`, [ids.orgA, ctx.plan])).rows[0].id as string;
  const op = (await qa(`insert into public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name) values ($1, $2, 'OP-020', 20, 'Turning') returning id`, [ids.orgA, rev])).rows[0].id as string;
  await qa(`insert into public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, nominal, lower_limit, upper_limit, unit_code, criticality)
           values ($1, $2, $3, 'OD', 'Outer diameter', 25, 24.95, 25.05, 'mm', 'critical')`, [ids.orgA, rev, op]);
  await qa(`insert into public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, data_type) values ($1, $2, $3, 'VISUAL', 'Free from burrs', 'attribute')`, [ids.orgA, rev, op]);
  ctx.planRev = rev;
  for (const status of ['pending_approval', 'approved', 'effective']) await qa(`update public.control_plan_revisions set status = $1 where id = $2`, [status, rev]);

  ctx.planDraft = await plan(ids.orgA, 'FL-CP2');
  const rev2 = (await qa(`insert into public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) values ($1, $2, 'A', 'First') returning id`, [ids.orgA, ctx.planDraft])).rows[0].id as string;
  const op2 = (await qa(`insert into public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name) values ($1, $2, 'OP-050', 50, 'Grinding') returning id`, [ids.orgA, rev2])).rows[0].id as string;
  await qa(`insert into public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, data_type) values ($1, $2, $3, 'FINISH', 'Surface finish', 'attribute')`, [ids.orgA, rev2, op2]);

  ctx.planB = await plan(ids.orgB, 'FL-B1', q);
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const body = (over: object = {}) => ({ controlKind: 'prevention', controlPlanId: ctx.plan, operationCode: 'op-020', characteristicKey: 'OD', ...over });

describe('carrying a control to the control plan', () => {
  it('builds an FMEA with a cause that needs attention and a control, and offers the plan characteristics with the special class suggestion', async () => {
    const h = await as(ids.ownerA);
    const made = await api().post('/api/v1/fmeas').set(h).send({ kind: 'process', title: 'Turning' }).expect(201);
    ctx.fmea = made.body.id;
    ctx.rev = made.body.inProgress.id;
    let rev = (await api().post(`/api/v1/fmea-revisions/${ctx.rev}/items`).set(h).send({ kind: 'item', name: 'Bracket' }).expect(201)).body;
    rev = (await api().post(`/api/v1/fmea-items/${rev.net.items[0].id}/functions`).set(h).send({ text: 'Hold the bore' }).expect(201)).body;
    const fn = rev.net.items[0].functions[0].id;
    rev = (await api().post(`/api/v1/fmea-functions/${fn}/failure-modes`).set(h).send({ text: 'Bore oversize', specialClass: 'critical' }).expect(201)).body;
    const mode = rev.net.items[0].functions[0].failureModes[0].id;
    await api().post(`/api/v1/fmea-failure-modes/${mode}/effects`).set(h).send({ level: 'end_user', text: 'Leaks', severity: 8 }).expect(201);
    rev = (await api().post(`/api/v1/fmea-failure-modes/${mode}/causes`).set(h).send({ text: 'Tool wear', preventionControls: 'Change the tool every 50 parts', occurrence: 8, detection: 8 }).expect(201)).body;
    ctx.cause = cause(rev).id;
    expect(cause(rev)).toMatchObject({ needsAttention: true, controlLinks: [] });
    expect(rev.net.counts.controlLinks).toBe(0);

    const offered = (await api().get(`/api/v1/fmea-plan-characteristics?causeId=${ctx.cause}`).set(h).expect(200)).body;
    expect(offered.available).toBe(true);
    const keys = offered.data.map((c: any) => `${c.plan.code}/${c.operationCode}/${c.characteristicKey}`);
    expect(keys).toEqual(['FL-CP1/OP-020/OD', 'FL-CP1/OP-020/VISUAL', 'FL-CP2/OP-050/FINISH']);
    expect(offered.data.find((c: any) => c.characteristicKey === 'OD')).toMatchObject({ inForce: true, criticality: 'critical', suggestion: null, name: 'Outer diameter' });
    expect(offered.data.find((c: any) => c.characteristicKey === 'VISUAL').suggestion).toMatch(/marked critical, but the plan characteristic is minor/);
    expect(offered.data.find((c: any) => c.characteristicKey === 'FINISH')).toMatchObject({ inForce: false, revisionStatus: 'draft' });
    // searching narrows it; another organisation's plan is never offered
    expect((await api().get('/api/v1/fmea-plan-characteristics?q=grind').set(h).expect(200)).body.data).toHaveLength(1);
    expect((await api().get('/api/v1/fmea-plan-characteristics?q=FL-B1').set(h).expect(200)).body.data).toHaveLength(0);
    expect((await api().get(`/api/v1/fmea-plan-characteristics?planId=${ctx.planB}`).set(h).expect(200)).body.data).toHaveLength(0);
    await api().get(`/api/v1/fmea-plan-characteristics?causeId=${ids.outsider}`).set(h).expect(404);
  });

  it('reports the cause as not covered until a control is carried', async () => {
    const h = await as(ids.ownerA);
    const cov = (await api().get(`/api/v1/fmea-revisions/${ctx.rev}/control-coverage`).set(h).expect(200)).body;
    expect(cov.canReadPlans).toBe(true);
    expect(cov.canCarry).toBe(true);
    expect(cov.totals).toEqual({ needingAttention: 1, covered: 0, unverified: 0, linkProblems: 0, notCovered: 1, coveredPercent: 0 });
    expect(cov.rows[0]).toMatchObject({ id: ctx.cause, status: 'not_covered', failureMode: 'Bore oversize', itemName: 'Bracket', priority: 'high', specialClass: 'critical' });
  });

  it('carries the control, with the plan\'s own spelling, and shows where it stands against the plan', async () => {
    const h = await as(ids.ownerA);
    const rev = (await api().post(`/api/v1/fmea-causes/${ctx.cause}/carry-to-plan`).set(h).send(body({ note: 'Tool life is on the plan' })).expect(201)).body;
    expect(rev.net.counts.controlLinks).toBe(1);
    const link = cause(rev).controlLinks[0];
    expect(link).toMatchObject({
      kind: 'prevention', operationCode: 'OP-020', characteristicKey: 'OD', characteristicName: 'Outer diameter', criticality: 'critical', note: 'Tool life is on the plan',
      state: 'in_plan', carried: false, canEnd: true, plan: { id: ctx.plan, code: 'FL-CP1' },
    });
    ctx.link = link.id;
    const cov = (await api().get(`/api/v1/fmea-revisions/${ctx.rev}/control-coverage`).set(h).expect(200)).body;
    expect(cov.totals).toMatchObject({ covered: 1, notCovered: 0, coveredPercent: 100 });
    expect(cov.rows[0]).toMatchObject({ status: 'covered', links: [{ state: 'in_plan', planCode: 'FL-CP1', operationCode: 'OP-020', characteristicKey: 'OD' }] });
  });

  it('refuses what the database refuses, in words', async () => {
    const h = await as(ids.ownerA);
    const carry = (b: object) => api().post(`/api/v1/fmea-causes/${ctx.cause}/carry-to-plan`).set(h).send(b);
    expect((await carry(body()).expect(409)).body.error).toMatchObject({ code: 'fmea_rule' });
    expect((await carry(body({ controlKind: 'detection' })).expect(409)).body.error.message).toMatch(/Write the detection control/);
    expect((await carry(body({ characteristicKey: 'NOPE' })).expect(409)).body.error.message).toMatch(/no characteristic NOPE at operation/);
    expect((await carry(body({ operationCode: 'OP-999' })).expect(409)).body.error.message).toMatch(/no characteristic OD at operation OP-999/);
    expect((await carry(body({ controlPlanId: ctx.planB })).expect(409)).body.error.message).toMatch(/not in this organisation/);
    await carry(body({ controlKind: 'sorting' })).expect(400);
    await carry(body({ characteristicKey: 'od' })).expect(400);
    await carry(body({ colour: 'red' })).expect(400);
    await carry(body({ controlPlanId: 'not-an-id' })).expect(400);
  });

  it('lets only people who manage FMEAs carry or end a control', async () => {
    const viewer = await as(ids.dual);
    await api().post(`/api/v1/fmea-causes/${ctx.cause}/carry-to-plan`).set(viewer).send(body({ characteristicKey: 'VISUAL' })).expect(403);
    await api().post(`/api/v1/fmea-control-links/${ctx.link}/end`).set(viewer).send({ reason: 'Not mine to end' }).expect(403);
    await api().get('/api/v1/fmea-plan-characteristics').set(viewer).expect(403);
    const stranger = await as(ids.outsider);
    await api().post(`/api/v1/fmea-causes/${ctx.cause}/carry-to-plan`).set(stranger).send(body()).expect(404);
    await api().get(`/api/v1/fmea-revisions/${ctx.rev}/control-coverage`).set(await as(ids.ownerB, ids.orgB)).expect(404);
  });

  it('ends a link with a reason, and the cause is not covered again', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/fmea-control-links/${ctx.link}/end`).set(h).send({ reason: 'no' }).expect(400);
    const rev = (await api().post(`/api/v1/fmea-control-links/${ctx.link}/end`).set(h).send({ reason: 'Tool life is checked elsewhere' }).expect(200)).body;
    expect(cause(rev).controlLinks).toEqual([]);
    expect(rev.net.counts.controlLinks).toBe(0);
    await api().post(`/api/v1/fmea-control-links/${ctx.link}/end`).set(h).send({ reason: 'Again please' }).expect(409);
    expect((await api().get(`/api/v1/fmea-revisions/${ctx.rev}/control-coverage`).set(h).expect(200)).body.totals.notCovered).toBe(1);
    // the ended link stays on record
    expect((await q(`select end_reason from public.fmea_control_links where id = $1`, [ctx.link])).rows[0].end_reason).toBe('Tool life is checked elsewhere');
  });
});

describe('a characteristic that is only on a draft plan', () => {
  it('is on its way, and does not cover the cause until it is in force', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/fmea-causes/${ctx.cause}/carry-to-plan`).set(h).send(body({ controlPlanId: ctx.planDraft, operationCode: 'OP-050', characteristicKey: 'FINISH' })).expect(201);
    const cov = (await api().get(`/api/v1/fmea-revisions/${ctx.rev}/control-coverage`).set(h).expect(200)).body;
    expect(cov.rows[0]).toMatchObject({ status: 'link_problem', links: [{ state: 'not_in_force' }] });
    expect(cov.rows[0].why).toMatch(/only on a draft/);
    // once that revision is in force it covers
    for (const status of ['pending_approval', 'approved', 'effective']) await qa(`update public.control_plan_revisions set status = $1 where control_plan_id = $2`, [status, ctx.planDraft]);
    expect((await api().get(`/api/v1/fmea-revisions/${ctx.rev}/control-coverage`).set(h).expect(200)).body.rows[0].status).toBe('covered');
  });
});

describe('in force, and the other side', () => {
  it('puts the FMEA in force with a control carried, and a newer revision keeps the links and takes the work', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/fmea-causes/${ctx.cause}/carry-to-plan`).set(h).send(body()).expect(201);
    await api().patch(`/api/v1/fmea-causes/${ctx.cause}`).set(h).send({ noActionReason: 'Tool life is carried to the control plan and checked every shift' }).expect(200);
    await api().put(`/api/v1/fmea-revisions/${ctx.rev}/team`).set(h).send({ team: [{ userId: ids.ownerA, role: 'lead' }, { userId: QM, role: 'quality' }] }).expect(200);
    await api().put(`/api/v1/fmea-revisions/${ctx.rev}/links`).set(h).send({ links: [{ kind: 'operation_code', code: 'OP-020' }] }).expect(200);
    await api().put(`/api/v1/fmea-revisions/${ctx.rev}/approver`).set(h).send({ approverId: QM }).expect(200);
    await api().post(`/api/v1/fmea-revisions/${ctx.rev}/submit`).set(h).expect(200);
    await api().post(`/api/v1/fmea-revisions/${ctx.rev}/approve`).set(await as(QM)).send({ effectiveFrom: today() }).expect(200);
    expect((await q(`select status from public.fmea_revisions where id = $1`, [ctx.rev])).rows[0].status).toBe('effective');

    // a link can be made on the revision in force
    const rev = (await api().post(`/api/v1/fmea-causes/${ctx.cause}/carry-to-plan`).set(h).send(body({ characteristicKey: 'VISUAL' })).expect(201)).body;
    expect(cause(rev).controlLinks).toHaveLength(3);
    expect(rev.canAct).toBe(true);

    // a newer revision takes the live links with it; the work belongs there from then on
    const started = (await api().post(`/api/v1/fmeas/${ctx.fmea}/revisions`).set(h).send({ adopt: false }).expect(201)).body;
    ctx.rev2 = started.inProgress?.id ?? started.id;
    const draft = (await api().get(`/api/v1/fmea-revisions/${ctx.rev2}`).set(h).expect(200)).body;
    expect(cause(draft).controlLinks.map((l: any) => `${l.characteristicKey}/${l.carried}`).sort()).toEqual(['FINISH/true', 'OD/true', 'VISUAL/true']);
    expect((await api().post(`/api/v1/fmea-causes/${ctx.cause}/carry-to-plan`).set(h).send(body({ characteristicKey: 'VISUAL' })).expect(409)).body.error.message).toMatch(/newer revision is being prepared/);
  });

  it('tells a control plan revision page which FMEA causes carry a control to its characteristics', async () => {
    const h = await as(ids.ownerA);
    const cover = (await api().get(`/api/v1/control-plan-revisions/${ctx.planRev}/fmea-cover`).set(h).expect(200)).body;
    expect(cover.available).toBe(true);
    const od = cover.data.find((g: any) => g.characteristicKey === 'OD');
    expect(od).toMatchObject({ operationCode: 'OP-020' });
    expect(od.covers).toHaveLength(1);
    expect(od.covers[0]).toMatchObject({ cause: 'Tool wear', failureMode: 'Bore oversize', priority: 'high', needsAttention: true, kind: 'prevention', fmeaNumber: expect.stringMatching(/^FMEA-/), revisionLetter: 'A' });
    // only characteristics of this plan revision are listed (the draft plan's FINISH is another plan)
    expect(cover.data.map((g: any) => g.characteristicKey).sort()).toEqual(['OD', 'VISUAL']);
    await api().get(`/api/v1/control-plan-revisions/${ctx.planRev}/fmea-cover`).set(await as(ids.ownerB, ids.orgB)).expect(404);
    await api().get(`/api/v1/control-plan-revisions/${ids.outsider}/fmea-cover`).set(h).expect(404);
  });
});
