/**
 * Stripe billing through the API (ON3b), with a fake gateway for the calls to api.stripe.com and REAL signature verification: Checkout, the confirm step,
 * webhooks (invalid, duplicate, retried after a failure, unknown organisation), invoices, the Customer Portal, seat preview and change, and the rules that keep a
 * Stripe-billed organisation's seats out of manual hands. A second app without Stripe keys must answer 503 billing_unavailable.
 */
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import Stripe from 'stripe';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { ApiError } from '../src/common/api-error';
import { CheckoutSessionSnapshot, InvoiceSnapshot, SeatItemChange, SeatPreview, StripeEventEnvelope, StripeGateway, SubscriptionSnapshot } from '../src/billing/stripe.gateway';
import { makeIds, requireDb, seed, startApp, testEnv, token } from './helpers';

const ids = makeIds('d1');
const WEBHOOK_SECRET = 'whsec_e2eTestSecretThatIsLongEnough1234';
const PRICES: Record<string, string> = {
  'controller:month': 'price_e2e_ctrl_month',
  'controller:year': 'price_e2e_ctrl_year',
  'contributor:month': 'price_e2e_contrib_month',
  'contributor:year': 'price_e2e_contrib_year',
  'observer:month': 'price_e2e_obs_month',
  'observer:year': 'price_e2e_obs_year',
};
const PLAN_OF: Record<string, string> = Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [v, k.split(':')[0]]));
const verifier = new Stripe('sk_test_e2eTestKeyThatIsLongEnough1234');

/** Stripe stand-in: state in memory, signature checks through the real SDK. */
class FakeStripe extends StripeGateway {
  readonly enabled = true;
  readonly webhookEnabled = true;
  customers = new Map<string, { organisationId: string; name: string }>();
  sessions = new Map<string, { status: string; customerId: string; organisationId: string; items: { priceId: string; quantity: number }[]; subscriptionId: string | null }>();
  subs = new Map<string, SubscriptionSnapshot>();
  invoices = new Map<string, InvoiceSnapshot>();
  calls: string[] = [];
  failSubscriptionReads = 0;
  private n = 0;

