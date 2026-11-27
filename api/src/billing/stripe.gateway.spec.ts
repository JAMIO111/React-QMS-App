import Stripe from 'stripe';
import { loadEnv } from '../config/env';
import { appBaseUrl } from './stripe-billing.service';
import { InvoiceBillingDetails, SeatItemChange, splitSeatChange, StripeSdkGateway, taxIdFor, toInvoiceSnapshot, toSubscriptionSnapshot } from './stripe.gateway';

const item = (id: string, priceId: string, quantity: number, start: number, end: number, interval: 'month' | 'year' = 'month') =>
  ({ id, quantity, current_period_start: start, current_period_end: end, price: { id: priceId, recurring: { interval } } }) as unknown as Stripe.SubscriptionItem;

const subscription = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: 'sub_1',
    customer: 'cus_1',
    status: 'trialing',
    currency: 'gbp',
    trial_start: 1_700_000_000,
    trial_end: 1_701_209_600,
    cancel_at_period_end: false,
    canceled_at: null,
    items: { data: [item('si_1', 'price_a', 2, 1_700_000_000, 1_702_592_000), item('si_2', 'price_b', 3, 1_700_000_100, 1_702_592_100)] },
    ...over,
  }) as unknown as Stripe.Subscription;

describe('toSubscriptionSnapshot', () => {
  it('maps the subscription, taking its period from the items (current API versions keep it there)', () => {
    const snap = toSubscriptionSnapshot(subscription());
    expect(snap).toMatchObject({ id: 'sub_1', customerId: 'cus_1', status: 'trialing', interval: 'month', currency: 'gbp', cancelAtPeriodEnd: false, canceledAt: null, collectionMethod: 'charge_automatically' });
    expect(snap.currentPeriodStart).toBe(new Date(1_700_000_000 * 1000).toISOString());
    expect(snap.currentPeriodEnd).toBe(new Date(1_702_592_100 * 1000).toISOString());
    expect(snap.trialEnd).toBe(new Date(1_701_209_600 * 1000).toISOString());
    expect(snap.items).toEqual([
      { itemId: 'si_1', priceId: 'price_a', quantity: 2 },
      { itemId: 'si_2', priceId: 'price_b', quantity: 3 },
    ]);
  });

  it('accepts an expanded customer object and a yearly interval', () => {
    const snap = toSubscriptionSnapshot(subscription({ customer: { id: 'cus_9' }, items: { data: [item('si_1', 'price_a', 1, 1, 2, 'year')] } }));
    expect(snap).toMatchObject({ customerId: 'cus_9', interval: 'year' });
  });

  it('says whether Stripe charges the card or sends an invoice', () => {
    expect(toSubscriptionSnapshot(subscription({ collection_method: 'send_invoice' })).collectionMethod).toBe('send_invoice');
    expect(toSubscriptionSnapshot(subscription({ collection_method: 'charge_automatically' })).collectionMethod).toBe('charge_automatically');
  });

  it('refuses a subscription with no items or an interval we do not sell', () => {
    expect(() => toSubscriptionSnapshot(subscription({ items: { data: [] } }))).toThrow(/no items/);
    expect(() => toSubscriptionSnapshot(subscription({ items: { data: [item('si_1', 'price_a', 1, 1, 2, 'week' as 'month')] } }))).toThrow(/interval/);
  });
});

const invoice = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: 'in_1',
    customer: 'cus_1',
    number: 'FQ-1',
    status: 'paid',
    currency: 'gbp',
    subtotal: 10000,
    total_taxes: [{ amount: 2000, tax_behavior: 'exclusive' }],
    period_start: 1_700_000_000,
    period_end: 1_702_592_000,
    created: 1_700_000_000,
    due_date: null,
    attempt_count: 1,
    status_transitions: { paid_at: 1_700_000_500 },
    invoice_pdf: 'https://pay.test/in_1.pdf',
    parent: { subscription_details: { subscription: 'sub_1' } },
    payments: { data: [{ payment: { payment_intent: 'pi_1' } }] },
    ...over,
  }) as unknown as Stripe.Invoice;

