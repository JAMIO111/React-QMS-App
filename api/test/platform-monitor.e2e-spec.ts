/**
 * ON5a: the operator's monitor through the API (operators with MFA only; counts and billing, never business data) and the scheduled jobs (secret, dry run by default,
 * real archive, reconcile with a fake Stripe that can fail for one subscription). The first app has no CRON_SECRET and must answer 503.
 */
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { ApiError } from '../src/common/api-error';
import { StripeGateway, SubscriptionSnapshot } from '../src/billing/stripe.gateway';
import { makeIds, requireDb, seed, startApp, testEnv, token } from './helpers';

const ids = makeIds('d3');
const SECRET = 'cron-secret-for-e2e-tests-0123456789';
const PRICES: Record<string, string> = { controller: 'price_e2e3_ctrl_month', contributor: 'price_e2e3_contrib_month' };
const ORG = (n: number) => `d3000000-0000-0000-0000-0000000c${String(n).padStart(4, '0')}`;

/** Stripe stand-in for the reconcile job: returns a prepared snapshot per subscription, or fails. */
class FakeStripe extends StripeGateway {
  readonly enabled = true;
  readonly webhookEnabled = false;
  snapshots = new Map<string, SubscriptionSnapshot | Error>();
  reads: string[] = [];
  async retrieveSubscription(id: string): Promise<SubscriptionSnapshot> {
    this.reads.push(id);
    const s = this.snapshots.get(id);
    if (!s) throw new ApiError(502, 'billing_provider_error', 'no such subscription');
    if (s instanceof Error) throw s;
    return structuredClone(s);
  }
  async createCustomer(): Promise<string> { throw new Error('not used'); }
  async createCheckoutSession(): Promise<{ id: string; url: string }> { throw new Error('not used'); }
  async retrieveCheckoutSession(): Promise<never> { throw new Error('not used'); }
  async retrieveInvoice(): Promise<never> { throw new Error('not used'); }
  async previewSeatChange(): Promise<never> { throw new Error('not used'); }
  async updateSeats(): Promise<void> { throw new Error('not used'); }
  async createPortalSession(): Promise<string> { throw new Error('not used'); }
  constructEvent(): never { throw new Error('not used'); }
}

let operatorApp: INestApplication;
let cronApp: INestApplication;
let plainApp: INestApplication;
let admin: Pool;
const fake = new FakeStripe();
const api = () => request(operatorApp.getHttpServer());
const cron = () => request(cronApp.getHttpServer());
const as = async (user: string, claims: Record<string, unknown> = {}) => ({ Authorization: `Bearer ${await token(user, claims)}` });
const mfa = () => as(ids.outsider, { aal: 'aal2' });
const bearer = (secret = SECRET) => ({ Authorization: `Bearer ${secret}` });
const statusOf = async (org: string) => (await admin.query('select status, archived_reason from public.organisations where id = $1', [org])).rows[0];

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-monitor');
  await admin.query(`insert into public.platform_admins (user_id, note) values ($1, 'e2e operator') on conflict do nothing`, [ids.outsider]);
  for (const [slug, id] of Object.entries(PRICES)) {
    await admin.query(
      `update public.subscription_prices set provider_price_id = $1 where active and effective_to is null and currency = 'GBP' and billing_interval = 'month'
         and subscription_plan_id = (select id from public.subscription_plans where slug = $2)`,
      [id, slug],
    );
  }
  operatorApp = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000', CRON_SECRET: SECRET });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).overrideProvider(StripeGateway).useValue(fake).compile();
  cronApp = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true }), env);
  await cronApp.init();
  plainApp = operatorApp;
});

afterAll(async () => {
  await admin?.query(`update public.subscription_prices set provider_price_id = null`);
  await operatorApp?.close();
  await cronApp?.close();
  await admin?.end();
});

const ROUTES = ['organisations', 'revenue', 'payments', 'webhooks', 'activity'];