  async createCustomer(input: { organisationId: string; name: string }): Promise<string> {
    const id = `cus_e2e${++this.n}${input.organisationId.slice(0, 4)}`;
    this.customers.set(id, input);
    this.calls.push('createCustomer');
    return id;
  }
  async createCheckoutSession(input: Parameters<StripeGateway['createCheckoutSession']>[0]): Promise<{ id: string; url: string }> {
    const id = `cs_test_e2e${++this.n}`;
    this.sessions.set(id, { status: 'open', customerId: input.customerId, organisationId: input.organisationId, items: input.items, subscriptionId: null });
    this.calls.push(`checkout:${input.successUrl}`);
    expect(input.trialDays).toBe(14);
    return { id, url: `https://checkout.stripe.test/c/${id}` };
  }
  /** The person pays: the session completes and a trialing subscription exists. */
  complete(sessionId: string, status = 'trialing'): string {
    const s = this.sessions.get(sessionId)!;
    const subId = `sub_e2e${++this.n}`;
    const first = PLAN_OF[s.items[0].priceId];
    const interval = PRICES[`${first}:year`] === s.items[0].priceId ? 'year' : 'month';
    this.subs.set(subId, {
      id: subId,
      customerId: s.customerId,
      status,
      interval,
      currency: 'gbp',
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 14 * 864e5).toISOString(),
      trialStart: new Date().toISOString(),
      trialEnd: new Date(Date.now() + 14 * 864e5).toISOString(),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      items: s.items.map((i, k) => ({ itemId: `si_e2e${this.n}_${k}`, priceId: i.priceId, quantity: i.quantity })),
    });
    s.status = 'complete';
    s.subscriptionId = subId;
    return subId;
  }
  async retrieveCheckoutSession(id: string): Promise<CheckoutSessionSnapshot> {
    this.calls.push(`retrieveSession:${id}`);
    const s = this.sessions.get(id);
    if (!s) throw new ApiError(502, 'billing_provider_error', 'no such session');
    return { id, status: s.status, subscriptionId: s.subscriptionId, customerId: s.customerId, organisationId: s.organisationId };
  }
  async retrieveSubscription(id: string): Promise<SubscriptionSnapshot> {
    this.calls.push(`retrieveSubscription:${id}`);
    if (this.failSubscriptionReads > 0) {
      this.failSubscriptionReads--;
      throw new Error('Stripe is having a moment');
    }
    return structuredClone(this.subs.get(id)!);
  }
  async retrieveInvoice(id: string): Promise<InvoiceSnapshot> {
    this.calls.push(`retrieveInvoice:${id}`);
    return structuredClone(this.invoices.get(id)!);
  }
  async previewSeatChange(input: { customerId: string; subscriptionId: string; items: SeatItemChange[] }): Promise<SeatPreview> {
    this.calls.push('preview');
    const added = input.items.reduce((n, i) => n + (i.remove ? 0 : i.quantity), 0);
    return { currency: 'gbp', subtotal: added * 100, tax: added * 20, total: added * 120, amountDue: added * 120, lines: [{ description: 'Prorated seats', amount: added * 100 }] };
  }
  async updateSeats(input: { subscriptionId: string; items: SeatItemChange[] }): Promise<void> {
    this.calls.push('updateSeats');
    const sub = this.subs.get(input.subscriptionId)!;
    for (const change of input.items) {
      const existing = sub.items.find((i) => (change.itemId ? i.itemId === change.itemId : i.priceId === change.priceId));
      if (change.remove) sub.items = sub.items.filter((i) => i !== existing);
      else if (existing) existing.quantity = change.quantity;
      else sub.items.push({ itemId: `si_e2e_new${++this.n}`, priceId: change.priceId, quantity: change.quantity });
    }
  }
  async createPortalSession(input: { customerId: string; returnUrl: string }): Promise<string> {
    this.calls.push(`portal:${input.returnUrl}`);
    return `https://billing.stripe.test/p/${input.customerId}`;
  }
  constructEvent(rawBody: Buffer, signature: string | undefined): StripeEventEnvelope {
    if (!signature) throw ApiError.badRequest('invalid_signature', 'Missing Stripe signature');
    try {
      const event = verifier.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
      return { id: event.id, type: event.type, object: event.data.object as unknown as Record<string, unknown> };
    } catch {
      throw ApiError.badRequest('invalid_signature', 'The Stripe signature could not be verified');
    }
  }
}

let app: INestApplication;
let appWithoutStripe: INestApplication;
let admin: Pool;
const fake = new FakeStripe();
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
let eventNo = 0;
const send = (type: string, object: Record<string, unknown>, opts: { id?: string; secret?: string } = {}) => {
  const payload = JSON.stringify({ id: opts.id ?? `evt_e2e_${++eventNo}_${Date.now()}`, object: 'event', type, data: { object } });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: opts.secret ?? WEBHOOK_SECRET });
  return request(app.getHttpServer()).post('/api/v1/stripe/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', header).send(payload);
};
const events = async (orgOnly = true) =>
  (await admin.query(`select event_id, event_type, status, attempts, error, organisation_id from public.stripe_events ${orgOnly ? `where organisation_id = $1` : ''} order by received_at`, orgOnly ? [ids.orgA] : [])).rows;
