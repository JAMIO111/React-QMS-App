/**
 * Paying by invoice through the API (docs/invoice-billing-plan.md IV2), with a fake gateway for the calls to api.stripe.com and REAL webhook signature verification:
 * starting an invoiced subscription (owner only, billing address, VAT verified with Stripe, one organisation per company, a retry is the same subscription), what the overview
 * says, the limits while the first invoice is unpaid (seats, reporting keys) and how paying lifts them, the operator's list and switches. Without Stripe keys it answers 503.
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
import {
  CheckoutSessionSnapshot,
  InvoiceBillingDetails,
  InvoiceSnapshot,
  SeatItemChange,
  SeatPreview,
  StripeEventEnvelope,
  StripeGateway,
  SubscriptionSnapshot,
} from '../src/billing/stripe.gateway';
import { makeIds, requireDb, seed, startApp, testEnv, token } from './helpers';

const ids = makeIds('d6');
const WEBHOOK_SECRET = 'whsec_e2eInvoiceSecretThatIsLongEnough1234';
const PRICES: Record<string, string> = {
  'controller:month': 'price_iv_ctrl_month',
  'controller:year': 'price_iv_ctrl_year',
  'contributor:month': 'price_iv_contrib_month',
  'contributor:year': 'price_iv_contrib_year',
  'observer:month': 'price_iv_obs_month',
  'observer:year': 'price_iv_obs_year',
  'operator:month': 'price_iv_op_month',
  'operator:year': 'price_iv_op_year',
  'organisation:month': 'price_iv_org_month',
  'organisation:year': 'price_iv_org_year',
};
const verifier = new Stripe('sk_test_e2eInvoiceKeyThatIsLongEnough1234');

/** Stripe stand-in: state in memory, signature checks through the real SDK. */
class FakeStripe extends StripeGateway {
  readonly enabled = true;
  readonly webhookEnabled = true;
  customers = new Map<string, { organisationId: string; name: string; details?: InvoiceBillingDetails }>();
  subs = new Map<string, SubscriptionSnapshot>();
  invoices = new Map<string, InvoiceSnapshot>();
  created = new Map<string, { subscriptionId: string; invoiceId: string | null }>();
  calls: string[] = [];
  vatResult: 'verified' | 'invalid' = 'verified';
  lastSubscription?: { daysUntilDue: number; items: { priceId: string; quantity: number }[] };
  lastChange?: { items: SeatItemChange[]; collectionMethod: string };
  private n = 0;

