import { Inject, Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import { ENV, Env } from '../config/env';
import { ApiError } from '../common/api-error';

/** What the database is given about a subscription (see app.stripe_apply_subscription). */
export interface SubscriptionSnapshot {
  id: string;
  customerId: string;
  status: string;
  interval: 'month' | 'year';
  currency: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialStart: string | null;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  items: { itemId: string; priceId: string; quantity: number }[];
}

/** What the database is given about an invoice (see app.stripe_apply_invoice). */
export interface InvoiceSnapshot {
  id: string;
  customerId: string | null;
  subscriptionId: string | null;
  number: string | null;
  status: string;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  periodStart: string | null;
  periodEnd: string | null;
  created: string;
  dueDate: string | null;
  paidAt: string | null;
  pdfUrl: string | null;
  paymentIntentId: string | null;
  paymentStatus: 'succeeded' | 'failed' | 'pending' | null;
}

export interface CheckoutSessionSnapshot {
  id: string;
  /** 'open' | 'complete' | 'expired' */
  status: string;
  subscriptionId: string | null;
  customerId: string | null;
  organisationId: string | null;
}

export interface SeatPreview {
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  amountDue: number;
  lines: { description: string; amount: number }[];
}

export interface StripeEventEnvelope {
  id: string;
  type: string;
  /** The event's object (a subscription, an invoice, a checkout session...). Only ids are read from it. */
  object: Record<string, unknown>;
}

export interface SeatItemChange {
  /** The existing subscription item, when the package is already on the subscription. */
  itemId?: string;
  priceId: string;
  quantity: number;
  /** Take the package off the subscription (Stripe does not keep items at quantity 0). */
  remove?: boolean;
}

const iso = (seconds: number | null | undefined): string | null => (typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null);
const idOf = (x: string | { id: string } | null | undefined): string | null => (typeof x === 'string' ? x : (x?.id ?? null));

const itemParams = (i: SeatItemChange): { id?: string; price?: string; quantity?: number; deleted?: boolean } =>
  i.remove && i.itemId ? { id: i.itemId, deleted: true } : i.itemId ? { id: i.itemId, quantity: i.quantity } : { price: i.priceId, quantity: i.quantity };

/** Pure mapping from Stripe's subscription to the snapshot the database takes. Period dates live on the items in current API versions. */
export function toSubscriptionSnapshot(sub: Stripe.Subscription): SubscriptionSnapshot {
  const items = sub.items.data;
  if (items.length === 0) throw new Error(`Subscription ${sub.id} has no items`);
  const interval = items[0].price.recurring?.interval;
  if (interval !== 'month' && interval !== 'year') throw new Error(`Subscription ${sub.id} has an unsupported billing interval`);
  const starts = items.map((i) => i.current_period_start);
  const ends = items.map((i) => i.current_period_end);
  return {
    id: sub.id,
    customerId: idOf(sub.customer)!,
    status: sub.status,
    interval: interval as 'month' | 'year',
    currency: sub.currency,
    currentPeriodStart: iso(Math.min(...starts))!,
    currentPeriodEnd: iso(Math.max(...ends))!,
    trialStart: iso(sub.trial_start),
    trialEnd: iso(sub.trial_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    canceledAt: iso(sub.canceled_at),
    items: items.map((i) => ({ itemId: i.id, priceId: i.price.id, quantity: i.quantity ?? 0 })),
  };
}

/** Pure mapping from Stripe's invoice. `paymentStatus` is what we can tell about the payment from the invoice itself. */
export function toInvoiceSnapshot(inv: Stripe.Invoice): InvoiceSnapshot {
  const tax = (inv.total_taxes ?? []).filter((t) => t.tax_behavior === 'exclusive').reduce((sum, t) => sum + t.amount, 0);
  const payments = inv.payments?.data ?? [];
  const paymentIntentId = payments.map((p) => idOf(p.payment?.payment_intent as string | { id: string } | undefined)).find((x): x is string => !!x) ?? null;
  const status = inv.status ?? 'draft';
  const paymentStatus: InvoiceSnapshot['paymentStatus'] =
    status === 'paid' ? 'succeeded' : status === 'open' && inv.attempt_count > 0 ? 'failed' : paymentIntentId ? 'pending' : null;
  return {
    id: inv.id!,
    customerId: idOf(inv.customer),
    subscriptionId: idOf(inv.parent?.subscription_details?.subscription as string | { id: string } | undefined),
    number: inv.number,
    status,
    currency: inv.currency,
    subtotal: inv.subtotal,
    tax,
    total: inv.subtotal + tax,
    periodStart: iso(inv.period_start),
    periodEnd: iso(inv.period_end),
    created: new Date(inv.created * 1000).toISOString().slice(0, 10),
    dueDate: inv.due_date ? new Date(inv.due_date * 1000).toISOString().slice(0, 10) : null,
    paidAt: iso(inv.status_transitions?.paid_at),
    pdfUrl: inv.invoice_pdf ?? inv.hosted_invoice_url ?? null,
    paymentIntentId,
    paymentStatus,
  };
}

/**
 * Everything the API needs from Stripe, and nothing else. The real implementation talks to api.stripe.com; tests substitute a fake
 * (signature verification stays real). Without STRIPE_SECRET_KEY `enabled` is false and every call refuses with 503 billing_unavailable.
 */
export abstract class StripeGateway {
  abstract readonly enabled: boolean;
  abstract readonly webhookEnabled: boolean;
  abstract createCustomer(input: { organisationId: string; name: string; email?: string }): Promise<string>;
  abstract createCheckoutSession(input: {
    customerId: string;
    organisationId: string;
    userId: string;
    items: { priceId: string; quantity: number }[];
    trialDays: number;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ id: string; url: string }>;
  abstract retrieveCheckoutSession(id: string): Promise<CheckoutSessionSnapshot>;
  abstract retrieveSubscription(id: string): Promise<SubscriptionSnapshot>;
  abstract retrieveInvoice(id: string): Promise<InvoiceSnapshot>;
  abstract previewSeatChange(input: { customerId: string; subscriptionId: string; items: SeatItemChange[] }): Promise<SeatPreview>;
  abstract updateSeats(input: { subscriptionId: string; items: SeatItemChange[] }): Promise<void>;
  abstract createPortalSession(input: { customerId: string; returnUrl: string }): Promise<string>;
  /** Verifies Stripe's signature over the raw body and returns the event; throws ApiError 400 invalid_signature. */
  abstract constructEvent(rawBody: Buffer, signature: string | undefined): StripeEventEnvelope;
}

@Injectable()
export class StripeSdkGateway extends StripeGateway {
  private readonly client?: Stripe;
  private readonly webhookSecret?: string;

  constructor(@Inject(ENV) env: Env) {
    super();
    this.webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    if (env.STRIPE_SECRET_KEY) this.client = new Stripe(env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: 'Fortress QMS' } });
  }

  get enabled(): boolean {
    return !!this.client;
  }

  get webhookEnabled(): boolean {
    return !!this.client && !!this.webhookSecret;
  }

  private stripe(): Stripe {
    if (!this.client) throw new ApiError(503, 'billing_unavailable', 'Billing is not set up on this server yet');
    return this.client;
  }

  async createCustomer(input: { organisationId: string; name: string; email?: string }): Promise<string> {
    const customer = await this.stripe().customers.create(
      { name: input.name, email: input.email, metadata: { organisation_id: input.organisationId } },
      { idempotencyKey: `customer:${input.organisationId}` },
    );
    return customer.id;
  }

  async createCheckoutSession(input: Parameters<StripeGateway['createCheckoutSession']>[0]): Promise<{ id: string; url: string }> {
    const metadata = { organisation_id: input.organisationId, user_id: input.userId };
    const session = await this.stripe().checkout.sessions.create({
      mode: 'subscription',
      customer: input.customerId,
      client_reference_id: input.organisationId,
      line_items: input.items.map((i) => ({ price: i.priceId, quantity: i.quantity })),
      subscription_data: { trial_period_days: input.trialDays, metadata },
      payment_method_collection: 'always',
      automatic_tax: { enabled: true },
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      customer_update: { name: 'auto', address: 'auto' },
      allow_promotion_codes: false,
      metadata,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    if (!session.url) throw new ApiError(502, 'billing_provider_error', 'The payment provider did not return a checkout address');
    return { id: session.id, url: session.url };
  }

  async retrieveCheckoutSession(id: string): Promise<CheckoutSessionSnapshot> {
    const s = await this.stripe().checkout.sessions.retrieve(id);
    return {
      id: s.id,
      status: s.status ?? 'open',
      subscriptionId: idOf(s.subscription as string | { id: string } | null),
      customerId: idOf(s.customer as string | { id: string } | null),
      organisationId: s.metadata?.organisation_id ?? s.client_reference_id ?? null,
    };
  }

  async retrieveSubscription(id: string): Promise<SubscriptionSnapshot> {
    return toSubscriptionSnapshot(await this.stripe().subscriptions.retrieve(id));
  }

  async retrieveInvoice(id: string): Promise<InvoiceSnapshot> {
    return toInvoiceSnapshot(await this.stripe().invoices.retrieve(id, { expand: ['payments'] }));
  }

  async previewSeatChange(input: { customerId: string; subscriptionId: string; items: SeatItemChange[] }): Promise<SeatPreview> {
    const preview = await this.stripe().invoices.createPreview({
      customer: input.customerId,
      subscription: input.subscriptionId,
      subscription_details: {
        items: input.items.map(itemParams),
        proration_behavior: 'create_prorations',
      },
    });
    const snapshot = toInvoiceSnapshot(preview);
    return {
      currency: snapshot.currency,
      subtotal: snapshot.subtotal,
      tax: snapshot.tax,
      total: snapshot.total,
      amountDue: preview.amount_due,
      lines: preview.lines.data.map((l) => ({ description: l.description ?? 'Subscription', amount: l.amount })),
    };
  }

  async updateSeats(input: { subscriptionId: string; items: SeatItemChange[] }): Promise<void> {
    await this.stripe().subscriptions.update(input.subscriptionId, {
      items: input.items.map(itemParams),
      proration_behavior: 'create_prorations',
    });
  }

  async createPortalSession(input: { customerId: string; returnUrl: string }): Promise<string> {
    const session = await this.stripe().billingPortal.sessions.create({ customer: input.customerId, return_url: input.returnUrl });
    return session.url;
  }

  constructEvent(rawBody: Buffer, signature: string | undefined): StripeEventEnvelope {
    if (!this.client || !this.webhookSecret) throw new ApiError(503, 'billing_unavailable', 'Billing is not set up on this server yet');
    if (!signature) throw ApiError.badRequest('invalid_signature', 'Missing Stripe signature');
    try {
      const event = this.client.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
      return { id: event.id, type: event.type, object: event.data.object as unknown as Record<string, unknown> };
    } catch {
      throw ApiError.badRequest('invalid_signature', 'The Stripe signature could not be verified');
    }
  }
}