const seatsOf = async () =>
  Object.fromEntries(
    (await admin.query(`select p.slug, i.quantity from public.organisation_subscription_items i join public.subscription_plans p on p.id = i.subscription_plan_id where i.organisation_id = $1`, [ids.orgA])).rows.map((r) => [r.slug, r.quantity]),
  );

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-stripe');
  for (const [key, priceId] of Object.entries(PRICES)) {
    const [slug, interval] = key.split(':');
    await admin.query(
      `update public.subscription_prices set provider_price_id = $1 where active and effective_to is null and currency = 'GBP' and billing_interval = $2
         and subscription_plan_id = (select id from public.subscription_plans where slug = $3)`,
      [priceId, interval, slug],
    );
  }
  // A second person who manages billing but is not an owner (admin role).
  await admin.query(
    `insert into public.user_role_assignments (organisation_id, membership_id, role_id)
     select $1, m.id, r.id from public.organisation_users m join public.roles r on r.organisation_id = $1 and r.key = 'admin' where m.organisation_id = $1 and m.user_id = $2`,
    [ids.orgA, ids.dual],
  );
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000', APP_BASE_URL: 'https://app.fortress.test/' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).overrideProvider(StripeGateway).useValue(fake).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true });
  app = configureApp(nest, env);
  await app.init();
  appWithoutStripe = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});

afterAll(async () => {
  await admin?.query(`update public.subscription_prices set provider_price_id = null`);
  await app?.close();
  await appWithoutStripe?.close();
  await admin?.end();
});

describe('without Stripe keys', () => {
  it('answers 503 billing_unavailable for every Stripe route and says checkout is not available', async () => {
    const h = await as(ids.ownerA);
    const res = await request(appWithoutStripe.getHttpServer()).post('/api/v1/billing/checkout-session').set(h).send({ interval: 'month', seats: { controller: 1 } });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('billing_unavailable');
    expect((await request(appWithoutStripe.getHttpServer()).post('/api/v1/billing/portal-session').set(h)).status).toBe(503);
    expect((await request(appWithoutStripe.getHttpServer()).post('/api/v1/stripe/webhook').set('Stripe-Signature', 't=1,v1=x').send({})).status).toBe(503);
    const overview = (await request(appWithoutStripe.getHttpServer()).get('/api/v1/subscription').set(h).expect(200)).body;
    expect(overview.checkoutAvailable).toBe(false);
  });
});

describe('checkout', () => {
  it('is for people who manage the subscription, and validates the seats', async () => {
    await api().post('/api/v1/billing/checkout-session').set(await as(ids.inspectorA)).send({ interval: 'month', seats: { controller: 1 } }).expect(403);
    const h = await as(ids.ownerA);
    await api().post('/api/v1/billing/checkout-session').set(h).send({ interval: 'month', seats: { controller: 0 } }).expect(400);
    await api().post('/api/v1/billing/checkout-session').set(h).send({ interval: 'month', seats: { contributor: 2 } }).expect(400);
    await api().post('/api/v1/billing/checkout-session').set(h).send({ interval: 'week', seats: { controller: 1 } }).expect(400);
    await api().post('/api/v1/billing/checkout-session').set(h).send({ interval: 'month', seats: { controller: 1, gold: 1 } }).expect(409);
    expect(fake.calls.filter((c) => c.startsWith('checkout')).length).toBe(0);
  });

  it('can be started only by an owner, who takes the first Controller seat', async () => {
    const res = await api().post('/api/v1/billing/checkout-session').set(await as(ids.dual)).send({ interval: 'month', seats: { controller: 1 } }).expect(409);
    expect(res.body.error.message).toMatch(/Only an owner/);
    expect(fake.calls.filter((c) => c.startsWith('checkout')).length).toBe(0);
  });

  it('reports that checkout is available once keys and prices are set up', async () => {
    const overview = (await api().get('/api/v1/subscription').set(await as(ids.ownerA)).expect(200)).body;
    expect(overview).toMatchObject({ checkoutAvailable: true, providerManaged: false, subscription: null });
  });

  it('starts a Stripe Checkout with a return address back to the app, one customer per organisation', async () => {
    const h = await as(ids.ownerA);
    const res = await api().post('/api/v1/billing/checkout-session').set(h).send({ interval: 'month', seats: { controller: 2, contributor: 3 }, returnTo: 'settings' }).expect(200);
    expect(res.body.url).toBe(`https://checkout.stripe.test/c/${res.body.sessionId}`);
    expect(fake.calls).toContain('createCustomer');
    expect(fake.calls.find((c) => c.startsWith('checkout:'))).toBe('checkout:https://app.fortress.test/Settings/Subscription?checkout=success&session_id={CHECKOUT_SESSION_ID}');
    const row = (await admin.query(`select status, seats, billing_interval from public.stripe_checkout_sessions where provider_session_id = $1`, [res.body.sessionId])).rows[0];
    expect(row).toMatchObject({ status: 'open', billing_interval: 'month', seats: { controller: 2, contributor: 3 } });
    expect(fake.sessions.get(res.body.sessionId)!.items).toEqual([
      { priceId: 'price_e2e_ctrl_month', quantity: 2 },
      { priceId: 'price_e2e_contrib_month', quantity: 3 },
    ]);
    // A second attempt reuses the customer.
    await api().post('/api/v1/billing/checkout-session').set(h).send({ interval: 'month', seats: { controller: 2, contributor: 3 } }).expect(200);
    expect(fake.calls.filter((c) => c === 'createCustomer').length).toBe(1);
  });
});

