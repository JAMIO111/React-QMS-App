/**
 * DOC2 through the API: recipients fixed at issue, preview, viewed and acknowledged tracking, My alerts and the menu count,
 * adding people later, overdue, withdrawal, revisions asking again, permissions and isolation.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a9');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const TODAY = new Date().toISOString().slice(0, 10);
const TOMORROW = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-qrecipients');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  ctx.gi = (await api().post('/api/v1/departments').set(h).send({ siteId: ids.siteA, code: 'GI', name: 'Goods-in' }).expect(201)).body.id;
  ctx.empty = (await api().post('/api/v1/departments').set(h).send({ siteId: ids.siteA, code: 'MC', name: 'Machining' }).expect(201)).body.id;
  const members = (await api().get('/api/v1/members').set(h).expect(200)).body.data as { userId: string; membershipId: string }[];
  const mid = (user: string) => members.find((m) => m.userId === user)!.membershipId;
  ctx.mOwner = mid(ids.ownerA);
  ctx.mInspector = mid(ids.inspectorA);
  ctx.mDual = mid(ids.dual);
  ctx.mSuspended = mid(ids.suspendedA);
  await admin.query(`insert into public.department_members (organisation_id, department_id, membership_id) values ($1, $2, $3)`, [ids.orgA, ctx.gi, ctx.mInspector]);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const draft = async (title: string, scope: object, extra: object = {}) =>
  (await api().post('/api/v1/quality-alerts').set(await as(ids.ownerA)).send({
    title, category: 'supplier', severity: 'high', description: 'd', actions: [{ description: 'a' }], effectiveDate: TODAY, acknowledgeBy: TOMORROW, scope, ...extra,
  }).expect(201)).body;
const mine = async (user: string) => (await api().get('/api/v1/quality-alerts/mine').set(await as(user)).expect(200)).body;
const count = async (user: string) => (await api().get('/api/v1/quality-alerts/mine/count').set(await as(user)).expect(200)).body;

describe('before issuing', () => {
  it('previews how many people each target reaches, and refuses an alert that reaches nobody', async () => {
    const owner = await as(ids.ownerA);
    const a = await draft('Wrong spec on bar stock', { targets: [{ departmentId: ctx.empty }] });
    ctx.a = a.id;
    const nobody = (await api().get(`/api/v1/quality-alerts/${a.id}/recipients-preview`).set(owner).expect(200)).body;
    expect(nobody).toEqual({ total: 0, targets: [expect.objectContaining({ kind: 'department', count: 0 })] });
    const refused = await api().post(`/api/v1/quality-alerts/${a.id}/issue`).set(owner).expect(409);
    expect(refused.body.error.message).toMatch(/reach nobody/);
    await api().patch(`/api/v1/quality-alerts/${a.id}`).set(owner).send({ scope: { targets: [{ departmentId: ctx.gi }, { membershipId: ctx.mDual }, { membershipId: ctx.mInspector }] } }).expect(200);
    const preview = (await api().get(`/api/v1/quality-alerts/${a.id}/recipients-preview`).set(owner).expect(200)).body;
    expect(preview.total).toBe(2); // the inspector once, although reached twice
    await api().get(`/api/v1/quality-alerts/${a.id}/recipients-preview`).set(await as(ids.inspectorA)).expect(403);
  });
});

describe('issued: tracking, acknowledging and My alerts', () => {
  it('issuing fixes the recipients; each sees it in My alerts and the menu count', async () => {
    const owner = await as(ids.ownerA);
    await api().post(`/api/v1/quality-alerts/${ctx.a}/issue`).set(owner).expect(200);
    const rec = (await api().get(`/api/v1/quality-alerts/${ctx.a}/recipients`).set(owner).expect(200)).body;
    expect(rec.totals).toEqual({ total: 2, viewed: 0, acknowledged: 0, overdue: 0 });
    const inspector = rec.data.find((r: { membershipId: string }) => r.membershipId === ctx.mInspector);
    expect(inspector.reachedVia).toEqual(['Department: Goods-in', 'Named']);
    expect(await count(ids.inspectorA)).toEqual({ unacknowledged: 1, overdue: 0 });
    expect(await count(ids.ownerA)).toEqual({ unacknowledged: 0, overdue: 0 });
    const list = await mine(ids.inspectorA);
    expect(list).toMatchObject({ unacknowledged: 1, overdue: 0, data: [expect.objectContaining({ id: ctx.a, state: 'open', reference: 'QA-001' })] });
    expect(list.data[0].me).toMatchObject({ acknowledgedAt: null, overdue: false });
    expect((await mine(ids.ownerA)).data).toEqual([]);
  });

  it('opening the alert records the first view, for the recipient only', async () => {
    const detail = (await api().get(`/api/v1/quality-alerts/${ctx.a}`).set(await as(ids.inspectorA)).expect(200)).body;
    expect(detail.me).toMatchObject({ firstViewedAt: expect.any(String), acknowledgedAt: null, reachedVia: ['Department: Goods-in', 'Named'] });
    const owner = (await api().get(`/api/v1/quality-alerts/${ctx.a}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(owner.me).toBeNull();
    expect(owner.progress).toEqual({ total: 2, viewed: 1, acknowledged: 0, overdue: 0 });
    expect(detail.progress).toBeNull();
  });

  it('only the recipient acknowledges, once, with an optional note', async () => {
    const url = `/api/v1/quality-alerts/${ctx.a}/acknowledge`;
    const stranger = await api().post(url).set(await as(ids.ownerA)).send({}).expect(409);
    expect(stranger.body.error.message).toMatch(/not addressed to you/);
    const done = (await api().post(url).set(await as(ids.inspectorA)).send({ note: 'Quarantined lot 77' }).expect(200)).body;
    expect(done.me).toMatchObject({ acknowledgedAt: expect.any(String), note: 'Quarantined lot 77' });
    await api().post(url).set(await as(ids.inspectorA)).send({}).expect(409);
    expect(await count(ids.inspectorA)).toEqual({ unacknowledged: 0, overdue: 0 });
    expect((await mine(ids.inspectorA)).data[0].state).toBe('acknowledged');
    const rec = (await api().get(`/api/v1/quality-alerts/${ctx.a}/recipients`).set(await as(ids.ownerA)).expect(200)).body;
    expect(rec.totals).toMatchObject({ viewed: 1, acknowledged: 1 });
    expect(rec.data.find((r: { membershipId: string }) => r.membershipId === ctx.mInspector)).toMatchObject({ note: 'Quarantined lot 77', acknowledgedAt: expect.any(String) });
  });

  it('only managers read the tracking list; the register shows progress to them alone', async () => {
    await api().get(`/api/v1/quality-alerts/${ctx.a}/recipients`).set(await as(ids.inspectorA)).expect(403);
    const owner = (await api().get('/api/v1/quality-alerts').set(await as(ids.ownerA)).expect(200)).body.data;
    expect(owner[0].progress).toEqual({ total: 2, viewed: 1, acknowledged: 1, overdue: 0 });
    const inspector = (await api().get('/api/v1/quality-alerts').set(await as(ids.inspectorA)).expect(200)).body.data;
    expect(inspector[0].progress).toBeNull();
  });
});

describe('adding people, overdue, withdrawal and revisions', () => {
  it('a manager adds a person later; not twice, not a suspended member', async () => {
    const owner = await as(ids.ownerA);
    const url = `/api/v1/quality-alerts/${ctx.a}/recipients`;
    await api().post(url).set(owner).send({ membershipId: ctx.mSuspended }).expect(409);
    await api().post(url).set(owner).send({ membershipId: ctx.mDual }).expect(409);
    const added = (await api().post(url).set(owner).send({ membershipId: ctx.mOwner }).expect(201)).body;
    expect(added.progress.total).toBe(3);
    expect(await count(ids.ownerA)).toEqual({ unacknowledged: 1, overdue: 0 });
    await api().post(url).set(await as(ids.inspectorA)).send({ membershipId: ctx.mOwner }).expect(403);
  });

  it('past the acknowledge-by date, people who have not acknowledged are overdue', async () => {
    await admin.query(`alter table public.quality_alerts disable trigger quality_alerts_rules`);
    await admin.query(`update public.quality_alerts set acknowledge_by = current_date - 1, effective_date = current_date - 3 where id = $1`, [ctx.a]);
    await admin.query(`alter table public.quality_alerts enable trigger quality_alerts_rules`);
    const owner = await as(ids.ownerA);
    expect(await count(ids.ownerA)).toEqual({ unacknowledged: 1, overdue: 1 });
    expect((await mine(ids.dual)).data[0].me.overdue).toBe(true);
    const list = (await api().get('/api/v1/quality-alerts?overdue=true').set(owner).expect(200)).body.data;
    expect(list.map((a: { id: string }) => a.id)).toEqual([ctx.a]);
    expect(list[0].progress).toMatchObject({ total: 3, acknowledged: 1, overdue: 2 });
    const rec = (await api().get(`/api/v1/quality-alerts/${ctx.a}/recipients`).set(owner).expect(200)).body;
    expect(rec.data.filter((r: { overdue: boolean }) => r.overdue)).toHaveLength(2);
    // Overdue is for managers only.
    expect((await api().get('/api/v1/quality-alerts?overdue=true').set(await as(ids.inspectorA)).expect(200)).body.data.length).toBe(1);
  });

  it('a revision asks everyone again; the old acknowledgements stay on the old revision', async () => {
    const owner = await as(ids.ownerA);
    const rev = (await api().post(`/api/v1/quality-alerts/${ctx.a}/revisions`).set(owner).send({ reason: 'It was lot 76' }).expect(201)).body;
    await api().patch(`/api/v1/quality-alerts/${rev.id}`).set(owner).send({ effectiveDate: TODAY, acknowledgeBy: TOMORROW }).expect(200);
    await api().post(`/api/v1/quality-alerts/${rev.id}/issue`).set(owner).expect(200);
    const inspector = await mine(ids.inspectorA);
    const states = Object.fromEntries(inspector.data.map((d: { revisionLetter: string; state: string }) => [d.revisionLetter, d.state]));
    expect(states).toEqual({ A: 'closed', B: 'open' });
    expect(inspector.unacknowledged).toBe(1);
    await api().post(`/api/v1/quality-alerts/${ctx.a}/acknowledge`).set(await as(ids.dual)).send({}).expect(409);
    ctx.rev = rev.id;
  });

  it('withdrawing closes it for the recipients, who can no longer acknowledge it', async () => {
    const owner = await as(ids.ownerA);
    await api().post(`/api/v1/quality-alerts/${ctx.rev}/withdraw`).set(owner).send({ reason: 'Issued in error' }).expect(200);
    expect(await count(ids.inspectorA)).toEqual({ unacknowledged: 0, overdue: 0 });
    expect((await mine(ids.inspectorA)).data.map((d: { state: string }) => d.state)).toEqual(['closed', 'closed']);
    await api().post(`/api/v1/quality-alerts/${ctx.rev}/acknowledge`).set(await as(ids.inspectorA)).send({}).expect(409);
  });
});

describe('isolation', () => {
  it('another organisation sees no recipients, acknowledges nothing and counts nothing', async () => {
    const other = await as(ids.ownerB, ids.orgB);
    expect((await api().get('/api/v1/quality-alerts/mine').set(other).expect(200)).body).toEqual({ data: [], unacknowledged: 0, overdue: 0 });
    expect((await api().get('/api/v1/quality-alerts/mine/count').set(other).expect(200)).body).toEqual({ unacknowledged: 0, overdue: 0 });
    await api().get(`/api/v1/quality-alerts/${ctx.a}/recipients`).set(other).expect(404);
    await api().get(`/api/v1/quality-alerts/${ctx.a}/recipients-preview`).set(other).expect(404);
    await api().post(`/api/v1/quality-alerts/${ctx.a}/acknowledge`).set(other).send({}).expect(404);
    await api().post(`/api/v1/quality-alerts/${ctx.a}/recipients`).set(other).send({ membershipId: ctx.mOwner }).expect(404);
  });
});