describe('toInvoiceSnapshot', () => {
  it('maps amounts (tax added to the subtotal), the subscription and the payment', () => {
    expect(toInvoiceSnapshot(invoice())).toMatchObject({
      id: 'in_1', customerId: 'cus_1', subscriptionId: 'sub_1', number: 'FQ-1', status: 'paid', subtotal: 10000, tax: 2000, total: 12000,
      paymentIntentId: 'pi_1', paymentStatus: 'succeeded', pdfUrl: 'https://pay.test/in_1.pdf',
    });
  });

  it('counts only tax added on top, not tax already in the price', () => {
    const snap = toInvoiceSnapshot(invoice({ total_taxes: [{ amount: 500, tax_behavior: 'inclusive' }, { amount: 700, tax_behavior: 'exclusive' }] }));
    expect(snap.tax).toBe(700);
    expect(snap.total).toBe(10700);
  });

  it('says the payment failed for an open invoice that has been tried, and pending otherwise', () => {
    expect(toInvoiceSnapshot(invoice({ status: 'open', attempt_count: 2 })).paymentStatus).toBe('failed');
    expect(toInvoiceSnapshot(invoice({ status: 'open', attempt_count: 0 })).paymentStatus).toBe('pending');
    expect(toInvoiceSnapshot(invoice({ status: 'open', attempt_count: 0, payments: { data: [] } })).paymentStatus).toBeNull();
  });

  it('copes with no tax, no payments and no subscription', () => {
    const snap = toInvoiceSnapshot(invoice({ total_taxes: null, payments: undefined, parent: null, status_transitions: {} }));
    expect(snap).toMatchObject({ tax: 0, total: 10000, subscriptionId: null, paymentIntentId: null, paidAt: null });
  });
});

describe('Stripe configuration', () => {
  const base = { DATABASE_URL: 'postgres://x', SUPABASE_URL: 'https://p.supabase.co' };

  it('is optional, and checked when given', () => {
    expect(loadEnv(base).STRIPE_SECRET_KEY).toBeUndefined();
    expect(loadEnv({ ...base, STRIPE_SECRET_KEY: 'sk_test_abcdefghijklmnop', STRIPE_WEBHOOK_SECRET: 'whsec_abcdefghijklmnop' }).STRIPE_WEBHOOK_SECRET).toBe('whsec_abcdefghijklmnop');
    expect(() => loadEnv({ ...base, STRIPE_SECRET_KEY: 'pk_test_abcdefghijklmnop' })).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => loadEnv({ ...base, STRIPE_WEBHOOK_SECRET: 'nope' })).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  it('never echoes a key in the error', () => {
    try {
      loadEnv({ ...base, STRIPE_SECRET_KEY: 'sk_live_tooShort' });
    } catch (e) {
      expect((e as Error).message).not.toContain('tooShort');
    }
  });

  it('returns to the app at APP_BASE_URL, else the first plain CORS origin', () => {
    expect(appBaseUrl(loadEnv({ ...base, APP_BASE_URL: 'https://app.example.com/' }))).toBe('https://app.example.com');
    expect(appBaseUrl(loadEnv({ ...base, CORS_ORIGINS: 'https://qms-*.vercel.app,https://dev.example.com' }))).toBe('https://dev.example.com');
    expect(appBaseUrl(loadEnv({ ...base, CORS_ORIGINS: 'https://qms-*.vercel.app' }))).toBeNull();
  });
});

describe('StripeSdkGateway', () => {
  const secret = 'whsec_gatewayTestSecret123456';
  const keys = { DATABASE_URL: 'postgres://x', SUPABASE_URL: 'https://p.supabase.co', STRIPE_SECRET_KEY: 'sk_test_abcdefghijklmnop', STRIPE_WEBHOOK_SECRET: secret };
  const gateway = new StripeSdkGateway(loadEnv(keys));
  const payload = JSON.stringify({ id: 'evt_gw_1', object: 'event', type: 'invoice.paid', data: { object: { id: 'in_1' } } });
  const sign = (body: string, s = secret) => Stripe.webhooks.generateTestHeaderString({ payload: body, secret: s });

  it('is enabled only with a key, and takes webhooks only with a signing secret too', () => {
    expect(new StripeSdkGateway(loadEnv({ DATABASE_URL: 'postgres://x', SUPABASE_URL: 'https://p.supabase.co' })).enabled).toBe(false);
    const keyOnly = new StripeSdkGateway(loadEnv({ ...keys, STRIPE_WEBHOOK_SECRET: undefined }));
    expect(keyOnly.enabled).toBe(true);
    expect(keyOnly.webhookEnabled).toBe(false);
    expect(gateway.webhookEnabled).toBe(true);
  });

  it('refuses every call with 503 billing_unavailable when there is no key', async () => {
    const none = new StripeSdkGateway(loadEnv({ DATABASE_URL: 'postgres://x', SUPABASE_URL: 'https://p.supabase.co' }));
    await expect(none.retrieveSubscription('sub_1')).rejects.toMatchObject({ code: 'billing_unavailable', status: 503 });
    expect(() => none.constructEvent(Buffer.from(payload), 't=1,v1=x')).toThrow(/not set up/);
  });

  it('verifies the signature over the exact raw bytes', () => {
    const event = gateway.constructEvent(Buffer.from(payload), sign(payload));
    expect(event).toMatchObject({ id: 'evt_gw_1', type: 'invoice.paid', object: { id: 'in_1' } });
  });

  it('refuses a missing, wrong-secret, tampered or stale signature with 400 invalid_signature', () => {
    const bad = (body: string, header: string | undefined) => {
      try {
        gateway.constructEvent(Buffer.from(body), header);
      } catch (e) {
        return e as { code: string; status: number };
      }
      return null;
    };
    expect(bad(payload, undefined)).toMatchObject({ code: 'invalid_signature', status: 400 });
    expect(bad(payload, sign(payload, 'whsec_someOtherSecretEntirely123456'))).toMatchObject({ code: 'invalid_signature' });
    expect(bad(payload.replace('invoice.paid', 'invoice.voided'), sign(payload))).toMatchObject({ code: 'invalid_signature' });
    expect(bad(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: Math.floor(Date.now() / 1000) - 3600 }))).toMatchObject({ code: 'invalid_signature' });
    expect(bad(payload, 'garbage')).toMatchObject({ code: 'invalid_signature' });
  });
});