  async createCustomer(input: { organisationId: string; name: string }): Promise<string> {
    const id = `cus_iv${++this.n}${input.organisationId.slice(-3)}`;
    this.customers.set(id, input);
    this.calls.push('createCustomer');
    return id;
  }
  async updateCustomerBilling(customerId: string, details: InvoiceBillingDetails): Promise<{ vat: 'none' | 'verified' | 'pending' }> {
    this.calls.push('updateCustomerBilling');
    if (details.vatNumber && this.vatResult === 'invalid') throw new ApiError(400, 'vat_number_invalid', 'That VAT number could not be verified.');
    this.customers.get(customerId)!.details = details;
    return { vat: details.vatNumber ? 'verified' : 'none' };
  }
  async createInvoiceSubscription(input: Parameters<StripeGateway['createInvoiceSubscription']>[0]): Promise<{ subscriptionId: string; invoiceId: string | null }> {
    this.calls.push('createInvoiceSubscription');
    this.lastSubscription = { daysUntilDue: input.daysUntilDue, items: input.items };
    const key = `${input.organisationId}:${input.clientKey}`;
    const again = this.created.get(key);
    if (again) return again; // Stripe's idempotency key
    const subId = `sub_iv${++this.n}`;
    const invoiceId = `in_iv${++this.n}`;
    this.invoices.set(invoiceId, this.makeInvoice(invoiceId, input.customerId, subId, input.items.reduce((t, i) => t + i.quantity * 2500, 0)));
    this.subs.set(subId, {
      id: subId,
      customerId: input.customerId,
      status: 'active',
      interval: input.items[0].priceId.endsWith('year') ? 'year' : 'month',
      currency: 'gbp',
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * 864e5).toISOString(),
      trialStart: null,
      trialEnd: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      collectionMethod: 'send_invoice',
      daysUntilDue: input.daysUntilDue,
      latestInvoiceId: invoiceId,
      items: input.items.map((i, k) => ({ itemId: `si_iv${this.n}_${k}`, priceId: i.priceId, quantity: i.quantity })),
    });
    const result = { subscriptionId: subId, invoiceId };
    this.created.set(key, result);
    return result;
  }
  makeInvoice(id: string, customerId: string, subscriptionId: string, subtotal: number, dueInDays = 14): InvoiceSnapshot {
    return {
      id,
      customerId,
      subscriptionId,
      number: `INV-IV-${String(this.invoices.size + 1).padStart(4, '0')}`,
      status: 'open',
      currency: 'gbp',
      subtotal,
      tax: 0,
      total: subtotal,
      periodStart: new Date().toISOString(),
      periodEnd: new Date(Date.now() + 30 * 864e5).toISOString(),
      created: new Date().toISOString().slice(0, 10),
      dueDate: new Date(Date.now() + dueInDays * 864e5).toISOString().slice(0, 10),
      paidAt: null,
      pdfUrl: `https://invoice.stripe.test/pdf/${id}`,
      hostedUrl: `https://invoice.stripe.test/i/${id}`,
      paymentIntentId: null,
      paymentStatus: null,
    };
  }
  async createCheckoutSession(): Promise<{ id: string; url: string }> {
    throw new Error('not used here');
  }
  async retrieveCheckoutSession(): Promise<CheckoutSessionSnapshot> {
    throw new Error('not used here');
  }
  async retrieveSubscription(id: string): Promise<SubscriptionSnapshot> {
    return structuredClone(this.subs.get(id)!);
  }
  async retrieveInvoice(id: string): Promise<InvoiceSnapshot> {
    return structuredClone(this.invoices.get(id)!);
  }
  async previewSeatChange(): Promise<SeatPreview> {
    throw new Error('not used here');
  }
  /** An increase on an invoiced subscription makes a new open invoice and the seats follow at once. */
  async updateSeats(input: { subscriptionId: string; items: SeatItemChange[]; collectionMethod: string }): Promise<void> {
    this.calls.push('updateSeats');
    this.lastChange = { items: input.items, collectionMethod: input.collectionMethod };
    const sub = this.subs.get(input.subscriptionId)!;
    let added = 0;
    for (const change of input.items) {
      const existing = sub.items.find((i) => (change.itemId ? i.itemId === change.itemId : i.priceId === change.priceId));
      if (existing) {
        added += Math.max(0, change.quantity - existing.quantity);
        existing.quantity = change.quantity;
      } else {
        added += change.quantity;
        sub.items.push({ itemId: `si_iv_new${++this.n}`, priceId: change.priceId, quantity: change.quantity });
      }
    }
    if (added > 0) {
      const id = `in_iv${++this.n}`;
      this.invoices.set(id, this.makeInvoice(id, sub.customerId, sub.id, added * 2500));
      sub.latestInvoiceId = id;
    }
  }
  async createPortalSession(): Promise<string> {
    throw new Error('not used here');
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
const as = async (user: string, org = ids.orgA, claims: Record<string, unknown> = {}) => ({ Authorization: `Bearer ${await token(user, claims)}`, 'X-Organisation-Id': org });
const operator = async () => ({ Authorization: `Bearer ${await token(ids.outsider, { aal: 'aal2' })}` });
let eventNo = 0;
const send = (type: string, object: Record<string, unknown>) => {
  const payload = JSON.stringify({ id: `evt_iv_${++eventNo}_${Date.now()}`, object: 'event', type, data: { object } });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return request(app.getHttpServer()).post('/api/v1/stripe/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', header).send(payload);
};

const company = (overrides: Record<string, unknown> = {}) => ({
  legalName: 'Acme Fabrications Ltd',
  billingEmail: 'accounts@acme.test',
  addressLine1: '1 High Street',
  city: 'Leeds',
  postcode: 'LS1 1AA',
  country: 'GB',
  vatNumber: 'GB 123 456 789',
  poReference: 'PO-1234',
  ...overrides,
});
const body = (overrides: Record<string, unknown> = {}) => ({ interval: 'month', seats: { controller: 1, contributor: 2 }, company: company(), clientKey: 'attempt-0001', ...overrides });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-invoice');
  for (const [key, priceId] of Object.entries(PRICES)) {
    const [slug, interval] = key.split(':');
    await admin.query(
      `update public.subscription_prices set provider_price_id = $1 where active and effective_to is null and currency = 'GBP' and billing_interval = $2
         and subscription_plan_id = (select id from public.subscription_plans where slug = $3)`,
      [priceId, interval, slug],
    );
  }
  await admin.query(`insert into public.platform_admins (user_id, note) values ($1, 'e2e operator') on conflict do nothing`, [ids.outsider]);
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
  it('answers 503 billing_unavailable', async () => {
    const res = await request(appWithoutStripe.getHttpServer()).post('/api/v1/billing/invoice-subscription').set(await as(ids.ownerA)).send(body());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('billing_unavailable');
  });
});

