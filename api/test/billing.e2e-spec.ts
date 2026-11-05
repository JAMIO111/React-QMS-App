/**
 * Subscription and billing through the API: catalogue from the database, seats, package assignment,
 * and the independence of subscription from company roles (effective access = entitlement AND permission).
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('e');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const membership = async (user: string, org = ids.orgA) =>
  (await admin.query('select id from public.organisation_users where organisation_id = $1 and user_id = $2', [org, user])).rows[0].id as string;

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-bill');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('catalogue', () => {
  it('serves packages, prices in pence and the feature comparison from the database', async () => {
    const res = await api().get('/api/v1/subscription-plans').set(await as(ids.ownerA)).expect(200);
    const plans = Object.fromEntries(res.body.plans.map((p: { slug: string }) => [p.slug, p]));
    expect(Object.keys(plans)).toEqual(['observer', 'contributor', 'controller']);
    expect(plans.controller.monthly.unitAmount).toBe(2500);
    expect(plans.controller.annual.unitAmount).toBe(25000);
    expect(plans.controller.annualSaving).toBe(5000);
    expect(plans.controller.annualMonthlyEquivalent).toBe(2083);
    expect(plans.observer.annualMonthlyEquivalent).toBe(417);
    const inspections = res.body.modules.find((m: { slug: string }) => m.slug === 'inspections');
    const record = inspections.features.find((f: { slug: string }) => f.slug === 'record_inspections');
    expect(record.includedIn).toEqual(['contributor', 'controller']);
  });

  it('is limited to people with billing permissions', async () => {
    await api().get('/api/v1/subscription-plans').set(await as(ids.inspectorA)).expect(403);
    await api().get('/api/v1/subscription').set(await as(ids.inspectorA)).expect(403);
    await api().get('/api/v1/billing/invoices').set(await as(ids.inspectorA)).expect(403);
  });
});

describe('seats and assignments', () => {
  it('starts with no subscription and totals the recurring cost once seats are bought', async () => {
    const h = await as(ids.ownerA);
    const empty = (await api().get('/api/v1/subscription').set(h).expect(200)).body;
    expect(empty.subscription).toBeNull();
    expect(empty.totals.monthlyEquivalent).toBe(0);

    await api().put('/api/v1/subscription/seats').set(h).send({ planSlug: 'observer', quantity: 10 }).expect(200);
    await api().put('/api/v1/subscription/seats').set(h).send({ planSlug: 'contributor', quantity: 15 }).expect(200);
    const res = await api().put('/api/v1/subscription/seats').set(h).send({ planSlug: 'controller', quantity: 5 }).expect(200);
    expect(res.body.totals).toMatchObject({ seatsPurchased: 30, monthlyEquivalent: 32500, annual: 390000, seatsAssigned: 0, seatsAvailable: 30 });
    expect(res.body.subscription.billingInterval).toBe('month');
  });

  it('assigns packages, refuses beyond purchased seats, keeps roles separate from packages', async () => {
    const h = await as(ids.ownerA);
    await api().put('/api/v1/subscription/seats').set(h).send({ planSlug: 'controller', quantity: 1 }).expect(200);
    const inspector = await membership(ids.inspectorA);
    const owner = await membership(ids.ownerA);

    const seat = (await api().put(`/api/v1/subscription/assignments/${inspector}`).set(h).send({ planSlug: 'controller' }).expect(200)).body;
    expect(seat.plan.slug).toBe('controller');
    expect(seat.roles).toEqual(['Inspector']);

    const full = await api().put(`/api/v1/subscription/assignments/${owner}`).set(h).send({ planSlug: 'controller' }).expect(409);
    expect(full.body.error.code).toBe('subscription_rule');
    const tooFew = await api().put('/api/v1/subscription/seats').set(h).send({ planSlug: 'controller', quantity: 0 }).expect(409);
    expect(tooFew.body.error.code).toBe('subscription_rule');
    await api().put(`/api/v1/subscription/assignments/${owner}`).set(h).send({ planSlug: 'nonsense' }).expect(409);

    const list = (await api().get('/api/v1/subscription/assignments').set(h).expect(200)).body.data;
    expect(list.find((m: { membershipId: string }) => m.membershipId === inspector).plan.slug).toBe('controller');
    const overview = (await api().get('/api/v1/subscription').set(h).expect(200)).body;
    expect(overview.items.find((i: { planSlug: string }) => i.planSlug === 'controller')).toMatchObject({ purchased: 1, assigned: 1, available: 0 });
  });

  it('only people with subscription.seats may assign; billing is separate from other permissions', async () => {
    const inspector = await membership(ids.inspectorA);
    await api().put(`/api/v1/subscription/assignments/${inspector}`).set(await as(ids.inspectorA)).send({ planSlug: 'observer' }).expect(403);
    await api().put('/api/v1/subscription/seats').set(await as(ids.inspectorA)).send({ planSlug: 'observer', quantity: 99 }).expect(403);
  });

  it('removing a package keeps the membership and roles, and is recorded', async () => {
    const h = await as(ids.ownerA);
    const inspector = await membership(ids.inspectorA);
    await api().delete(`/api/v1/subscription/assignments/${inspector}`).set(h).expect(204);
    const kept = await admin.query(
      `select m.status, (select count(*)::int from public.user_role_assignments where membership_id = m.id) roles,
              (select count(*)::int from public.user_subscription_assignments where organisation_membership_id = m.id) history
         from public.organisation_users m where m.id = $1`,
      [inspector],
    );
    expect(kept.rows[0]).toEqual({ status: 'active', roles: 1, history: 1 });
    const history = (await api().get('/api/v1/subscription/history').set(h).expect(200)).body.data;
    expect(history.map((e: { eventType: string }) => e.eventType)).toEqual(expect.arrayContaining(['seats_added', 'package_assigned', 'assignment_removed']));
  });
});

describe('entitlement enforcement (RBAC AND subscription)', () => {
  it('changes nothing until enforcement is switched on for the organisation', async () => {
    await api().get('/api/v1/inspections').set(await as(ids.inspectorA)).expect(200);
    const access = (await api().get('/api/v1/subscription/access').set(await as(ids.inspectorA)).expect(200)).body;
    expect(access.enforced).toBe(false);
  });

  it('enforces on the server: no package blocks, a package opens exactly its level, roles still apply', async () => {
    const h = await as(ids.ownerA);
    const inspectorH = await as(ids.inspectorA);
    const inspector = await membership(ids.inspectorA);
    await api().put('/api/v1/subscription/seats').set(h).send({ planSlug: 'controller', quantity: 1 }).expect(200);
    await admin.query('update public.organisation_settings set entitlements_enforced = true where organisation_id = $1', [ids.orgA]);
    const check = async (feature: string, module = 'inspections') =>
      (await api().get(`/api/v1/subscription/check?module=${module}&feature=${feature}`).set(inspectorH).expect(200)).body;
    try {
      // No package: restricted modules are refused by the API; billing permissions are not subscription-restricted.
      await api().get('/api/v1/inspections').set(inspectorH).expect(403);
      expect(await check('view_inspections')).toMatchObject({ allowed: false, reason: 'no_seat_assigned' });
      await api().get('/api/v1/subscription').set(h).expect(200);

      // Observer: view only, even though the Inspector role may record.
      await api().put(`/api/v1/subscription/assignments/${inspector}`).set(h).send({ planSlug: 'observer' }).expect(200);
      await api().get('/api/v1/inspections').set(inspectorH).expect(200);
      expect(await check('record_inspections')).toMatchObject({ allowed: false, reason: 'feature_not_included', currentPlan: 'Observer', requiredPlan: 'Contributor' });
      const access = (await api().get('/api/v1/subscription/access').set(inspectorH).expect(200)).body;
      expect(access).toMatchObject({ enforced: true, reason: null, plan: { slug: 'observer' } });
      expect(access.modules.inspections).toBe('view');

      // Contributor: records, but plan management stays out of reach.
      await api().put(`/api/v1/subscription/assignments/${inspector}`).set(h).send({ planSlug: 'contributor' }).expect(200);
      expect(await check('record_inspections')).toMatchObject({ allowed: true });
      expect(await check('manage_control_plans', 'control_plans')).toMatchObject({ allowed: false, requiredPlan: 'Controller' });

      // A Controller package supplies no company permission: the Inspector role still cannot manage billing or correct readings.
      await api().put(`/api/v1/subscription/assignments/${inspector}`).set(h).send({ planSlug: 'controller' }).expect(200);
      await api().put('/api/v1/subscription/seats').set(inspectorH).send({ planSlug: 'observer', quantity: 50 }).expect(403);
      await api().get('/api/v1/subscription').set(inspectorH).expect(403);
    } finally {
      await admin.query('update public.organisation_settings set entitlements_enforced = false where organisation_id = $1', [ids.orgA]);
    }
  });

  it('keeps organisations apart', async () => {
    const res = await api().get('/api/v1/subscription').set(await as(ids.ownerB, ids.orgB)).expect(200);
    expect(res.body.subscription).toBeNull();
    expect(res.body.totals.seatsPurchased).toBe(0);
    await api().get('/api/v1/subscription').set(await as(ids.ownerB, ids.orgA)).expect(404);
  });
});
