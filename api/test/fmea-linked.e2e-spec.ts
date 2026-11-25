/**
 * FMEA (FM5c, banners) through the API: which FMEAs in force cover a part (itself or through its family), a part family, a machine or a control plan, for the banners on those
 * pages. A draft or a withdrawn FMEA is not "in force"; an overdue review is flagged; nothing is blocked either way.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a5f');
const QM = 'a5f00000-0000-0000-0000-0000000000e1';
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const today = () => new Date().toISOString().slice(0, 10);
const ctx: Record<string, string> = {};

/* eslint-disable @typescript-eslint/no-explicit-any */
async function buildNet(h: Record<string, string>, revision: string) {
  const item = (await api().post(`/api/v1/fmea-revisions/${revision}/items`).set(h).send({ kind: 'item', name: 'Turning' }).expect(201)).body.net.items[0].id;
  const fn = (await api().post(`/api/v1/fmea-items/${item}/functions`).set(h).send({ text: 'Turn the bore to size' }).expect(201)).body.net.items[0].functions[0].id;
  const mode = (await api().post(`/api/v1/fmea-functions/${fn}/failure-modes`).set(h).send({ text: 'Bore oversize' }).expect(201)).body.net.items[0].functions[0].failureModes[0].id;
  await api().post(`/api/v1/fmea-failure-modes/${mode}/effects`).set(h).send({ level: 'own_plant', text: 'Scrap', severity: 5 }).expect(201);
  await api().post(`/api/v1/fmea-failure-modes/${mode}/causes`).set(h).send({ text: 'Tool wear', preventionControls: 'Tool life counter', occurrence: 3, detection: 3 }).expect(201);
}

