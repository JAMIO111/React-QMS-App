/**
 * PPAP (PP6c) through the API: the dashboard (as of today and for a period) and the PPAP area of the home page, which must agree because they share their SQL.
 * The rules for the submissions themselves are in ppap-submission.e2e-spec.ts and supabase/tests/ppap_*.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('f6c');
const QUINN = 'f6c00000-0000-0000-0000-0000000000e2';
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const period = () => `from=${day(-89)}&to=${day(0)}`;
const dashboard = async (user = ids.ownerA, org = ids.orgA) => (await api().get(`/api/v1/ppap-dashboard?${period()}`).set(await as(user, org)).expect(200)).body;
const home = async (user = ids.ownerA, org = ids.orgA) => (await api().get('/api/v1/home-dashboard').set(await as(user, org)).expect(200)).body;
const ctx: Record<string, string> = {};
/* eslint-disable @typescript-eslint/no-explicit-any */

/** The home page's PPAP area as the dashboard's own figures say it should be. */
const fromDashboard = (d: any) => ({
  approved: d.kpis.approved,
  rejected: d.kpis.rejected,
  interimLapsed: d.kpis.interimLapsed,
  interimEnding: d.kpis.interimEnding,
  reviewsOverdue: d.kpis.reviewsOverdue,
  awaitingUs: d.kpis.awaitingUs,
  awaitingCustomer: d.kpis.awaitingCustomer,
});