describe('starting an invoiced subscription', () => {
  it('is for people who manage the subscription and asks for a company, an address and seats', async () => {
    await api().post('/api/v1/billing/invoice-subscription').set(await as(ids.inspectorA)).send(body()).expect(403);
    const h = await as(ids.ownerA);
    await api().post('/api/v1/billing/invoice-subscription').set(h).send(body({ company: company({ addressLine1: undefined }) })).expect(400);
    await api().post('/api/v1/billing/invoice-subscription').set(h).send(body({ company: company({ billingEmail: 'nope' }) })).expect(400);
    await api().post('/api/v1/billing/invoice-subscription').set(h).send(body({ company: company({ country: 'United Kingdom' }) })).expect(400);
    await api().post('/api/v1/billing/invoice-subscription').set(h).send(body({ seats: { contributor: 2 } })).expect(400);
    await api().post('/api/v1/billing/invoice-subscription').set(h).send(body({ clientKey: 'x' })).expect(400);
    await api().post('/api/v1/billing/invoice-subscription').set(h).send({ ...body(), extra: true }).expect(400);
    expect(fake.calls.filter((c) => c === 'createInvoiceSubscription').length).toBe(0);
  });

  it('can be started only by an owner', async () => {
    const res = await api().post('/api/v1/billing/invoice-subscription').set(await as(ids.dual)).send(body()).expect(409);
    expect(res.body.error.message).toMatch(/Only an owner/);
    expect(fake.calls.filter((c) => c === 'createInvoiceSubscription').length).toBe(0);
  });

  it('checks the company for the form without saving anything', async () => {
    const res = await api().post('/api/v1/billing/invoice-company/check').set(await as(ids.ownerA)).send({ legalName: 'Acme Fabrications Ltd', vatNumber: 'GB123456789' }).expect(200);
    expect(res.body).toEqual({ problems: [] });
  });

  it('puts the company on the customer, makes the subscription payable in 14 days and applies it with its first invoice', async () => {
    const res = await api().post('/api/v1/billing/invoice-subscription').set(await as(ids.ownerA)).send(body()).expect(200);
    expect(res.body.vat).toBe('verified');
    expect(fake.calls).toEqual(['createCustomer', 'updateCustomerBilling', 'createInvoiceSubscription']);
    expect([...fake.customers.values()][0].details).toMatchObject({ legalName: 'Acme Fabrications Ltd', billingEmail: 'accounts@acme.test', vatNumber: 'GB 123 456 789', poReference: 'PO-1234' });
    expect(fake.lastSubscription).toEqual({
      daysUntilDue: 14,
      items: [
        { priceId: 'price_iv_ctrl_month', quantity: 1 },
        { priceId: 'price_iv_contrib_month', quantity: 2 },
        { priceId: 'price_iv_org_month', quantity: 1 }, // the organisation fee, once
      ],
    });
    const sub = res.body.subscription.subscription;
    expect(sub).toMatchObject({
      status: 'active',
      paymentRoute: 'invoice',
      paymentTermsDays: 14,
      trialEnd: null,
      gracePeriodDays: 3,
      firstInvoicePending: true,
      billing: { legalName: 'Acme Fabrications Ltd', email: 'accounts@acme.test', vatNumber: 'GB123456789', purchaseOrder: 'PO-1234' },
    });
    expect(sub.openInvoice).toMatchObject({ total: 10000, currency: 'GBP', overdueDays: 0, hostedUrl: expect.stringMatching(/^https:\/\/invoice\.stripe\.test\/i\/in_iv/) });
    expect(sub.openInvoice.dueOn).toBe(new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10));
    const row = (await admin.query(`select collection_method, billing_company_key from public.organisation_subscriptions where organisation_id = $1`, [ids.orgA])).rows[0];
    expect(row).toEqual({ collection_method: 'invoice', billing_company_key: 'acmefabrications' });
    expect((await admin.query(`select count(*)::int as n from public.platform_invoice_alerts where organisation_id = $1 and kind = 'started'`, [ids.orgA])).rows[0].n).toBe(1);
  });

  it('is the same subscription when the same attempt is sent again', async () => {
    await api().post('/api/v1/billing/invoice-subscription').set(await as(ids.ownerA)).send(body()).expect(200);
    expect((await admin.query(`select count(*)::int as n from public.organisation_subscriptions where organisation_id = $1`, [ids.orgA])).rows[0].n).toBe(1);
    expect(fake.subs.size).toBe(1);
    expect((await admin.query(`select count(*)::int as n from public.billing_invoices where organisation_id = $1`, [ids.orgA])).rows[0].n).toBe(1);
    // A different attempt is refused: the organisation now has a subscription.
    await api().post('/api/v1/billing/invoice-subscription').set(await as(ids.ownerA)).send(body({ clientKey: 'attempt-0002' })).expect(409);
  });

  it('lists the invoice with its payment page', async () => {
    const list = (await api().get('/api/v1/billing/invoices').set(await as(ids.ownerA)).expect(200)).body.data;
    expect(list[0]).toMatchObject({ status: 'open', totalAmount: 10000, hostedInvoiceUrl: expect.stringContaining('/i/in_iv') });
  });
});

