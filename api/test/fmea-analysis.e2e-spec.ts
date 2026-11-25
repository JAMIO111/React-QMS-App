/**
 * FMEA (FM3) through the API: building the analysis net node by node, the scores the database works out, the errors in words, the model a revision is
 * rated with, starting an FMEA from a base, and who may do what. The rules themselves are in supabase/tests/fmea_analysis.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a1f');
const QM = 'a1f00000-0000-0000-0000-0000000000e1';
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const today = () => new Date().toISOString().slice(0, 10);
const ctx: Record<string, string> = {};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-fn');
  await admin.query(`insert into auth.users (id, email) values ($1, 'qm-fn@example.test')`, [QM]);
  const m = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, QM]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'quality_manager'`, [ids.orgA, m.rows[0].id]);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

type Net = { items: any[]; counts: Record<string, number> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const net = (res: { body: { net: Net } }) => res.body.net;

describe('building the analysis', () => {
  it('starts with a draft and an empty net, and a model to rate with', async () => {
    const h = await as(ids.ownerA);
    const made = await api().post('/api/v1/fmeas').set(h).send({ kind: 'process', title: 'Machining' }).expect(201);
    ctx.fmea = made.body.id;
    ctx.rev = made.body.inProgress.id;
    const rev = (await api().get(`/api/v1/fmea-revisions/${ctx.rev}`).set(h).expect(200)).body;
    expect(rev.net).toEqual({ items: [], counts: { items: 0, functions: 0, failureModes: 0, effects: 0, causes: 0, needAttention: 0, unrated: 0, openActions: 0, doneActions: 0, overdueActions: 0, controlLinks: 0 } });
    expect(rev.model).toMatchObject({ version: 1, method: 'rpn', isLatest: true, rpnHighFrom: 200, rpnMediumFrom: 100, severityFloor: 9 });
    expect(rev.model.scale.severity).toHaveLength(10);
    expect(rev.base).toBeNull();
  });

  it('adds a structure, each kind in its place, and says what is wrong in words', async () => {
    const h = await as(ids.ownerA);
    const bad = await api().post(`/api/v1/fmea-revisions/${ctx.rev}/items`).set(h).send({ kind: 'system', name: 'x' }).expect(409);
    expect(bad.body.error).toMatchObject({ code: 'fmea_rule' });
    expect(bad.body.error.message).toMatch(/process FMEA has/);
    await api().post(`/api/v1/fmea-revisions/${ctx.rev}/items`).set(h).send({ kind: 'step', name: 'x' }).expect(409);
    await api().post(`/api/v1/fmea-revisions/${ctx.rev}/items`).set(h).send({ kind: 'robot', name: 'x' }).expect(400);
    await api().post(`/api/v1/fmea-revisions/${ctx.rev}/items`).set(h).send({ kind: 'item', name: 'x', colour: 'red' }).expect(400);
    const top = net(await api().post(`/api/v1/fmea-revisions/${ctx.rev}/items`).set(h).send({ kind: 'item', name: 'Bracket machining' }).expect(201));
    ctx.item = top.items[0].id;
    const step = net(await api().post(`/api/v1/fmea-revisions/${ctx.rev}/items`).set(h).send({ kind: 'step', name: 'OP10 Turn', parentId: ctx.item, operationCode: 'OP10' }).expect(201));
    ctx.step = step.items[0].children[0].id;
    const el = net(await api().post(`/api/v1/fmea-revisions/${ctx.rev}/items`).set(h).send({ kind: 'element', name: 'Lathe', parentId: ctx.step, elementType: 'machine' }).expect(201));
    expect(el.items[0].children[0].children[0]).toMatchObject({ kind: 'element', elementType: 'machine', name: 'Lathe', fromBase: false });
    ctx.element = el.items[0].children[0].children[0].id;
    const renamed = net(await api().patch(`/api/v1/fmea-items/${ctx.element}`).set(h).send({ name: 'CNC lathe' }).expect(200));
    expect(renamed.items[0].children[0].children[0].name).toBe('CNC lathe');
    await api().patch(`/api/v1/fmea-items/${ctx.element}`).set(h).send({ kind: 'item' }).expect(400);
    await api().patch(`/api/v1/fmea-items/${ctx.element}`).set(h).send({}).expect(400);
  });

  it('rates a cause and lets the database work out RPN and priority', async () => {
    const h = await as(ids.ownerA);
    const fn = net(await api().post(`/api/v1/fmea-items/${ctx.step}/functions`).set(h).send({ text: 'Turn the bore to 25.00 ±0.05', characteristicKey: 'bore' }).expect(201));
    ctx.fn = fn.items[0].children[0].functions[0].id;
    const mode = net(await api().post(`/api/v1/fmea-functions/${ctx.fn}/failure-modes`).set(h).send({ text: 'Bore oversize', specialClass: 'critical' }).expect(201));
    ctx.mode = mode.items[0].children[0].functions[0].failureModes[0].id;
    expect(mode.items[0].children[0].functions[0].failureModes[0].specialClass).toBe('critical');
    const e1 = net(await api().post(`/api/v1/fmea-failure-modes/${ctx.mode}/effects`).set(h).send({ level: 'own_plant', text: 'Scrap', severity: 4 }).expect(201));
    ctx.effect = e1.items[0].children[0].functions[0].failureModes[0].effects[0].id;
    await api().post(`/api/v1/fmea-failure-modes/${ctx.mode}/effects`).set(h).send({ level: 'end_user', text: 'Leaks in service', severity: 8 }).expect(201);
    const cause = net(await api().post(`/api/v1/fmea-failure-modes/${ctx.mode}/causes`).set(h).send({ text: 'Tool wear', preventionControls: 'Tool life counter', occurrence: 5, detection: 6 }).expect(201));
    const c = cause.items[0].children[0].functions[0].failureModes[0].causes[0];
    ctx.cause = c.id;
    // the worst effect decides: 8 x 5 x 6 = 240, over the neutral model's 200
    expect(c).toMatchObject({ severityUsed: 8, rpn: 240, priority: 'high', needsAttention: true });
    expect(cause.counts).toMatchObject({ causes: 1, needAttention: 1, unrated: 0 });
    // removing the severe effect scores it again
    const severe = cause.items[0].children[0].functions[0].failureModes[0].effects.find((e: { severity: number }) => e.severity === 8).id;
    const lower = net(await api().delete(`/api/v1/fmea-effects/${severe}`).set(h).expect(200));
    expect(lower.items[0].children[0].functions[0].failureModes[0].causes[0]).toMatchObject({ severityUsed: 4, rpn: 120, priority: 'medium', needsAttention: false });
    // a client cannot send what the database works out
    await api().patch(`/api/v1/fmea-causes/${ctx.cause}`).set(h).send({ rpn: 1 }).expect(400);
    const cleared = net(await api().patch(`/api/v1/fmea-causes/${ctx.cause}`).set(h).send({ occurrence: null }).expect(200));
    expect(cleared.items[0].children[0].functions[0].failureModes[0].causes[0]).toMatchObject({ rpn: null, priority: null, needsAttention: null });
    expect(cleared.counts.unrated).toBe(1);
    await api().patch(`/api/v1/fmea-causes/${ctx.cause}`).set(h).send({ occurrence: 11 }).expect(400);
    await api().patch(`/api/v1/fmea-causes/${ctx.cause}`).set(h).send({ occurrence: 5 }).expect(200);
  });

  it('lists what is still needed, in words, until the draft is ready to submit', async () => {
    const h = await as(ids.ownerA);
    const rev = (await api().get(`/api/v1/fmea-revisions/${ctx.rev}`).set(h).expect(200)).body;
    expect(rev.problems).toEqual(expect.arrayContaining([expect.stringMatching(/with nothing below them have no function|no function/)]));
    // Bracket machining (item) has a step below it, so only the work element needs a function
    await api().delete(`/api/v1/fmea-items/${ctx.element}`).set(h).expect(200);
    const after = (await api().get(`/api/v1/fmea-revisions/${ctx.rev}`).set(h).expect(200)).body;
    expect(after.problems.join(' ')).not.toMatch(/no function/);
  });

  it('refuses to edit what is submitted and says why', async () => {
    const h = await as(ids.ownerA);
    await api().put(`/api/v1/fmea-revisions/${ctx.rev}/team`).set(h).send({ team: [{ userId: ids.ownerA, role: 'lead' }, { userId: QM, role: 'quality' }] }).expect(200);
    await api().put(`/api/v1/fmea-revisions/${ctx.rev}/links`).set(h).send({ links: [{ kind: 'operation_code', code: 'OP10' }] }).expect(200);
    await api().put(`/api/v1/fmea-revisions/${ctx.rev}/approver`).set(h).send({ approverId: QM }).expect(200);
    await api().patch(`/api/v1/fmea-causes/${ctx.cause}`).set(h).send({ detectionControls: 'In-process gauging every tenth part' }).expect(200);
    const ready = (await api().get(`/api/v1/fmea-revisions/${ctx.rev}`).set(h).expect(200)).body;
    expect(ready.problems).toEqual([]);
    await api().post(`/api/v1/fmea-revisions/${ctx.rev}/submit`).set(h).expect(200);
    const refused = await api().patch(`/api/v1/fmea-causes/${ctx.cause}`).set(h).send({ text: 'Changed' }).expect(409);
    expect(refused.body.error).toMatchObject({ code: 'fmea_rule' });
    expect(refused.body.error.message).toMatch(/can no longer be edited/);
    await api().post(`/api/v1/fmea-revisions/${ctx.rev}/items`).set(h).send({ kind: 'item', name: 'x' }).expect(409);
    await api().delete(`/api/v1/fmea-causes/${ctx.cause}`).set(h).expect(409);
    await api().post(`/api/v1/fmea-revisions/${ctx.rev}/approve`).set(await as(QM)).send({ effectiveFrom: today() }).expect(200);
  });
});

describe('who may', () => {
  it('lets a reader read the analysis of an FMEA in force and not change it', async () => {
    const h = await as(ids.inspectorA);
    const rev = (await api().get(`/api/v1/fmea-revisions/${ctx.rev}`).set(h).expect(200)).body;
    expect(rev.net.counts.causes).toBe(1);
    expect(rev.canEdit).toBe(false);
    await api().patch(`/api/v1/fmea-causes/${ctx.cause}`).set(h).send({ text: 'x' }).expect(403);
    await api().post(`/api/v1/fmea-revisions/${ctx.rev}/items`).set(h).send({ kind: 'item', name: 'x' }).expect(403);
    await api().delete(`/api/v1/fmea-causes/${ctx.cause}`).set(h).expect(403);
    await api().post(`/api/v1/fmea-revisions/${ctx.rev}/use-latest-model`).set(h).expect(403);
  });

  it('shows another organisation nothing, and answers 404 for its ids', async () => {
    const hb = await as(ids.ownerB, ids.orgB);
    await api().patch(`/api/v1/fmea-causes/${ctx.cause}`).set(hb).send({ text: 'x' }).expect(404);
    await api().delete(`/api/v1/fmea-items/${ctx.step}`).set(hb).expect(404);
    await api().post(`/api/v1/fmea-failure-modes/${ctx.mode}/causes`).set(hb).send({ text: 'x' }).expect(404);
    await api().post(`/api/v1/fmea-revisions/${ctx.rev}/items`).set(hb).send({ kind: 'item', name: 'x' }).expect(404);
  });
});

describe('a new revision and the rating model', () => {
  it('copies the net, and a draft can move to the latest model', async () => {
    const h = await as(ids.ownerA);
    const started = await api().post(`/api/v1/fmeas/${ctx.fmea}/revisions`).set(h).expect(201);
    ctx.rev2 = started.body.inProgress.id;
    const copy = (await api().get(`/api/v1/fmea-revisions/${ctx.rev2}`).set(h).expect(200)).body;
    expect(copy.net.counts).toMatchObject({ items: 2, functions: 1, failureModes: 1, effects: 1, causes: 1 });
    expect(copy.net.items[0].children[0].functions[0].failureModes[0].causes[0]).toMatchObject({ rpn: 120, priority: 'medium' });
    expect(copy.model).toMatchObject({ version: 1, isLatest: true });
    // a stricter model: high from an RPN of 100
    const config = (await api().get('/api/v1/fmea-model').set(h).expect(200)).body.config;
    await api().put('/api/v1/fmea-model').set(h).send({ config: { ...config, rpnHighFrom: 100, rpnMediumFrom: 50 }, reason: 'Tighter thresholds' }).expect(200);
    const stale = (await api().get(`/api/v1/fmea-revisions/${ctx.rev2}`).set(h).expect(200)).body;
    expect(stale.model).toMatchObject({ version: 1, isLatest: false, latestVersion: 2 });
    expect(stale.net.items[0].children[0].functions[0].failureModes[0].causes[0].priority).toBe('medium');
    const moved = (await api().post(`/api/v1/fmea-revisions/${ctx.rev2}/use-latest-model`).set(h).expect(200)).body;
    expect(moved.model).toMatchObject({ version: 2, isLatest: true, rpnHighFrom: 100 });
    expect(moved.net.items[0].children[0].functions[0].failureModes[0].causes[0]).toMatchObject({ rpn: 120, priority: 'high' });
    // the revision in force keeps the model it was approved on
    expect((await api().get(`/api/v1/fmea-revisions/${ctx.rev}`).set(h).expect(200)).body.model.version).toBe(1);
    expect((await api().post(`/api/v1/fmea-revisions/${ctx.rev}/use-latest-model`).set(h).expect(409)).body.error.code).toBe('fmea_rule');
  });
});

describe('starting from a base', () => {
  it('copies the analysis of an FMEA in force and remembers where it came from', async () => {
    const h = await as(ids.ownerA);
    const child = await api().post('/api/v1/fmeas').set(h).send({ kind: 'process', title: 'Machining (customer B)', baseFmeaId: ctx.fmea }).expect(201);
    expect(child.body.baseFmeaId).toBe(ctx.fmea);
    const rev = (await api().get(`/api/v1/fmea-revisions/${child.body.inProgress.id}`).set(h).expect(200)).body;
    expect(rev.base).toMatchObject({ fmeaId: ctx.fmea, number: 'FMEA-001', letter: 'A', revisionId: ctx.rev });
    expect(rev.net.counts).toMatchObject({ items: 2, causes: 1 });
    expect(rev.net.items[0].fromBase).toBe(true);
    expect(rev.net.items[0].children[0].functions[0].failureModes[0].causes[0].fromBase).toBe(true);
    // a base must be of the same kind and in force
    const design = await api().post('/api/v1/fmeas').set(h).send({ kind: 'design', title: 'x', baseFmeaId: ctx.fmea }).expect(409);
    expect(design.body.error.code).toBe('fmea_rule');
    const draftOnly = (await api().post('/api/v1/fmeas').set(h).send({ kind: 'process', title: 'Draft only' }).expect(201)).body;
    await api().post('/api/v1/fmeas').set(h).send({ kind: 'process', title: 'x', baseFmeaId: draftOnly.id }).expect(409);
    await api().post('/api/v1/fmeas').set(await as(ids.inspectorA)).send({ kind: 'process', title: 'x', baseFmeaId: ctx.fmea }).expect(403);
    await api().post('/api/v1/fmeas').set(h).send({ kind: 'process', title: 'x', baseFmeaId: 'not-a-uuid' }).expect(400);
  });
});