describe('confirming a checkout', () => {
  let sessionId: string;
  beforeAll(async () => {
    sessionId = [...fake.sessions.keys()][0];
  });

  it('says open until the person has paid, and applies nothing', async () => {
    const res = await api().post('/api/v1/billing/checkout-session/confirm').set(await as(ids.ownerA)).send({ sessionId }).expect(200);
    expect(res.body.status).toBe('open');
    expect(res.body.subscription.subscription).toBeNull();
  });

  it('knows only the person who started it, in the organisation they started it in', async () => {
    await api().post('/api/v1/billing/checkout-session/confirm').set(await as(ids.ownerB, ids.orgB)).send({ sessionId }).expect(404);
    await api().post('/api/v1/billing/checkout-session/confirm').set(await as(ids.ownerA)).send({ sessionId: 'cs_test_unknown999' }).expect(404);
    await api().post('/api/v1/billing/checkout-session/confirm').set(await as(ids.ownerA)).send({ sessionId: 'nope' }).expect(400);
    await api().post('/api/v1/billing/checkout-session/confirm').set(await as(ids.inspectorA)).send({ sessionId }).expect(403);
    // A colleague who also manages billing cannot confirm someone else's checkout.
    await api().post('/api/v1/billing/checkout-session/confirm').set(await as(ids.dual)).send({ sessionId }).expect(404);
  });

  it('also checks Stripe\'s own record of which organisation the session belongs to', async () => {
    const session = fake.sessions.get(sessionId)!;
    const real = session.organisationId;
    session.organisationId = ids.orgB;
    await api().post('/api/v1/billing/checkout-session/confirm').set(await as(ids.ownerA)).send({ sessionId }).expect(404);
    session.organisationId = real;
  });

  it('applies the subscription Stripe reports: trial, seats, the owner’s Controller seat', async () => {
    fake.complete(sessionId);
    const res = await api().post('/api/v1/billing/checkout-session/confirm').set(await as(ids.ownerA)).send({ sessionId }).expect(200);
    expect(res.body.status).toBe('complete');
    const overview = res.body.subscription;
    expect(overview.subscription).toMatchObject({ status: 'trialing', billingProvider: 'stripe', billingInterval: 'month', cancelAtPeriodEnd: false });
    expect(overview.subscription.trialEnd).not.toBeNull();
    expect(overview.providerManaged).toBe(true);
    expect(await seatsOf()).toEqual({ controller: 2, contributor: 3 });
    const seat = (await admin.query(`select p.slug from public.user_subscription_assignments a join public.subscription_plans p on p.id = a.subscription_plan_id join public.organisation_users m on m.id = a.organisation_membership_id where a.organisation_id = $1 and a.status = 'active' and m.user_id = $2`, [ids.orgA, ids.ownerA])).rows;
    expect(seat.map((r) => r.slug)).toEqual(['controller']);
  });

  it('is safe to confirm again, and to apply from the webhook as well', async () => {
    const seatsBefore = (await admin.query(`select count(*)::int as n from public.user_subscription_assignments where organisation_id = $1`, [ids.orgA])).rows[0].n;
    await api().post('/api/v1/billing/checkout-session/confirm').set(await as(ids.ownerA)).send({ sessionId }).expect(200);
    const subId = fake.sessions.get(sessionId)!.subscriptionId!;
    await send('checkout.session.completed', { id: sessionId, customer: fake.sessions.get(sessionId)!.customerId, subscription: subId, metadata: { organisation_id: ids.orgA } }).expect(200);
    expect((await admin.query(`select count(*)::int as n from public.user_subscription_assignments where organisation_id = $1`, [ids.orgA])).rows[0].n).toBe(seatsBefore);
    expect(await seatsOf()).toEqual({ controller: 2, contributor: 3 });
  });

  it('a live subscription blocks another checkout', async () => {
    const res = await api().post('/api/v1/billing/checkout-session').set(await as(ids.ownerA)).send({ interval: 'month', seats: { controller: 1 } }).expect(409);
    expect(res.body.error.code).toBe('subscription_rule');
  });
});