describe('the operator monitor', () => {
  it.each(ROUTES)('/platform/%s needs a sign-in, tells a normal user nothing, and asks an operator without MFA to verify', async (route) => {
    await api().get(`/api/v1/platform/${route}`).expect(401);
    expect((await api().get(`/api/v1/platform/${route}`).set(await as(ids.ownerA, { aal: 'aal2' })).expect(404)).body.error.code).toBe('not_found');
    expect((await api().get(`/api/v1/platform/${route}`).set(await as(ids.outsider, { aal: 'aal1' })).expect(403)).body.error.code).toBe('mfa_required');
    await api().get(`/api/v1/platform/${route}`).set(await mfa()).expect(200);
  });

  it('lists organisations with owners, members, billing and counts, and searches by name or owner', async () => {
    await admin.query(`insert into public.organisation_subscriptions (organisation_id, billing_provider, provider_subscription_id, status, billing_interval, current_period_end)
      values ($1, 'stripe', 'sub_e2e3_a', 'active', 'month', now() + interval '10 days') on conflict do nothing`, [ids.orgA]);
    await admin.query(
      `insert into public.organisation_subscription_items (organisation_id, organisation_subscription_id, subscription_plan_id, subscription_price_id, quantity, unit_amount_snapshot, currency)
       select $1, s.id, p.id, pr.id, 2, pr.unit_amount, 'GBP' from public.organisation_subscriptions s, public.subscription_plans p
         join public.subscription_prices pr on pr.subscription_plan_id = p.id and pr.billing_interval = 'month' and pr.currency = 'GBP' and pr.active and pr.effective_to is null
        where s.organisation_id = $1 and p.slug = 'controller' on conflict do nothing`,
      [ids.orgA],
    );
    const res = (await api().get('/api/v1/platform/organisations?search=Alpha&limit=200').set(await mfa()).expect(200)).body;
    expect(res.total).toBeGreaterThanOrEqual(1); // other suites seed an organisation of the same name
    const alpha = res.data.find((o: { organisationId: string }) => o.organisationId === ids.orgA);
    expect(alpha).toMatchObject({
      organisationId: ids.orgA, name: 'Alpha Precision', status: 'active', ownerEmails: [`${ids.ownerA}@example.test`], subscriptionStatus: 'active', billingProvider: 'stripe',
      billingInterval: 'month', seatsPurchased: 2, mrrPence: 5000,
    });
    expect(alpha.members).toBeGreaterThanOrEqual(1);
    const byOwner = (await api().get(`/api/v1/platform/organisations?search=${encodeURIComponent(`${ids.ownerB}@example`)}`).set(await mfa()).expect(200)).body;
    expect(byOwner.data.map((o: { organisationId: string }) => o.organisationId)).toEqual([ids.orgB]);
    const paged = (await api().get('/api/v1/platform/organisations?limit=1&offset=0').set(await mfa()).expect(200)).body;
    expect(paged.data).toHaveLength(1);
    expect(paged.total).toBeGreaterThanOrEqual(2);
    await api().get('/api/v1/platform/organisations?limit=0').set(await mfa()).expect(400);
    await api().get('/api/v1/platform/organisations?limit=500').set(await mfa()).expect(400);
  });

  it('shows revenue, payments, webhook health and activity', async () => {
    await admin.query(`insert into public.billing_invoices (organisation_id, provider_invoice_id, invoice_number, subtotal, tax_amount, total_amount, status, invoice_date, paid_at)
      values ($1, 'in_e2e3_1', 'FQ-E2E3-1', 5000, 1000, 6000, 'paid', current_date, now()) on conflict do nothing`, [ids.orgA]);
    await admin.query(`insert into public.stripe_events (event_id, event_type, status, error, attempts) values ('evt_e2e3_bad', 'invoice.paid', 'failed', 'Boom', 2) on conflict do nothing`);
    const revenue = (await api().get('/api/v1/platform/revenue').set(await mfa()).expect(200)).body;
    expect(revenue).toMatchObject({ currency: 'GBP', mrrPence: expect.any(Number), arrPence: expect.any(Number), trialMrrPence: expect.any(Number) });
    expect(revenue.mrrPence).toBeGreaterThanOrEqual(5000);
    expect(revenue.arrPence).toBe(revenue.mrrPence * 12);
    expect(revenue.seats.map((s: { slug: string }) => s.slug)).toEqual(['observer', 'contributor', 'controller']);
    const payments = (await api().get('/api/v1/platform/payments?limit=5').set(await mfa()).expect(200)).body;
    expect(payments.invoices.find((i: { number: string }) => i.number === 'FQ-E2E3-1')).toMatchObject({ organisation: 'Alpha Precision', total: 6000, tax: 1000 });
    const hooks = (await api().get('/api/v1/platform/webhooks?hours=48').set(await mfa()).expect(200)).body;
    expect(hooks.hours).toBe(48);
    expect(hooks.failed.find((f: { eventId: string }) => f.eventId === 'evt_e2e3_bad')).toMatchObject({ error: 'Boom', attempts: 2 });
    await admin.query(`insert into public.subscription_audit_logs (organisation_id, event_type, details) values ($1, 'seats_added', '{"plan":"controller","from":0,"to":2,"unitAmount":2500}')`, [ids.orgA]);
    const activity = (await api().get('/api/v1/platform/activity?limit=100').set(await mfa()).expect(200)).body;
    expect(activity.data.length).toBeGreaterThan(0);
    expect(activity.data[0]).toMatchObject({ at: expect.any(String), kind: expect.any(String), event: expect.any(String), organisation: expect.any(String) });
    const seats = activity.data.find((a: { event: string }) => a.event === 'seats_added');
    expect(seats).toMatchObject({ kind: 'billing', organisation: 'Alpha Precision' });
    expect(seats.details).toEqual({ plan: 'controller', from: 0, to: 2 }); // the unit price is left out
    await api().get('/api/v1/platform/webhooks?hours=0').set(await mfa()).expect(400);
    await api().get('/api/v1/platform/activity?limit=0').set(await mfa()).expect(400);
  });

  it('never exposes business data: no route of the monitor returns anything from the quality tables', async () => {
    const all = JSON.stringify([
      (await api().get('/api/v1/platform/organisations').set(await mfa())).body,
      (await api().get('/api/v1/platform/activity?limit=200').set(await mfa())).body,
      (await api().get('/api/v1/platform/payments').set(await mfa())).body,
    ]);
    expect(all).not.toContain('NCM-26-001'); // the seeded non-conformance of each organisation
  });
});