describe('seat billing: increases are billed at once, decreases are credited', () => {
  const keys = { DATABASE_URL: 'postgres://x', SUPABASE_URL: 'https://p.supabase.co', STRIPE_SECRET_KEY: 'sk_test_abcdefghijklmnop' };
  const up: SeatItemChange = { itemId: 'si_1', priceId: 'price_a', quantity: 5, from: 3 };
  const newPackage: SeatItemChange = { priceId: 'price_n', quantity: 2, from: 0 };
  const down: SeatItemChange = { itemId: 'si_2', priceId: 'price_b', quantity: 1, from: 4 };
  const off: SeatItemChange = { itemId: 'si_3', priceId: 'price_c', quantity: 0, from: 2, remove: true };

  const withStub = (stub: Record<string, unknown>) => {
    const gateway = new StripeSdkGateway(loadEnv(keys));
    (gateway as unknown as { client: unknown }).client = stub;
    return gateway;
  };

  it('tells an increase from a decrease: more seats or a new package goes up; fewer seats or a package taken off goes down', () => {
    expect(splitSeatChange([up, newPackage, down, off])).toEqual({ increases: [up, newPackage], decreases: [down, off] });
    // With no earlier count the package is treated as new (0 seats before), so any seats are an increase.
    expect(splitSeatChange([{ priceId: 'p', quantity: 3 }])).toEqual({ increases: [{ priceId: 'p', quantity: 3 }], decreases: [] });
    expect(splitSeatChange([{ itemId: 'si_9', priceId: 'p', quantity: 2, from: 2 }])).toEqual({ increases: [], decreases: [{ itemId: 'si_9', priceId: 'p', quantity: 2, from: 2 }] });
  });

  it('a card is charged now for an increase and the seats follow only if it goes through; the decrease comes after', async () => {
    const update = jest.fn().mockResolvedValue({ id: 'sub_1', pending_update: null, latest_invoice: 'in_1' });
    await withStub({ subscriptions: { update } }).updateSeats({ subscriptionId: 'sub_1', items: [down, up], collectionMethod: 'charge_automatically' });
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0][1]).toEqual({ items: [{ id: 'si_1', quantity: 5 }], proration_behavior: 'always_invoice', payment_behavior: 'pending_if_incomplete' });
    expect(update.mock.calls[1][1]).toEqual({ items: [{ id: 'si_2', quantity: 1 }], proration_behavior: 'create_prorations' });
  });

  it('a declined card (a pending update, or a card error) changes nothing: the decrease is not applied and the answer says why', async () => {
    const pending = jest.fn().mockResolvedValue({ id: 'sub_1', pending_update: { expires_at: 1 }, latest_invoice: 'in_1' });
    await expect(withStub({ subscriptions: { update: pending } }).updateSeats({ subscriptionId: 'sub_1', items: [up, down], collectionMethod: 'charge_automatically' })).rejects.toMatchObject({ code: 'seat_payment_failed', status: 402 });
    expect(pending).toHaveBeenCalledTimes(1);
    const declined = jest.fn().mockRejectedValue(Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError' }));
    await expect(withStub({ subscriptions: { update: declined } }).updateSeats({ subscriptionId: 'sub_1', items: [up], collectionMethod: 'charge_automatically' })).rejects.toMatchObject({ code: 'seat_payment_failed' });
    const other = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(withStub({ subscriptions: { update: other } }).updateSeats({ subscriptionId: 'sub_1', items: [up], collectionMethod: 'charge_automatically' })).rejects.toThrow('boom');
  });

  it('an invoiced subscription is not given a payment behaviour (Stripe refuses it) and its new invoice is finalised so it can be paid', async () => {
    const update = jest.fn().mockResolvedValue({ id: 'sub_1', pending_update: null, latest_invoice: 'in_9' });
    const retrieve = jest.fn().mockResolvedValue({ id: 'in_9', status: 'draft' });
    const finalizeInvoice = jest.fn().mockResolvedValue({});
    await withStub({ subscriptions: { update }, invoices: { retrieve, finalizeInvoice } }).updateSeats({ subscriptionId: 'sub_1', items: [up], collectionMethod: 'send_invoice' });
    expect(update.mock.calls[0][1]).toEqual({ items: [{ id: 'si_1', quantity: 5 }], proration_behavior: 'always_invoice' });
    expect(finalizeInvoice).toHaveBeenCalledWith('in_9');
    retrieve.mockResolvedValue({ id: 'in_9', status: 'open' });
    finalizeInvoice.mockClear();
    await withStub({ subscriptions: { update }, invoices: { retrieve, finalizeInvoice } }).updateSeats({ subscriptionId: 'sub_1', items: [up], collectionMethod: 'send_invoice' });
    expect(finalizeInvoice).not.toHaveBeenCalled();
  });

  it('a decrease on its own is one call that credits the next invoice and never touches payment', async () => {
    const update = jest.fn().mockResolvedValue({ id: 'sub_1' });
    await withStub({ subscriptions: { update } }).updateSeats({ subscriptionId: 'sub_1', items: [down, off], collectionMethod: 'charge_automatically' });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][1]).toEqual({ items: [{ id: 'si_2', quantity: 1 }, { id: 'si_3', deleted: true }], proration_behavior: 'create_prorations' });
  });

  it('the preview shows what is collected now for an increase, and the credit for a decrease', async () => {
    const line = (amount: number, proration: boolean) => ({ amount, description: 'x', parent: { subscription_item_details: { proration } } });
    const preview = (over: Record<string, unknown>) => ({ currency: 'gbp', subtotal: 0, total: 0, total_taxes: [], status: 'draft', attempt_count: 0, created: 1_700_000_000, ...over });
    const createPreview = jest
      .fn()
      .mockResolvedValueOnce(preview({ subtotal: 1000, total: 1200, amount_due: 1200, total_taxes: [{ amount: 200, tax_behavior: 'exclusive' }], lines: { data: [line(1000, true), line(2500, false)] } }))
      .mockResolvedValueOnce(preview({ amount_due: 2500, lines: { data: [line(-1000, true), line(2500, false)] } }));
    const gateway = withStub({ invoices: { createPreview } });
    const now = await gateway.previewSeatChange({ customerId: 'cus_1', subscriptionId: 'sub_1', items: [up, down], collectionMethod: 'charge_automatically' });
    expect(createPreview.mock.calls[0][0].subscription_details).toEqual({ items: [{ id: 'si_1', quantity: 5 }], proration_behavior: 'always_invoice' });
    expect(now).toMatchObject({ timing: 'now', payment: 'card', amountDue: 1200, tax: 200, lines: [{ amount: 1000 }] });
    const credit = await gateway.previewSeatChange({ customerId: 'cus_1', subscriptionId: 'sub_1', items: [down], collectionMethod: 'send_invoice' });
    expect(createPreview.mock.calls[1][0].subscription_details.proration_behavior).toBe('create_prorations');
    expect(credit).toMatchObject({ timing: 'next_invoice', payment: 'invoice', amountDue: -1000 });
  });
});