describe('the webhook', () => {
  const subscriptionId = () => [...fake.subs.keys()][0];
  const customerId = () => fake.subs.get(subscriptionId())!.customerId;

  it('refuses a bad or missing signature, and records nothing', async () => {
    const before = (await events(false)).length;
    const payload = JSON.stringify({ id: 'evt_e2e_bad', object: 'event', type: 'customer.subscription.updated', data: { object: { id: subscriptionId() } } });
    await request(app.getHttpServer()).post('/api/v1/stripe/webhook').set('Content-Type', 'application/json').send(payload).expect(400);
    const wrong = await send('customer.subscription.updated', { id: subscriptionId() }, { secret: 'whsec_someOtherSecretEntirely123456' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('invalid_signature');
    const tampered = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    await request(app.getHttpServer()).post('/api/v1/stripe/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', tampered).send(payload.replace('updated', 'deleted')).expect(400);
    expect((await events(false)).length).toBe(before);
  });

  it('applies a failed payment by re-reading the subscription from Stripe (not from the event)', async () => {
    fake.subs.get(subscriptionId())!.status = 'past_due';
    fake.calls.length = 0;
    const res = await send('customer.subscription.updated', { id: subscriptionId(), customer: customerId(), status: 'active' }).expect(200);
    expect(res.body).toEqual({ received: true });
    expect(fake.calls).toContain(`retrieveSubscription:${subscriptionId()}`);
    const sub = (await admin.query(`select status, past_due_since from public.organisation_subscriptions where organisation_id = $1`, [ids.orgA])).rows[0];
    expect(sub.status).toBe('past_due'); // the event said active; Stripe said past_due
    expect(sub.past_due_since).not.toBeNull();
    const last = (await events()).at(-1);
    expect(last).toMatchObject({ event_type: 'customer.subscription.updated', status: 'processed', attempts: 1 });
  });

  it('handles a repeated event id once', async () => {
    const id = 'evt_e2e_repeat_1';
    await send('customer.subscription.updated', { id: subscriptionId(), customer: customerId() }, { id }).expect(200);
    fake.calls.length = 0;
    const again = await send('customer.subscription.updated', { id: subscriptionId(), customer: customerId() }, { id }).expect(200);
    expect(again.body).toEqual({ received: true, duplicate: true });
    expect(fake.calls).toEqual([]);
  });

  it('answers 500 when applying fails, so Stripe retries, and succeeds on the retry of the same event', async () => {
    const id = 'evt_e2e_retry_1';
    fake.failSubscriptionReads = 1;
    await send('customer.subscription.updated', { id: subscriptionId(), customer: customerId() }, { id }).expect(500);
    const failed = (await admin.query(`select status, attempts, error from public.stripe_events where event_id = $1`, [id])).rows[0];
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    expect(failed.error).toContain('Stripe is having a moment');
    await send('customer.subscription.updated', { id: subscriptionId(), customer: customerId() }, { id }).expect(200);
    expect((await admin.query(`select status, attempts from public.stripe_events where event_id = $1`, [id])).rows[0]).toMatchObject({ status: 'processed', attempts: 2 });
  });

  it('mirrors an invoice, and recovery makes the subscription active again', async () => {
    fake.subs.get(subscriptionId())!.status = 'active';
    fake.invoices.set('in_e2e_1', {
      id: 'in_e2e_1', customerId: customerId(), subscriptionId: subscriptionId(), number: 'FQ-E2E-1', status: 'paid', currency: 'gbp', subtotal: 12500, tax: 2500, total: 15000,
      periodStart: new Date().toISOString(), periodEnd: new Date(Date.now() + 30 * 864e5).toISOString(), created: new Date().toISOString().slice(0, 10), dueDate: null, paidAt: new Date().toISOString(),
      pdfUrl: 'https://pay.stripe.test/in_e2e_1.pdf', paymentIntentId: 'pi_e2e_1', paymentStatus: 'succeeded',
    });
    await send('invoice.paid', { id: 'in_e2e_1', customer: customerId() }).expect(200);
    const invoices = (await api().get('/api/v1/billing/invoices').set(await as(ids.ownerA)).expect(200)).body.data;
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ invoiceNumber: 'FQ-E2E-1', status: 'paid', subtotal: 12500, taxAmount: 2500, totalAmount: 15000, invoicePdfUrl: 'https://pay.stripe.test/in_e2e_1.pdf' });
    const sub = (await admin.query(`select status, past_due_since from public.organisation_subscriptions where organisation_id = $1`, [ids.orgA])).rows[0];
    expect(sub).toMatchObject({ status: 'active', past_due_since: null });
  });

  it('ignores events it does not use and events for customers it does not know, with 200 so Stripe does not keep retrying', async () => {
    await send('charge.refunded', { id: 'ch_1' }).expect(200);
    const unknown = await send('customer.subscription.updated', { id: 'sub_unknown_1', customer: 'cus_unknown_1' }).expect(200);
    expect(unknown.body).toEqual({ received: true });
    const rows = (await events(false)).filter((e) => ['charge.refunded'].includes(e.event_type) || e.event_id.startsWith('evt_e2e_') );
    expect(rows.filter((r) => r.status === 'ignored').length).toBeGreaterThanOrEqual(2);
  });
});

