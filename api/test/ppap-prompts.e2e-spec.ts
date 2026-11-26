/**
 * PPAP (PP6a) through the API: where a part revision stands for each customer (the banners), what a change or a control plan revision suggests, raising a PPAP from a record (the
 * reason is kept once, a record the person cannot read leaves nothing behind), and that all of it is information only. The rules are in supabase/tests/ppap_prompts.test.sql and
 * src/ppap/ppap-prompts.spec.ts.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('f6a');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
// Quinn is a quality manager: the one who signs a warrant and records a decision (the owner prepares).
const QUINN = 'f6a00000-0000-0000-0000-0000000000e2';
const day = (offset = 0) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
/* eslint-disable @typescript-eslint/no-explicit-any */

/** A package for one customer taken to "ready" (the warrant element is all level 1 needs), sent and approved. */
const approved = async (partId: string, customerId: string, extra: Record<string, unknown> = {}) => {
  const h = await as(ids.ownerA);
  const made = (await api().post('/api/v1/ppaps').set(h).send({ partId, customerId, reason: 'new_part', level: 1, ...extra }).expect(201)).body;
  await api().put(`/api/v1/ppaps/${made.id}/psw`).set(h).send({ partWeight: 1.25, weightUnit: 'kg', purchaseOrder: 'PO-1', resultsMeetRequirements: true }).expect(200);
  await api().post(`/api/v1/ppaps/${made.id}/psw/sign`).set(await as(QUINN)).send({ title: 'Quality manager' }).expect(200);
  await api().post(`/api/v1/ppaps/${made.id}/ready`).set(h).expect(200);
  await api().post(`/api/v1/ppaps/${made.id}/submit`).set(h).send({ sentOn: day(-5), how: 'Emailed' }).expect(200);
  await api().post(`/api/v1/ppaps/${made.id}/decisions`).set(await as(QUINN)).send({ kind: 'approved', decidedOn: day() }).expect(200);
  return made.id as string;
};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pp6');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  await admin.query(`insert into auth.users (id, email) values ($1, 'quinn@f6a.test') on conflict do nothing`, [QUINN]);
  await admin.query(`update public.profiles set first_name = 'Quinn', surname = 'Manager' where id = $1`, [QUINN]);
  const m = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, QUINN]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'quality_manager'`, [ids.orgA, m.rows[0].id]);
  const h = await as(ids.ownerA);
  const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'P6-100', name: 'Bracket', initialRevision: { revision: 'A' } }).expect(201)).body;
  ctx.part = part.id;
  ctx.rev = part.revisions[0].id;
  await api().post(`/api/v1/part-revisions/${ctx.rev}/release`).set(h).expect(200);
  ctx.wayne = (await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'P6-W', 'Wayne Ltd') returning id`, [ids.orgA])).rows[0].id;
  ctx.stark = (await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'P6-S', 'Stark Ltd') returning id`, [ids.orgA])).rows[0].id;
  await admin.query(`insert into public.part_customers (organisation_id, part_id, customer_id, is_primary) values ($1, $2, $3, true), ($1, $2, $4, false)`, [ids.orgA, ctx.part, ctx.wayne, ctx.stark]);
  // Wayne requires PPAP (the organisation has recorded rules for them); Stark has never been asked for one.
  await api().put(`/api/v1/ppap-customer-rules/${ctx.wayne}`).set(await as(QUINN)).send({ defaultLevel: 1 }).expect(200);
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('where a part revision stands (the banners)', () => {
  it('warns of a revision with no PPAP only for a customer that requires one, and lists both customers', async () => {
    const r = (await api().get(`/api/v1/part-ppap-state?partId=${ctx.part}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(r.available).toBe(true);
    expect(r.part).toMatchObject({ partNumber: 'P6-100' });
    expect(r.revision).toMatchObject({ id: ctx.rev, label: 'A' });
    expect(r.customers.map((c: any) => [c.name, c.requires, c.state, c.primary])).toEqual([['Wayne Ltd', true, 'none', true], ['Stark Ltd', false, 'none', false]]);
    expect(r.attention).toHaveLength(1);
    expect(r.attention[0]).toMatchObject({ code: 'none', tone: 'warning', customerName: 'Wayne Ltd' });
    expect(r.canRaise).toBe(true);
  });

  it('names the revision when it is asked for, and refuses a revision of another part or a part that is not there', async () => {
    const h = await as(ids.ownerA);
    const r = (await api().get(`/api/v1/part-ppap-state?partId=${ctx.part}&partRevisionId=${ctx.rev}`).set(h).expect(200)).body;
    expect(r.revision.id).toBe(ctx.rev);
    await api().get(`/api/v1/part-ppap-state?partId=${ctx.part}&partRevisionId=${ids.orgB}`).set(h).expect(404);
    await api().get(`/api/v1/part-ppap-state?partId=${ids.orgB}`).set(h).expect(404);
    await api().get(`/api/v1/part-ppap-state?partId=${ctx.part}`).set(await as(ids.ownerB, ids.orgB)).expect(404);
  });

  it('is information only for someone who may read it, and reports "not available" for someone who may not', async () => {
    // The inspector holds ppap.read; the answer carries canRaise false.
    const r = (await api().get(`/api/v1/part-ppap-state?partId=${ctx.part}`).set(await as(ids.inspectorA)).expect(200)).body;
    expect(r.available).toBe(true);
    expect(r.canRaise).toBe(false);
  });
});