describe('invoiced subscriptions', () => {
  const keys = { DATABASE_URL: 'postgres://x', SUPABASE_URL: 'https://p.supabase.co', STRIPE_SECRET_KEY: 'sk_test_abcdefghijklmnop' };
  const withStub = (stub: Record<string, unknown>) => {
    const gateway = new StripeSdkGateway(loadEnv(keys));
    gateway.vatChecks = 2;
    gateway.vatCheckMs = 0;
    (gateway as unknown as { client: unknown }).client = stub;
    return gateway;
  };
  const details: InvoiceBillingDetails = { legalName: 'Acme Ltd', billingEmail: 'accounts@acme.test', addressLine1: '1 High Street', city: 'Leeds', postcode: 'LS1 1AA', country: 'GB', vatNumber: 'GB 123 456 789', poReference: 'PO-1' };

  it('works out the Stripe tax id from a VAT number: UK, EU (Greece is EL), Northern Ireland, and nothing else', () => {
    expect(taxIdFor('GB 123 456 789', 'GB')).toEqual({ type: 'gb_vat', value: 'GB123456789' });
    expect(taxIdFor('123456789', 'GB')).toEqual({ type: 'gb_vat', value: 'GB123456789' });
    expect(taxIdFor('de123456789', 'DE')).toEqual({ type: 'eu_vat', value: 'DE123456789' });
    expect(taxIdFor('GR123456789', 'GR')).toEqual({ type: 'eu_vat', value: 'EL123456789' });
    expect(taxIdFor('XI123456789', 'GB')).toEqual({ type: 'eu_vat', value: 'XI123456789' });
    expect(taxIdFor('US123456789', 'US')).toBeNull();
    expect(taxIdFor('   ', 'GB')).toBeNull();
  });

  it('maps an invoiced subscription: collection method, terms and the newest invoice', () => {
    const snap = toSubscriptionSnapshot(subscription({ status: 'active', collection_method: 'send_invoice', days_until_due: 14, latest_invoice: 'in_7', trial_end: null, trial_start: null }));
    expect(snap).toMatchObject({ collectionMethod: 'send_invoice', daysUntilDue: 14, latestInvoiceId: 'in_7' });
    expect(toSubscriptionSnapshot(subscription({ latest_invoice: { id: 'in_8' } })).latestInvoiceId).toBe('in_8');
    expect(toSubscriptionSnapshot(subscription()).daysUntilDue).toBeNull();
  });

  it('puts the company on the customer, with the PO number on every invoice, and adds a VAT number that Stripe verifies', async () => {
    const update = jest.fn().mockResolvedValue({});
    const listTaxIds = jest.fn().mockResolvedValue({ data: [] });
    const createTaxId = jest.fn().mockResolvedValue({ id: 'txi_1', verification: { status: 'verified' } });
    const out = await withStub({ customers: { update, listTaxIds, createTaxId } }).updateCustomerBilling('cus_1', details);
    expect(out).toEqual({ vat: 'verified' });
    expect(update).toHaveBeenCalledWith('cus_1', {
      name: 'Acme Ltd',
      email: 'accounts@acme.test',
      address: { line1: '1 High Street', line2: undefined, city: 'Leeds', state: undefined, postal_code: 'LS1 1AA', country: 'GB' },
      invoice_settings: { custom_fields: [{ name: 'PO number', value: 'PO-1' }] },
    });
    expect(createTaxId).toHaveBeenCalledWith('cus_1', { type: 'gb_vat', value: 'GB123456789' });
  });

  it('without a VAT number or a PO number it adds no tax id and clears the custom field', async () => {
    const update = jest.fn().mockResolvedValue({});
    const createTaxId = jest.fn();
    const out = await withStub({ customers: { update, createTaxId } }).updateCustomerBilling('cus_1', { ...details, vatNumber: undefined, poReference: undefined });
    expect(out).toEqual({ vat: 'none' });
    expect(update.mock.calls[0][1].invoice_settings).toEqual({ custom_fields: '' });
    expect(createTaxId).not.toHaveBeenCalled();
  });

  it('a VAT number Stripe cannot verify is refused and taken off the customer again; a number it has not finished checking is accepted as pending', async () => {
    const update = jest.fn().mockResolvedValue({});
    const listTaxIds = jest.fn().mockResolvedValue({ data: [] });
    const createTaxId = jest.fn().mockResolvedValue({ id: 'txi_1', verification: { status: 'pending' } });
    const retrieveTaxId = jest.fn().mockResolvedValue({ id: 'txi_1', verification: { status: 'unverified' } });
    const deleteTaxId = jest.fn().mockResolvedValue({});
    await expect(withStub({ customers: { update, listTaxIds, createTaxId, retrieveTaxId, deleteTaxId } }).updateCustomerBilling('cus_1', details)).rejects.toMatchObject({ code: 'vat_number_invalid', status: 400 });
    expect(deleteTaxId).toHaveBeenCalledWith('cus_1', 'txi_1');
    retrieveTaxId.mockResolvedValue({ id: 'txi_1', verification: { status: 'pending' } });
    expect(await withStub({ customers: { update, listTaxIds, createTaxId, retrieveTaxId, deleteTaxId } }).updateCustomerBilling('cus_1', details)).toEqual({ vat: 'pending' });
    // Stripe refusing the number outright, and a number that is not a UK or EU one, are form errors too.
    const refuse = jest.fn().mockRejectedValue(Object.assign(new Error('Invalid value'), { type: 'StripeInvalidRequestError' }));
    await expect(withStub({ customers: { update, listTaxIds, createTaxId: refuse } }).updateCustomerBilling('cus_1', details)).rejects.toMatchObject({ code: 'vat_number_invalid' });
    await expect(withStub({ customers: { update } }).updateCustomerBilling('cus_1', { ...details, vatNumber: 'US123', country: 'US' })).rejects.toMatchObject({ code: 'vat_number_invalid' });
  });

  it('a tax id the customer already has is not added twice (a retry)', async () => {
    const update = jest.fn().mockResolvedValue({});
    const listTaxIds = jest.fn().mockResolvedValue({ data: [{ id: 'txi_1', type: 'gb_vat', value: 'GB123456789', verification: { status: 'verified' } }] });
    const createTaxId = jest.fn();
    expect(await withStub({ customers: { update, listTaxIds, createTaxId } }).updateCustomerBilling('cus_1', details)).toEqual({ vat: 'verified' });
    expect(createTaxId).not.toHaveBeenCalled();
  });

  it('creates the subscription by invoice with no trial, bank transfer or card, payable in the given days, under an idempotency key, and finalises its first invoice', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'sub_9', latest_invoice: 'in_9' });
    const retrieve = jest.fn().mockResolvedValue({ id: 'in_9', status: 'draft' });
    const finalizeInvoice = jest.fn().mockResolvedValue({});
    const out = await withStub({ subscriptions: { create }, invoices: { retrieve, finalizeInvoice } }).createInvoiceSubscription({
      customerId: 'cus_1',
      organisationId: 'org-1',
      userId: 'user-1',
      items: [{ priceId: 'price_a', quantity: 2 }],
      daysUntilDue: 14,
      clientKey: 'attempt-1',
    });
    expect(out).toEqual({ subscriptionId: 'sub_9', invoiceId: 'in_9' });
    const [params, options] = create.mock.calls[0];
    expect(params).toMatchObject({
      customer: 'cus_1',
      items: [{ price: 'price_a', quantity: 2 }],
      collection_method: 'send_invoice',
      days_until_due: 14,
      automatic_tax: { enabled: true },
      payment_settings: { payment_method_types: ['customer_balance', 'card'], payment_method_options: { customer_balance: { funding_type: 'bank_transfer', bank_transfer: { type: 'gb_bank_transfer' } } } },
      metadata: { organisation_id: 'org-1', user_id: 'user-1' },
    });
    expect(params.trial_period_days).toBeUndefined();
    expect(options).toEqual({ idempotencyKey: 'invoice-subscription:org-1:attempt-1' });
    expect(finalizeInvoice).toHaveBeenCalledWith('in_9');
  });
});