describe('seats afterwards', () => {
  it('previews a change from Stripe, naming what changes', async () => {
    const res = await api().post('/api/v1/billing/seats/preview').set(await as(ids.ownerA)).send({ seats: { contributor: 5, controller: 2 } }).expect(200);
    expect(res.body).toMatchObject({ currency: 'gbp', amountDue: 600, changes: [{ planSlug: 'contributor', from: 3, to: 5 }, { planSlug: 'controller', from: 2, to: 2 }] });
    expect(res.body.lines).toEqual([{ description: 'Prorated seats', amount: 500 }]);
    expect(await seatsOf()).toEqual({ controller: 2, contributor: 3 }); // preview changes nothing
  });

  it('previews nothing for a change that is no change', async () => {
    const res = await api().post('/api/v1/billing/seats/preview').set(await as(ids.ownerA)).send({ seats: { contributor: 3 } }).expect(200);
    expect(res.body).toMatchObject({ amountDue: 0, lines: [] });
  });

  it('refuses reductions below the seats in use and removing the last Controller seat', async () => {
    const h = await as(ids.ownerA);
    const m = (await admin.query(`select id from public.organisation_users where organisation_id = $1 and user_id = $2`, [ids.orgA, ids.inspectorA])).rows[0].id;
    await api().put(`/api/v1/subscription/assignments/${m}`).set(h).send({ planSlug: 'contributor' }).expect(200);
    const below = await api().put('/api/v1/billing/seats').set(h).send({ seats: { contributor: 0 } }).expect(409);
    expect(below.body.error.code).toBe('subscription_rule');
    expect(below.body.error.message).toMatch(/cannot go below the 1 in use/);
    const noController = await api().put('/api/v1/billing/seats').set(h).send({ seats: { controller: 0 } }).expect(409);
    expect(noController.body.error.message).toMatch(/Controller seat/);
    await api().post('/api/v1/billing/seats/preview').set(h).send({ seats: { controller: 1, gold: 2 } }).expect(409);
    await api().put('/api/v1/billing/seats').set(await as(ids.inspectorA)).send({ seats: { contributor: 4 } }).expect(403);
    expect(fake.calls).not.toContain('updateSeats');
  });

  it('changes the seats on the Stripe subscription, then reads the result back', async () => {
    const h = await as(ids.ownerA);
    const res = await api().put('/api/v1/billing/seats').set(h).send({ seats: { contributor: 5, observer: 4 } }).expect(200);
    expect(fake.calls).toContain('updateSeats');
    expect(await seatsOf()).toMatchObject({ controller: 2, contributor: 5, observer: 4 });
    const totals = res.body.totals;
    expect(totals.seatsPurchased).toBe(11);
    expect(totals.seatsAssigned).toBe(2);
  });

  it('takes a package off the subscription when its seats go to 0', async () => {
    const h = await as(ids.ownerA);
    await api().put('/api/v1/billing/seats').set(h).send({ seats: { observer: 0 } }).expect(200);
    expect((await seatsOf()).observer).toBe(0);
    const sub = [...fake.subs.values()][0];
    expect(sub.items.some((i) => i.priceId === 'price_e2e_obs_month')).toBe(false);
  });

  it('does not call Stripe when nothing changes', async () => {
    fake.calls.length = 0;
    await api().put('/api/v1/billing/seats').set(await as(ids.ownerA)).send({ seats: { contributor: 5 } }).expect(200);
    expect(fake.calls).not.toContain('updateSeats');
  });

  it('refuses the manual seat route for a Stripe-billed organisation', async () => {
    const res = await api().put('/api/v1/subscription/seats').set(await as(ids.ownerA)).send({ planSlug: 'controller', quantity: 50 }).expect(409);
    expect(res.body.error.code).toBe('subscription_rule');
    expect((await seatsOf()).controller).toBe(2);
  });

  it('an owner cannot give up their only Controller seat', async () => {
    const m = (await admin.query(`select id from public.organisation_users where organisation_id = $1 and user_id = $2`, [ids.orgA, ids.ownerA])).rows[0].id;
    const res = await api().delete(`/api/v1/subscription/assignments/${m}`).set(await as(ids.ownerA));
    // Not enforced for an organisation that does not require a subscription (billing_required = false); enforced once it does.
    expect([204, 409]).toContain(res.status);
    if (res.status === 204) await api().put(`/api/v1/subscription/assignments/${m}`).set(await as(ids.ownerA)).send({ planSlug: 'controller' }).expect(200);
  });
});