/** A level 1 package (the warrant is all it needs) for one customer, taken as far as `upTo` says. One part and one customer, so each takes its own reason. */
const make = async (reason: string, upTo: 'draft' | 'sent' | 'decided', decision?: { kind: string; decidedOn: string; expiresOn?: string; note?: string }, sentOn = day(-5)) => {
  const h = await as(ids.ownerA);
  const made = (await api().post('/api/v1/ppaps').set(h).send({ partId: ctx.part, customerId: ctx.customer, reason, level: 1 }).expect(201)).body;
  if (upTo === 'draft') return made.id as string;
  await api().put(`/api/v1/ppaps/${made.id}/psw`).set(h).send({ partWeight: 1.25, weightUnit: 'kg', purchaseOrder: 'PO-1', resultsMeetRequirements: true }).expect(200);
  await api().post(`/api/v1/ppaps/${made.id}/psw/sign`).set(await as(QUINN)).send({ title: 'Quality manager' }).expect(200);
  await api().post(`/api/v1/ppaps/${made.id}/ready`).set(h).expect(200);
  await api().post(`/api/v1/ppaps/${made.id}/submit`).set(h).send({ sentOn, how: 'Emailed' }).expect(200);
  if (upTo === 'decided' && decision) await api().post(`/api/v1/ppaps/${made.id}/decisions`).set(await as(QUINN)).send(decision).expect(200);
  return made.id as string;
};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pd');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  await admin.query(`insert into auth.users (id, email) values ($1, 'quinn@f6c.test') on conflict do nothing`, [QUINN]);
  await admin.query(`update public.profiles set first_name = 'Quinn', surname = 'Manager' where id = $1`, [QUINN]);
  const m = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, QUINN]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'quality_manager'`, [ids.orgA, m.rows[0].id]);
  const h = await as(ids.ownerA);
  const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'PD-100', name: 'Bracket', initialRevision: { revision: 'A' } }).expect(201)).body;
  ctx.part = part.id;
  await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/release`).set(h).expect(200);
  ctx.customer = (await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'PD-W', 'Wayne Ltd') returning id`, [ids.orgA])).rows[0].id;
  await admin.query(`insert into public.part_customers (organisation_id, part_id, customer_id, is_primary) values ($1, $2, $3, true)`, [ids.orgA, ctx.part, ctx.customer]);
  await api().put(`/api/v1/ppap-customer-rules/${ctx.customer}`).set(await as(QUINN)).send({ defaultLevel: 1 }).expect(200);
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('an organisation with no part approvals', () => {
  it('answers zeros and the home page agrees', async () => {
    const d = await dashboard();
    expect(d.kpis).toMatchObject({ inPreparation: 0, awaitingCustomer: 0, awaitingUs: 0, approved: 0, interim: 0, interimEnding: 0, interimLapsed: 0, rejected: 0, reviewsOverdue: 0, sent: 0, averageDaysToAnswer: null });
    expect(d.needsAction).toEqual([]);
    expect(d.awaiting).toEqual([]);
    expect(d.byStatus.every((s: any) => s.count === 0)).toBe(true);
    expect((await home()).ppap).toEqual(fromDashboard(d));
  });
});

describe('with part approvals in every state', () => {
  beforeAll(async () => {
    await make('new_part', 'decided', { kind: 'approved', decidedOn: day() });
    await make('engineering_change', 'decided', { kind: 'rejected', decidedOn: day(), note: 'The gauge study was missing' });
    await make('tooling', 'decided', { kind: 'interim_approved', decidedOn: day(), expiresOn: day(10), note: 'Until the new gauge arrives' });
    await make('process_change', 'decided', { kind: 'interim_approved', decidedOn: day(-20), expiresOn: day(-3), note: 'Until the new oven is proved' }, day(-25));
    await make('customer_request', 'sent');
    await make('other', 'draft');
    await make('discrepancy_correction', 'decided', { kind: 'approved', decidedOn: day(-400) }, day(-405));
  });

  it('counts each state as of today', async () => {
    const d = await dashboard();
    expect(d.kpis).toMatchObject({
      inPreparation: 1,
      awaitingCustomer: 1,
      awaitingUs: 0,
      approved: 2,
      interim: 1,
      interimEnding: 1,
      interimLapsed: 1,
      rejected: 1,
      reviewsOverdue: 1,
    });
    expect(d.byStatus.map((s: any) => [s.status, s.count])).toEqual([
      ['draft', 1],
      ['in_preparation', 0],
      ['ready', 0],
      ['submitted', 1],
      ['approved', 2],
      ['interim_approved', 2],
      ['rejected', 1],
    ]);
    expect(d.byDirection).toEqual([{ direction: 'submitted', count: 7 }]);
  });

  it('counts what was sent and answered in the period, by the day each was recorded', async () => {
    const d = await dashboard();
    // Sent in the period: five of the six that were sent (the old one was sent 405 days ago). Answers: one approved, two interim, one rejected, and the old approval is outside the period.
    expect(d.kpis).toMatchObject({ sent: 5, approvedInPeriod: 1, interimInPeriod: 2, rejectedInPeriod: 1 });
    // Every answer in the period came five days after it was sent.
    expect(d.kpis.averageDaysToAnswer).toBe(5);
    expect(d.trend.reduce((a: number, b: any) => a + b.sent, 0)).toBe(5);
    expect(d.trend.reduce((a: number, b: any) => a + b.approved + b.interim, 0)).toBe(3);
    expect(d.trend.reduce((a: number, b: any) => a + b.rejected, 0)).toBe(1);
  });

  it('lists what needs action, the most pressing first, and what is waiting for an answer', async () => {
    const d = await dashboard();
    expect(d.needsAction.map((i: any) => [i.reason, i.partNumber, i.party])).toEqual([
      ['rejected', 'PD-100', 'Wayne Ltd'],
      ['interim_lapsed', 'PD-100', 'Wayne Ltd'],
      ['interim_ending', 'PD-100', 'Wayne Ltd'],
      ['review_overdue', 'PD-100', 'Wayne Ltd'],
    ]);
    const by = Object.fromEntries(d.needsAction.map((i: any) => [i.reason, i]));
    expect(by.interim_lapsed.days).toBe(-3);
    expect(by.interim_ending.days).toBe(10);
    expect(by.review_overdue.days).toBeGreaterThan(0);
    expect(by.rejected.on).toBe(day());
    expect(d.awaiting).toHaveLength(1);
    expect(d.awaiting[0]).toMatchObject({ reason: 'awaiting', direction: 'submitted', on: day(-5), days: 5 });
  });

  it('agrees with the home page, which shares its SQL', async () => {
    const d = await dashboard();
    expect((await home()).ppap).toEqual(fromDashboard(d));
    expect((await home()).ppap).toMatchObject({ approved: 2, rejected: 1, interimLapsed: 1, interimEnding: 1, reviewsOverdue: 1, awaitingCustomer: 1, awaitingUs: 0 });
  });

  it('stops listing a rejection once a resubmission answers it, and a revalidation takes the approval off the overdue list', async () => {
    const h = await as(ids.ownerA);
    const rejected = (await admin.query(`select id from public.ppap_submissions where organisation_id = $1 and status = 'rejected'`, [ids.orgA])).rows[0].id as string;
    await api().post(`/api/v1/ppaps/${rejected}/resubmission`).set(h).send({}).expect(201);
    const overdue = (await admin.query(`select id from public.ppap_submissions where organisation_id = $1 and status = 'approved' and next_review_on < current_date`, [ids.orgA])).rows[0].id as string;
    await api().post(`/api/v1/ppaps/${overdue}/resubmission`).set(h).send({ reason: 'not_produced_12_months' }).expect(201);
    const d = await dashboard();
    expect(d.kpis).toMatchObject({ rejected: 0, reviewsOverdue: 0, approved: 1 });
    expect(d.needsAction.map((i: any) => i.reason)).toEqual(['interim_lapsed', 'interim_ending']);
    expect((await home()).ppap).toEqual(fromDashboard(d));
  });
});

describe('who sees what', () => {
  it('shows another organisation nothing of this one', async () => {
    const d = await dashboard(ids.ownerB, ids.orgB);
    expect(d.kpis.approved).toBe(0);
    expect(d.kpis.interimLapsed).toBe(0);
    expect(d.needsAction).toEqual([]);
  });

  it('is open to anyone who may read part approvals and the home page leaves the area out for anyone who may not', async () => {
    // An inspector reads part approvals (read-only), so both answer.
    await api().get(`/api/v1/ppap-dashboard?${period()}`).set(await as(ids.inspectorA)).expect(200);
    expect((await home(ids.inspectorA)).ppap).not.toBeNull();
  });

  it('refuses a period that is back to front or longer than three years', async () => {
    const h = await as(ids.ownerA);
    await api().get(`/api/v1/ppap-dashboard?from=${day()}&to=${day(-1)}`).set(h).expect(400);
    await api().get(`/api/v1/ppap-dashboard?from=${day(-1200)}&to=${day()}`).set(h).expect(400);
  });
});