describe('the limits while the first invoice is unpaid', () => {
  it('refuses more seats, and still allows fewer', async () => {
    const h = await as(ids.ownerA);
    const more = await api().put('/api/v1/billing/seats').set(h).send({ seats: { controller: 1, contributor: 3 } }).expect(409);
    expect(more.body.error.code).toBe('subscription_rule');
    expect(more.body.error.message).toMatch(/Pay invoice INV-IV-0001/);
    await api().post('/api/v1/billing/seats/preview').set(h).send({ seats: { controller: 1, contributor: 3 } }).expect(409);
    expect(fake.calls).not.toContain('updateSeats');
    await api().put('/api/v1/billing/seats').set(h).send({ seats: { controller: 1, contributor: 1 } }).expect(200);
    expect(fake.calls).toContain('updateSeats');
  });

  it('closes reporting keys with 403 payable_first', async () => {
    const res = await api().post('/api/v1/reporting/keys').set(await as(ids.ownerA)).send({ name: 'Power BI', days: 30 }).expect(403);
    expect(res.body.error.code).toBe('payable_first');
  });
});

describe('paying the first invoice', () => {
  it('lifts both limits once Stripe says it is paid (through the signed webhook)', async () => {
    const [invoiceId] = [...fake.invoices.keys()];
    const invoice = fake.invoices.get(invoiceId)!;
    invoice.status = 'paid';
    invoice.paidAt = new Date().toISOString();
    invoice.paymentStatus = 'succeeded';
    invoice.paymentIntentId = 'pi_iv_1';
    await send('invoice.paid', { id: invoiceId }).expect(200);
    const h = await as(ids.ownerA);
    const overview = (await api().get('/api/v1/subscription').set(h).expect(200)).body.subscription;
    expect(overview).toMatchObject({ firstInvoicePending: false, openInvoice: null });
    await api().post('/api/v1/reporting/keys').set(h).send({ name: 'Power BI', days: 30 }).expect(201);
  });

  it('bills a seat increase at once and refuses the next until that invoice is paid too', async () => {
    const h = await as(ids.ownerA);
    await api().put('/api/v1/billing/seats').set(h).send({ seats: { controller: 1, contributor: 3 } }).expect(200);
    expect(fake.lastChange).toMatchObject({ collectionMethod: 'send_invoice' });
    const overview = (await api().get('/api/v1/subscription').set(h).expect(200)).body.subscription;
    expect(overview.openInvoice).toMatchObject({ total: 5000 });
    expect(overview.firstInvoicePending).toBe(false);
    const again = await api().put('/api/v1/billing/seats').set(h).send({ seats: { controller: 1, contributor: 4 } }).expect(409);
    expect(again.body.error.message).toMatch(/Pay invoice/);
  });
});