describe('the scheduled jobs', () => {
  it('answer 503 on a server with no CRON_SECRET, whatever is sent', async () => {
    const res = await request(plainApp.getHttpServer()).get('/api/v1/internal/cron/reconcile').set(bearer()).expect(503);
    expect(res.body.error.code).toBe('cron_unavailable');
    await request(plainApp.getHttpServer()).post('/api/v1/internal/cron/abandoned-setups').expect(503);
  });

  it('need the secret: none, wrong, or of a different length is 401', async () => {
    for (const route of ['reconcile', 'abandoned-setups']) {
      await cron().get(`/api/v1/internal/cron/${route}`).expect(401);
      await cron().get(`/api/v1/internal/cron/${route}`).set(bearer('wrong')).expect(401);
      await cron().get(`/api/v1/internal/cron/${route}`).set(bearer(SECRET.replace(/.$/, 'x'))).expect(401);
      await cron().post(`/api/v1/internal/cron/${route}`).set({ Authorization: SECRET }).expect(401);
    }
  });

  describe('abandoned set-ups', () => {
    const OLD_UNPAID = ORG(1);
    const NEW_UNPAID = ORG(2);
    const GRANDFATHERED = ORG(3);
    beforeAll(async () => {
      for (const [id, slug, billing, age] of [[OLD_UNPAID, 'old-unpaid', true, 40], [NEW_UNPAID, 'new-unpaid', true, 1], [GRANDFATHERED, 'old-free', false, 400]] as const) {
        await admin.query(`insert into public.organisations (id, name, slug, billing_required, created_at) values ($1, $2, $3, $4, now() - make_interval(days => $5))`, [id, `Cron ${slug}`, `cron-e2e3-${slug}`, billing, age]);
      }
    });

    it('is a dry run unless asked otherwise: it lists and changes nothing', async () => {
      const res = (await cron().get('/api/v1/internal/cron/abandoned-setups').set(bearer()).expect(200)).body;
      expect(res).toMatchObject({ dryRun: true, archived: 0, unpaidDays: 14, lapsedDays: 90 });
      expect(res.unpaid.map((o: { organisationId: string }) => o.organisationId)).toContain(OLD_UNPAID);
      const names = res.unpaid.map((o: { name: string }) => o.name);
      expect(names).not.toContain('Cron new-unpaid');
      expect(names).not.toContain('Cron old-free');
      expect((await statusOf(OLD_UNPAID)).status).toBe('active');
    });

    it('archives what it listed when told to, by GET (as Vercel Cron calls) or POST, and only that', async () => {
      const res = (await cron().get('/api/v1/internal/cron/abandoned-setups?dryRun=false').set(bearer()).expect(200)).body;
      expect(res.dryRun).toBe(false);
      expect(res.archived).toBeGreaterThanOrEqual(1);
      expect(await statusOf(OLD_UNPAID)).toEqual({ status: 'archived', archived_reason: 'unpaid_setup' });
      expect((await statusOf(NEW_UNPAID)).status).toBe('active');
      expect((await statusOf(GRANDFATHERED)).status).toBe('active');
      // Alpha and Beta (seeded, existing organisations) are not required to have a subscription: untouched.
      expect((await statusOf(ids.orgA)).status).toBe('active');
      expect((await statusOf(ids.orgB)).status).toBe('active');
    });

    it('is safe to run again', async () => {
      const again = (await cron().post('/api/v1/internal/cron/abandoned-setups?dryRun=false').set(bearer()).expect(200)).body;
      expect(again.unpaid.map((o: { organisationId: string }) => o.organisationId)).not.toContain(OLD_UNPAID);
      expect((await statusOf(OLD_UNPAID)).status).toBe('archived');
    });

    it('refuses thresholds that would archive too eagerly', async () => {
      await cron().get('/api/v1/internal/cron/abandoned-setups?unpaidDays=1').set(bearer()).expect(400);
      await cron().get('/api/v1/internal/cron/abandoned-setups?lapsedDays=5').set(bearer()).expect(400);
      await cron().get('/api/v1/internal/cron/abandoned-setups?dryRun=maybe').set(bearer()).expect(400);
    });
  });

  describe('reconcile', () => {
    const snapshot = (id: string, status: string): SubscriptionSnapshot => ({
      id, customerId: `cus_e2e3_00${id.slice(-1)}`, status, interval: 'month', currency: 'gbp', currentPeriodStart: new Date().toISOString(), currentPeriodEnd: new Date(Date.now() + 20 * 864e5).toISOString(),
      trialStart: null, trialEnd: null, cancelAtPeriodEnd: false, canceledAt: null, items: [{ itemId: 'si_1', priceId: PRICES.controller, quantity: 1 }],
    });
    const SUBS = [ORG(11), ORG(12), ORG(13)];
    beforeAll(async () => {
      for (const [i, org] of SUBS.entries()) {
        await admin.query(`insert into public.organisations (id, name, slug, billing_required) values ($1, $2, $3, true)`, [org, `Reconcile ${i}`, `reconcile-e2e3-${i}`]);
        await admin.query(`insert into public.organisation_settings (organisation_id) values ($1) on conflict do nothing`, [org]);
        await admin.query(`insert into public.billing_customers (organisation_id, provider_customer_id) values ($1, $2)`, [org, `cus_e2e3_${`00${i + 1}`.slice(-3)}`]);
        await admin.query(
          `insert into public.organisation_subscriptions (organisation_id, billing_provider, provider_customer_id, provider_subscription_id, status, billing_interval, current_period_end, provider_synced_at)
           values ($1, 'stripe', $2, $3, 'trialing', 'month', now() + interval '5 days', now() - make_interval(hours => $4))`,
          [org, `cus_e2e3_${`00${i + 1}`.slice(-3)}`, `sub_e2e3_r${i + 1}`, 5 - i],
        );
      }
      fake.snapshots.set('sub_e2e3_r1', snapshot('sub_e2e3_r1', 'active'));
      fake.snapshots.set('sub_e2e3_r2', new Error('Stripe is having a moment'));
      fake.snapshots.set('sub_e2e3_r3', snapshot('sub_e2e3_r3', 'past_due'));
    });

    it('re-reads stale subscriptions from Stripe, applies them, and reports one failure without stopping the rest', async () => {
      const res = (await cron().get('/api/v1/internal/cron/reconcile?limit=200').set(bearer()).expect(200)).body;
      expect(res.checked).toBeGreaterThanOrEqual(3);
      expect(res.failed.map((f: { organisationId: string }) => f.organisationId)).toContain(SUBS[1]);
      expect(res.failed.find((f: { organisationId: string }) => f.organisationId === SUBS[1]).error).toContain('Stripe is having a moment');
      const rows = (await admin.query('select organisation_id, status, provider_synced_at > now() - interval \'1 minute\' as fresh from public.organisation_subscriptions where organisation_id = any($1)', [SUBS])).rows;
      const by = Object.fromEntries(rows.map((r) => [r.organisation_id, r]));
      expect(by[SUBS[0]]).toMatchObject({ status: 'active', fresh: true });
      expect(by[SUBS[2]]).toMatchObject({ status: 'past_due', fresh: true });
      expect(by[SUBS[1]]).toMatchObject({ status: 'trialing', fresh: false }); // the failed one is left as it was
    });

    it('leaves recently synced subscriptions alone, so running it again does little', async () => {
      fake.reads.length = 0;
      const again = (await cron().post('/api/v1/internal/cron/reconcile?limit=200').set(bearer()).expect(200)).body;
      expect(fake.reads).not.toContain('sub_e2e3_r1');
      expect(fake.reads).not.toContain('sub_e2e3_r3');
      expect(fake.reads).toContain('sub_e2e3_r2'); // the one that failed is tried again
      expect(again.failed.length).toBeGreaterThanOrEqual(1);
    });

    it('honours the limit and the stale window, and rejects nonsense', async () => {
      fake.reads.length = 0;
      const one = (await cron().get('/api/v1/internal/cron/reconcile?limit=1&staleMinutes=1').set(bearer()).expect(200)).body;
      expect(one.checked).toBe(1);
      await cron().get('/api/v1/internal/cron/reconcile?limit=0').set(bearer()).expect(400);
      await cron().get('/api/v1/internal/cron/reconcile?limit=500').set(bearer()).expect(400);
    });
  });
});