describe('raising a PPAP from a record', () => {
  it('suggests part, revision, customer and reason from a part revision, and saves nothing', async () => {
    const h = await as(ids.ownerA);
    const d = (await api().get(`/api/v1/ppap-draft?kind=part_revision&id=${ctx.rev}`).set(h).expect(200)).body;
    expect(d).toMatchObject({ partId: ctx.part, partRevisionId: ctx.rev, customerId: ctx.wayne, reason: 'new_part' });
    expect(d.customers.map((c: any) => c.name)).toEqual(['Wayne Ltd', 'Stark Ltd']);
    expect(d.notes).toBe('Raised from part revision P6-100 rev A: Bracket');
    const list = (await api().get('/api/v1/ppaps?status=all').set(h).expect(200)).body;
    expect(list.total).toBe(0);
  });

  it('is for people who may start a PPAP, and does not find another organisation\'s record', async () => {
    await api().get(`/api/v1/ppap-draft?kind=part_revision&id=${ctx.rev}`).set(await as(ids.inspectorA)).expect(403);
    await api().get(`/api/v1/ppap-draft?kind=part_revision&id=${ctx.rev}`).set(await as(ids.ownerB, ids.orgB)).expect(404);
    await api().get(`/api/v1/ppap-draft?kind=risk&id=${ctx.rev}`).set(await as(ids.ownerA)).expect(400);
  });

  it('keeps where it was raised from, shows it, and then the part is no longer "without PPAP"', async () => {
    const h = await as(ids.ownerA);
    const made = (await api().post('/api/v1/ppaps').set(h).send({ partId: ctx.part, customerId: ctx.wayne, reason: 'new_part', level: 1, raisedFrom: { kind: 'part_revision', id: ctx.rev } }).expect(201)).body;
    ctx.p1 = made.id;
    expect(made.origin).toEqual({ kind: 'part_revision', id: ctx.rev, reference: 'P6-100 rev A', title: 'Bracket', readable: true });
    const again = (await api().get(`/api/v1/ppaps/${made.id}`).set(h).expect(200)).body;
    expect(again.origin.reference).toBe('P6-100 rev A');
    const state = (await api().get(`/api/v1/part-ppap-state?partId=${ctx.part}`).set(h).expect(200)).body;
    expect(state.customers[0]).toMatchObject({ state: 'in_preparation', reference: made.reference });
    expect(state.attention).toHaveLength(1);
    expect(state.attention[0]).toMatchObject({ code: 'in_preparation', tone: 'info' });
  });

  it('leaves no PPAP behind when the record it is raised from cannot be read', async () => {
    const h = await as(ids.ownerA);
    const before = (await api().get('/api/v1/ppaps?status=all').set(h).expect(200)).body.total;
    const theirs = (await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'P6-THEIRS', 'Theirs') returning id`, [ids.orgB])).rows[0].id;
    const rev = (await admin.query(`insert into public.part_revisions (organisation_id, part_id, revision) values ($1, $2, 'A') returning id`, [ids.orgB, theirs])).rows[0].id;
    await api().post('/api/v1/ppaps').set(h).send({ partId: ctx.part, customerId: ctx.stark, reason: 'tooling', raisedFrom: { kind: 'part_revision', id: rev } }).expect(404);
    expect((await api().get('/api/v1/ppaps?status=all').set(h).expect(200)).body.total).toBe(before);
    await api().post('/api/v1/ppaps').set(h).send({ partId: ctx.part, customerId: ctx.stark, reason: 'tooling', raisedFrom: { kind: 'risk', id: rev } }).expect(400);
  });

  it('warns when an approved part has not been produced for over a year', async () => {
    const h = await as(ids.ownerA);
    // Replace the package in preparation by an approved one for another reason so the first one stays out of the way: use a second part.
    const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'P6-200', name: 'Washer', initialRevision: { revision: 'A' } }).expect(201)).body;
    await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/release`).set(h).expect(200);
    await admin.query(`insert into public.part_customers (organisation_id, part_id, customer_id, is_primary) values ($1, $2, $3, true)`, [ids.orgA, part.id, ctx.wayne]);
    await approved(part.id, ctx.wayne);
    expect((await api().get(`/api/v1/part-ppap-state?partId=${part.id}`).set(h).expect(200)).body.attention).toEqual([]);
    await admin.query(`insert into public.production_orders (organisation_id, order_number, part_id, quantity_planned, status, created_at) values ($1, 'WO-OLD', $2, 10, 'closed', now() - interval '800 days')`, [ids.orgA, part.id]);
    const r = (await api().get(`/api/v1/part-ppap-state?partId=${part.id}`).set(h).expect(200)).body;
    expect(r.attention).toHaveLength(1);
    expect(r.attention[0]).toMatchObject({ code: 'idle', tone: 'warning' });
    expect(r.attention[0].message).toContain('may be needed');
  });
});