describe('a VAT number Stripe cannot verify', () => {
  it('is refused before any subscription is made, and can be corrected with the same attempt', async () => {
    fake.vatResult = 'invalid';
    const h = await as(ids.ownerB, ids.orgB);
    const before = fake.calls.filter((c) => c === 'createInvoiceSubscription').length;
    const res = await api().post('/api/v1/billing/invoice-subscription').set(h).send(body({ company: company({ legalName: 'Beta Engineering Ltd', vatNumber: 'GB000000000' }), clientKey: 'attempt-beta1' })).expect(400);
    expect(res.body.error.code).toBe('vat_number_invalid');
    expect(fake.calls.filter((c) => c === 'createInvoiceSubscription').length).toBe(before);
    expect((await admin.query(`select count(*)::int as n from public.organisation_subscriptions where organisation_id = $1`, [ids.orgB])).rows[0].n).toBe(0);
    fake.vatResult = 'verified';
    await api().post('/api/v1/billing/invoice-subscription').set(h).send(body({ company: company({ legalName: 'Beta Engineering Ltd', vatNumber: 'GB987654321' }), clientKey: 'attempt-beta1' })).expect(200);
  });
});

describe('one organisation per company', () => {
  it('refuses a second organisation for the same company, under another spelling or with the same VAT number', async () => {
    // orgB already invoices as Beta Engineering; a third organisation is needed, so use a fresh one made by the admin connection.
    const third = ids.orgB.replace(/b$/, 'c');
    await admin.query(`insert into public.organisations (id, name, slug) values ($1, 'Third Works', 'third-works-iv') on conflict do nothing`, [third]);
    await admin.query(`insert into public.organisation_settings (organisation_id, base_currency, vat_rate) values ($1, 'GBP', 0.2) on conflict do nothing`, [third]);
    await admin.query('select app.create_default_roles($1)', [third]);
    await admin.query(
      `insert into public.organisation_users (organisation_id, user_id, status) values ($1, $2, 'active') on conflict do nothing`, [third, ids.ownerA],
    );
    await admin.query(
      `insert into public.user_role_assignments (organisation_id, membership_id, role_id)
       select $1, m.id, r.id from public.organisation_users m join public.roles r on r.organisation_id = $1 and r.key = 'owner' where m.organisation_id = $1 and m.user_id = $2
       on conflict do nothing`,
      [third, ids.ownerA],
    );
    const h = await as(ids.ownerA, third);
    const sameName = await api().post('/api/v1/billing/invoice-subscription').set(h).send(body({ company: company({ legalName: 'BETA engineering limited.', vatNumber: undefined }), clientKey: 'attempt-third1' })).expect(409);
    expect(sameName.body.error.message).toMatch(/already exists/);
    const sameVat = await api().post('/api/v1/billing/invoice-subscription').set(h).send(body({ company: company({ legalName: 'Something Else Ltd', vatNumber: 'gb 987 654 321' }), clientKey: 'attempt-third2' })).expect(409);
    expect(sameVat.body.error.message).toMatch(/already exists/);
    const check = await api().post('/api/v1/billing/invoice-company/check').set(h).send({ legalName: 'Beta Engineering Ltd' }).expect(200);
    expect(check.body.problems).toHaveLength(1);
  });
});