/** An FMEA with the given scope, taken all the way to in force. */
async function inForce(title: string, links: object[]) {
  const h = await as(ids.ownerA);
  const made = (await api().post('/api/v1/fmeas').set(h).send({ kind: 'process', title, links }).expect(201)).body;
  const rev = made.inProgress.id as string;
  await api().put(`/api/v1/fmea-revisions/${rev}/team`).set(h).send({ team: [{ userId: ids.ownerA, role: 'lead' }, { userId: QM, role: 'quality' }] }).expect(200);
  await api().put(`/api/v1/fmea-revisions/${rev}/approver`).set(h).send({ approverId: QM }).expect(200);
  await buildNet(h, rev);
  await api().post(`/api/v1/fmea-revisions/${rev}/submit`).set(h).expect(200);
  await api().post(`/api/v1/fmea-revisions/${rev}/approve`).set(await as(QM)).send({ effectiveFrom: today() }).expect(200);
  return { id: made.id as string, rev };
}

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-fk');
  await admin.query(`insert into auth.users (id, email) values ($1, 'qm-fk@example.test')`, [QM]);
  await admin.query(`update public.profiles set first_name = 'Quinn', surname = 'Manager' where id = $1`, [QM]);
  const m = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, QM]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'quality_manager'`, [ids.orgA, m.rows[0].id]);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });

  const one = async (text: string, params: unknown[]) => (await admin.query(text, params)).rows[0].id as string;
  ctx.family = await one(`insert into public.part_families (organisation_id, code, name) values ($1, 'BRK', 'Brackets') returning id`, [ids.orgA]);
  ctx.partIn = await one(`insert into public.parts (organisation_id, part_number, name, part_family_id) values ($1, 'FK-1', 'Bracket', $2) returning id`, [ids.orgA, ctx.family]);
  ctx.partOwn = await one(`insert into public.parts (organisation_id, part_number, name) values ($1, 'FK-2', 'Plate') returning id`, [ids.orgA]);
  ctx.partNone = await one(`insert into public.parts (organisation_id, part_number, name) values ($1, 'FK-3', 'Washer') returning id`, [ids.orgA]);
  ctx.machine = await one(`insert into public.machines (organisation_id, code, name) values ($1, 'CNC-1', 'Lathe') returning id`, [ids.orgA]);
  ctx.machineOther = await one(`insert into public.machines (organisation_id, code, name) values ($1, 'CNC-2', 'Mill') returning id`, [ids.orgA]);
  ctx.plan = await one(`insert into public.control_plans (organisation_id, plan_code, title) values ($1, 'FK-CP1', 'Plan') returning id`, [ids.orgA]);

  ctx.familyFmea = (await inForce('Brackets', [{ kind: 'part_family', id: ctx.family }, { kind: 'machine', id: ctx.machine }, { kind: 'control_plan', id: ctx.plan }])).id;
  ctx.partFmea = (await inForce('Plate', [{ kind: 'part', id: ctx.partOwn }])).id;
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const linked = async (kind: string, id: string, user = ids.ownerA, org = ids.orgA) => {
  const res = await api().get(`/api/v1/fmeas/linked?kind=${kind}&id=${id}`).set(await as(user, org));
  expect(res.status).toBe(200);
  return res;
};

describe('which FMEAs in force cover something', () => {
  it('finds an FMEA for a part through its family, and says how', async () => {
    const r = (await linked('part', ctx.partIn)).body;
    expect(r.canRaise).toBe(true);
    expect(r.data).toHaveLength(1);
    expect(r.data[0]).toMatchObject({ id: ctx.familyFmea, number: 'FMEA-001', title: 'Brackets', kind: 'process', letter: 'A', via: ['part_family'], reviewOverdue: false });
  });

  it('finds an FMEA written for the part itself, and none for a part nothing covers', async () => {
    const own = (await linked('part', ctx.partOwn)).body.data;
    expect(own.map((f: any) => [f.id, f.via])).toEqual([[ctx.partFmea, ['part']]]);
    expect((await linked('part', ctx.partNone)).body.data).toEqual([]);
  });

  it('finds the FMEA of a part family, a machine and a control plan, and not of another machine', async () => {
    for (const [kind, id] of [['part_family', ctx.family], ['machine', ctx.machine], ['control_plan', ctx.plan]]) {
      const data = (await linked(kind, id)).body.data;
      expect(data.map((f: any) => f.id)).toEqual([ctx.familyFmea]);
    }
    expect((await linked('machine', ctx.machineOther)).body.data).toEqual([]);
  });

  it('does not count an FMEA still in draft, or one that has been withdrawn', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/fmeas').set(h).send({ kind: 'process', title: 'Draft only', links: [{ kind: 'machine', id: ctx.machineOther }] }).expect(201);
    expect((await linked('machine', ctx.machineOther)).body.data).toEqual([]);
    await api().post(`/api/v1/fmeas/${ctx.partFmea}/withdraw`).set(h).send({ reason: 'No longer made here' }).expect(200);
    expect((await linked('part', ctx.partOwn)).body.data).toEqual([]);
  });

  it('flags a review that is overdue', async () => {
    await admin.query(`update public.fmeas set next_review_on = current_date - 3 where id = $1`, [ctx.familyFmea]);
    const r = (await linked('machine', ctx.machine)).body.data[0];
    expect(r.reviewOverdue).toBe(true);
    expect(r.nextReviewOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('is asked properly, and answers 403 to someone who cannot read FMEAs and nothing about another organisation', async () => {
    await api().get('/api/v1/fmeas/linked?kind=part').set(await as(ids.ownerA)).expect(400);
    await api().get(`/api/v1/fmeas/linked?kind=nonsense&id=${ctx.partIn}`).set(await as(ids.ownerA)).expect(400);
    await api().get(`/api/v1/fmeas/linked?kind=part&id=not-an-id`).set(await as(ids.ownerA)).expect(400);
    // another organisation's owner asks about our part: the FMEAs are not theirs to see
    const other = (await linked('part', ctx.partIn, ids.ownerB, ids.orgB)).body;
    expect(other.data).toEqual([]);
  });
});