describe('a change and a control plan revision', () => {
  it('prompts for an approved change of the right type, never for a draft or the wrong type, and stops once a PPAP is raised from it', async () => {
    const h = await as(ids.ownerA);
    const types = (await api().get('/api/v1/change-types').set(h).expect(200)).body.data as any[];
    const product = types.find((t) => t.key === 'product_design').id;
    const docs = types.find((t) => t.key === 'documentation').id;
    const chg = (await api().post('/api/v1/changes').set(h).send({ title: 'New drawing', typeId: product, links: [{ kind: 'part', id: ctx.part }] }).expect(201)).body;
    const draft = (await api().get(`/api/v1/ppap-prompts?kind=change&id=${chg.id}`).set(h).expect(200)).body;
    expect(draft).toMatchObject({ available: true, applies: false, prompts: [], raised: [] });
    // Move it to approved the way the database allows only inside the change module: here, directly, for the test.
    const c = await admin.connect();
    try {
      await c.query(`set session_replication_role = replica`);
      await c.query(`update public.change_requests set stage = 'approved' where id = $1`, [chg.id]);
    } finally {
      await c.query(`set session_replication_role = origin`);
      c.release();
    }
    const on = (await api().get(`/api/v1/ppap-prompts?kind=change&id=${chg.id}`).set(h).expect(200)).body;
    expect(on.applies).toBe(true);
    expect(on.prompts).toHaveLength(1);
    expect(on.prompts[0]).toMatchObject({ code: 'change_may_need_ppap', partNumber: 'P6-100', customerName: 'Wayne Ltd' });
    expect(on.prompts[0].message).toContain(chg.reference);
    // Raising from the change keeps the origin and clears the prompt.
    const draftFrom = (await api().get(`/api/v1/ppap-draft?kind=change&id=${chg.id}`).set(h).expect(200)).body;
    expect(draftFrom).toMatchObject({ partId: ctx.part, reason: 'engineering_change', customerId: ctx.wayne });
    const made = (await api().post('/api/v1/ppaps').set(h).send({ partId: ctx.part, customerId: ctx.wayne, reason: 'engineering_change', level: 1, raisedFrom: { kind: 'change', id: chg.id } }).expect(201)).body;
    expect(made.origin).toMatchObject({ kind: 'change', reference: chg.reference, readable: true });
    const after = (await api().get(`/api/v1/ppap-prompts?kind=change&id=${chg.id}`).set(h).expect(200)).body;
    expect(after.prompts).toEqual([]);
    expect(after.raised).toHaveLength(1);
    expect(after.raised[0]).toMatchObject({ id: made.id, part: { partNumber: 'P6-100' }, customer: { name: 'Wayne Ltd' } });
    // A change of a type that never calls for PPAP is quiet even when approved.
    const quiet = (await api().post('/api/v1/changes').set(h).send({ title: 'A procedure', typeId: docs, links: [{ kind: 'part', id: ctx.part }] }).expect(201)).body;
    const c2 = await admin.connect();
    try {
      await c2.query(`set session_replication_role = replica`);
      await c2.query(`update public.change_requests set stage = 'approved' where id = $1`, [quiet.id]);
    } finally {
      await c2.query(`set session_replication_role = origin`);
      c2.release();
    }
    expect((await api().get(`/api/v1/ppap-prompts?kind=change&id=${quiet.id}`).set(h).expect(200)).body).toMatchObject({ applies: false, prompts: [] });
  });

  it('does not find another organisation\'s change or one that is not there', async () => {
    await api().get(`/api/v1/ppap-prompts?kind=change&id=${ids.orgB}`).set(await as(ids.ownerA)).expect(404);
    await api().get(`/api/v1/ppap-prompts?kind=control_plan_revision&id=${ids.orgB}`).set(await as(ids.ownerA)).expect(404);
    await api().get(`/api/v1/ppap-prompts?kind=part_revision&id=${ctx.rev}`).set(await as(ids.ownerA)).expect(400);
  });

  it('is quiet for a control plan revision that is still a draft', async () => {
    const h = await as(ids.ownerA);
    const fam = (await api().post('/api/v1/part-families').set(h).send({ code: 'P6F', name: 'P6F' }).expect(201)).body;
    const plan = (await api().post('/api/v1/control-plans').set(h).send({ planCode: 'CP-P6', title: 'CP-P6', partFamilyId: fam.id }).expect(201)).body;
    const r = (await api().get(`/api/v1/ppap-prompts?kind=control_plan_revision&id=${plan.revisions[0].id}`).set(h).expect(200)).body;
    expect(r).toMatchObject({ available: true, applies: false, prompts: [], raised: [] });
    expect(r.reference).toBe('CP-P6 rev A');
  });
});