describe('the operator', () => {
  it('sees invoiced organisations, and only an operator with MFA does', async () => {
    await api().get('/api/v1/platform/invoice-accounts').set(await as(ids.ownerA)).expect(404);
    await request(app.getHttpServer()).get('/api/v1/platform/invoice-accounts').set({ Authorization: `Bearer ${await token(ids.outsider)}` }).expect(403);
    const res = (await api().get('/api/v1/platform/invoice-accounts').set(await operator()).expect(200)).body.data as {
      organisationId: string;
      legalName: string;
      firstInvoicePaid: boolean;
      openInvoices: number;
      billingAllowed: boolean;
    }[];
    const acme = res.find((r) => r.organisationId === ids.orgA)!;
    expect(acme).toMatchObject({ legalName: 'Acme Fabrications Ltd', firstInvoicePaid: true, openInvoices: 1, billingAllowed: true });
    expect(res.find((r) => r.organisationId === ids.orgB)).toMatchObject({ firstInvoicePaid: false });
  });

  it('can refuse invoicing for an organisation, and lift the one-per-company block, each with a reason', async () => {
    const op = await operator();
    const third = ids.orgB.replace(/b$/, 'c');
    await api().post(`/api/v1/platform/organisations/${third}/invoice-billing`).set(op).send({ allowed: false, reason: 'x' }).expect(400);
    await api().post(`/api/v1/platform/organisations/${third}/invoice-billing`).set(await as(ids.ownerA)).send({ allowed: false, reason: 'not an operator' }).expect(404);
    await api().post(`/api/v1/platform/organisations/${third}/invoice-billing`).set(op).send({ allowed: false, reason: 'Not a business account' }).expect(200);
    const refused = await api().post('/api/v1/billing/invoice-subscription').set(await as(ids.ownerA, third)).send(body({ company: company({ legalName: 'Third Works Ltd', vatNumber: undefined }), clientKey: 'attempt-third3' })).expect(409);
    expect(refused.body.error.message).toMatch(/not available/);
    await api().post(`/api/v1/platform/organisations/${third}/invoice-billing`).set(op).send({ allowed: true, reason: 'Checked, it is a company' }).expect(200);
    await api().post(`/api/v1/platform/organisations/${third}/invoice-company-exempt`).set(op).send({ exempt: true, reason: 'A subsidiary of Beta, checked with them' }).expect(200);
    await api().post('/api/v1/billing/invoice-subscription').set(await as(ids.ownerA, third)).send(body({ company: company({ legalName: 'Beta Engineering Ltd', vatNumber: 'GB987654321' }), clientKey: 'attempt-third4' })).expect(200);
    expect((await admin.query(`select invoice_company_exempt from public.organisations where id = $1`, [third])).rows[0].invoice_company_exempt).toBe(true);
  });
});