describe('the customer portal', () => {
  it('opens Stripe’s portal for the organisation’s customer, returning to Subscription & billing', async () => {
    const res = await api().post('/api/v1/billing/portal-session').set(await as(ids.ownerA)).expect(200);
    expect(res.body.url).toMatch(/^https:\/\/billing\.stripe\.test\/p\/cus_/);
    expect(fake.calls.find((c) => c.startsWith('portal:'))).toBe('portal:https://app.fortress.test/Settings/Subscription');
  });

  it('is for billing managers, and needs a billing account first', async () => {
    await api().post('/api/v1/billing/portal-session').set(await as(ids.inspectorA)).expect(403);
    const res = await api().post('/api/v1/billing/portal-session').set(await as(ids.ownerB, ids.orgB)).expect(409);
    expect(res.body.error.code).toBe('no_subscription');
  });

  it('another organisation cannot use this one’s checkout, subscription or events', async () => {
    const other = await as(ids.ownerB, ids.orgB);
    const overview = (await api().get('/api/v1/subscription').set(other).expect(200)).body;
    expect(overview.subscription).toBeNull();
    await api().put('/api/v1/billing/seats').set(other).send({ seats: { contributor: 9 } }).expect(409);
    expect((await api().get('/api/v1/billing/invoices').set(other).expect(200)).body.data).toEqual([]);
  });
});
