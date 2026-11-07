import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { ENV, Env, corsOrigins } from '../config/env';
import { DatabaseService } from '../database/database.service';
import { Row } from '../calibration/calibration.service';
import type { CheckoutBody, ConfirmCheckoutBody, SeatChangeBody, SeatCounts, SeatPreviewResponse, SubscriptionOverview } from './billing.schemas';
import { BillingService } from './billing.service';
import { StripeEventEnvelope, StripeGateway, SeatItemChange, SubscriptionSnapshot } from './stripe.gateway';

export const TRIAL_DAYS = 14;

/** The web app's address for Stripe's return links: APP_BASE_URL, else the first plain (non-wildcard) CORS origin. */
export function appBaseUrl(env: Env): string | null {
  const url = env.APP_BASE_URL ?? corsOrigins(env).find((o): o is string => typeof o === 'string');
  return url ? url.replace(/\/+$/, '') : null;
}

const PROBLEM = 'subscription_rule';

/**
 * Stripe is the source of truth for money and quantities. This service talks to Stripe (through StripeGateway), then hands what Stripe says to the
 * app.stripe_* database functions, which only the API login can run. It never trusts a redirect or an event payload for state: it re-reads the
 * subscription or invoice from Stripe and applies that (the database ignores a read that is older than the one it holds).
 */
@Injectable()
export class StripeBillingService {
  private readonly log = new Logger(StripeBillingService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly database: DatabaseService,
    private readonly gateway: StripeGateway,
    private readonly billing: BillingService,
  ) {}

  // ------------------------------------------------------------------ for the signed-in owner

  /** Starts Stripe Checkout (14-day trial, card required, VAT by Stripe Tax) and records who started it. */
  async checkout(ctx: RequestContext, body: CheckoutBody): Promise<{ url: string; sessionId: string }> {
    this.requireEnabled();
    const org = ctx.organisationId!;
    const base = this.requireBaseUrl();
    await this.assertNoSeatProblems(ctx, body.seats);

    const state = await this.database.asUser(ctx, async (db) => {
      const sub = (await db.execute<Row>(sql`select status, billing_provider from public.organisation_subscriptions where organisation_id = ${org}::uuid`)).rows[0];
      const owner = (await db.execute<Row>(sql`
        select exists (select 1 from public.organisation_users m join public.user_role_assignments a on a.membership_id = m.id
                         join public.roles r on r.id = a.role_id and r.key = 'owner'
                        where m.organisation_id = ${org}::uuid and m.user_id = auth.uid() and m.status = 'active') as is_owner`)).rows[0];
      const name = (await db.execute<Row>(sql`select name from public.organisations where id = ${org}::uuid`)).rows[0];
      return { sub, isOwner: owner.is_owner as boolean, name: name.name as string };
    });
    if (!state.isOwner) throw new ApiError(409, PROBLEM, 'Only an owner can start the subscription: they hold the first Controller seat.');
    if (state.sub && (state.sub.billing_provider === 'manual' || !['cancelled', 'incomplete'].includes(state.sub.status as string))) {
      throw new ApiError(409, PROBLEM, 'This organisation already has a subscription. Change it from Subscription & billing.');
    }

    const items = await this.database.asApi(async (client) => {
      const out: { slug: string; priceId: string; quantity: number }[] = [];
      for (const [slug, quantity] of Object.entries(body.seats)) {
        if (quantity <= 0) continue;
        const price = (await client.query(`select app.stripe_price_for($1, $2) as id`, [slug, body.interval])).rows[0].id as string | null;
        if (!price) throw new ApiError(503, 'billing_unavailable', 'Prices have not been set up in Stripe yet');
        out.push({ slug, priceId: price, quantity });
      }
      return out;
    }, ctx.correlationId);

    const customerId = await this.customerFor(ctx, state.name);
    const where = body.returnTo === 'settings' ? '/Settings/Subscription' : '/setup/plan';
    const session = await this.gateway.createCheckoutSession({
      customerId,
      organisationId: org,
      userId: ctx.user.id,
      items: items.map((i) => ({ priceId: i.priceId, quantity: i.quantity })),
      trialDays: TRIAL_DAYS,
      successUrl: `${base}${where}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}${where}?checkout=cancelled`,
    });
    await this.database.asApi(
      (client) => client.query(`select app.stripe_start_checkout($1::uuid, $2::uuid, $3, $4, $5::jsonb)`, [org, ctx.user.id, session.id, body.interval, JSON.stringify(body.seats)]),
      ctx.correlationId,
    );
    return { url: session.url, sessionId: session.id };
  }

  /**
   * The success page's check. Asks Stripe about the session (not the redirect), confirms it is this organisation's and was started by this person, and applies the
   * subscription. 'open' means the person has not finished paying yet; the webhook will also apply it, whichever comes first wins.
   */
  async confirm(ctx: RequestContext, body: ConfirmCheckoutBody): Promise<{ status: string; subscription: SubscriptionOverview }> {
    this.requireEnabled();
    const org = ctx.organisationId!;
    const owner = await this.database.asApi(
      async (client) => (await client.query(`select app.stripe_checkout_owner($1::uuid, $2) as user_id`, [org, body.sessionId])).rows[0].user_id as string | null,
      ctx.correlationId,
    );
    if (!owner || owner !== ctx.user.id) throw ApiError.notFound('checkout_not_found', 'No such checkout for you in this organisation');
    const session = await this.gateway.retrieveCheckoutSession(body.sessionId);
    if (session.organisationId && session.organisationId !== org) throw ApiError.notFound('checkout_not_found', 'No such checkout for you in this organisation');
    if (session.status === 'complete' && session.subscriptionId) {
      await this.syncSubscription(org, session.subscriptionId, body.sessionId, ctx.correlationId);
    }
    return { status: session.status, subscription: await this.billing.overview(ctx) };
  }

  /** Stripe's Customer Portal: card, invoices, tax details, and cancellation at the end of the period. */
  async portal(ctx: RequestContext, returnTo: 'setup' | 'settings' = 'settings'): Promise<{ url: string }> {
    this.requireEnabled();
    const base = this.requireBaseUrl();
    const customerId = await this.database.asApi(
      async (client) => (await client.query(`select app.stripe_customer_for($1::uuid) as id`, [ctx.organisationId])).rows[0].id as string | null,
      ctx.correlationId,
    );
    if (!customerId) throw new ApiError(409, 'no_subscription', 'There is no billing account yet. Start your subscription first.');
    return { url: await this.gateway.createPortalSession({ customerId, returnUrl: `${base}${returnTo === 'setup' ? '/setup/plan' : '/Settings/Subscription'}` }) };
  }

  /** What changing these seats would cost right now (proration from Stripe), without changing anything. */
  async previewSeats(ctx: RequestContext, body: SeatChangeBody): Promise<SeatPreviewResponse> {
    const plan = await this.planSeatChange(ctx, body.seats);
    if (plan.items.length === 0) {
      return { currency: plan.snapshot.currency, subtotal: 0, tax: 0, total: 0, amountDue: 0, lines: [], changes: plan.changes };
    }
    const preview = await this.gateway.previewSeatChange({ customerId: plan.snapshot.customerId, subscriptionId: plan.snapshot.id, items: plan.items });
    return { ...preview, changes: plan.changes };
  }

  /** Changes the seats on the Stripe subscription (prorated), then reads the result back and applies it. */
  async changeSeats(ctx: RequestContext, body: SeatChangeBody): Promise<SubscriptionOverview> {
    const plan = await this.planSeatChange(ctx, body.seats);
    if (plan.changes.some((c) => c.from !== c.to)) {
      await this.gateway.updateSeats({ subscriptionId: plan.snapshot.id, items: plan.items });
      await this.syncSubscription(ctx.organisationId!, plan.snapshot.id, undefined, ctx.correlationId);
    }
    return this.billing.overview(ctx);
  }

  // ------------------------------------------------------------------ from Stripe

  /**
   * A Stripe webhook. The signature is checked over the raw body; each event id is handled once (a failed one is retried by Stripe and handled again).
   * Subscription and invoice events are applied by re-reading the object from Stripe.
   */
  async handleWebhook(rawBody: Buffer | undefined, signature: string | undefined, correlationId: string): Promise<{ received: true; duplicate?: true }> {
    if (!this.gateway.webhookEnabled) throw new ApiError(503, 'billing_unavailable', 'Billing is not set up on this server yet');
    if (!rawBody) throw ApiError.badRequest('invalid_signature', 'The request body could not be read');
    const event = this.gateway.constructEvent(rawBody, signature);
    const recorded = await this.database.asApi(
      async (client) => (await client.query(`select app.stripe_record_event($1, $2) as r`, [event.id, event.type])).rows[0].r as string,
      correlationId,
    );
    if (recorded === 'duplicate') return { received: true, duplicate: true };

    let organisationId: string | null = null;
    try {
      const outcome = await this.process(event, correlationId);
      organisationId = outcome.organisationId;
      await this.finish(event.id, outcome.handled ? 'processed' : 'ignored', outcome.note ?? null, organisationId, correlationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.log.error(`Stripe event ${event.id} (${event.type}) failed: ${message}`);
      await this.finish(event.id, 'failed', message, organisationId, correlationId).catch(() => undefined);
      throw error; // 5xx: Stripe retries the event
    }
    return { received: true };
  }

  /** Re-reads one subscription from Stripe and applies it. Safe to call any number of times, in any order. */
  async syncSubscription(organisationId: string, subscriptionId: string, checkoutSessionId: string | undefined, correlationId: string): Promise<void> {
    const fetchedAt = new Date().toISOString(); // taken before the read: a later start is treated as newer
    const snapshot = await this.gateway.retrieveSubscription(subscriptionId);
    await this.database.asApi(
      (client) =>
        client.query(`select app.stripe_apply_subscription($1::uuid, $2::jsonb, $3::timestamptz, $4)`, [organisationId, JSON.stringify(snapshot), fetchedAt, checkoutSessionId ?? null]),
      correlationId,
    );
  }

  // ------------------------------------------------------------------ internals

  private async process(event: StripeEventEnvelope, correlationId: string): Promise<{ handled: boolean; organisationId: string | null; note?: string }> {
    const obj = event.object;
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : null);
    const metaOrg = (o: Record<string, unknown>): string | null => {
      const m = o.metadata as Record<string, string> | undefined;
      return m?.organisation_id && /^[0-9a-f-]{36}$/i.test(m.organisation_id) ? m.organisation_id : null;
    };
    const orgFor = async (customerId: string | null, subscriptionId: string | null, hint: string | null): Promise<string | null> => {
      const found = await this.database.asApi(
        async (client) => (await client.query(`select app.stripe_organisation_for($1, $2) as id`, [customerId, subscriptionId])).rows[0].id as string | null,
        correlationId,
      );
      return found ?? hint;
    };

    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const subscriptionId = str(obj.subscription);
        const organisationId = await orgFor(str(obj.customer), subscriptionId, metaOrg(obj) ?? str(obj.client_reference_id));
        if (!organisationId || !subscriptionId) return { handled: false, organisationId, note: 'no organisation or subscription to apply' };
        await this.syncSubscription(organisationId, subscriptionId, str(obj.id) ?? undefined, correlationId);
        return { handled: true, organisationId };
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed':
      case 'customer.subscription.trial_will_end': {
        const subscriptionId = str(obj.id);
        const organisationId = await orgFor(str(obj.customer), subscriptionId, metaOrg(obj));
        if (!organisationId || !subscriptionId) return { handled: false, organisationId, note: 'unknown organisation' };
        await this.syncSubscription(organisationId, subscriptionId, undefined, correlationId);
        return { handled: true, organisationId };
      }
      case 'invoice.created':
      case 'invoice.finalized':
      case 'invoice.updated':
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
      case 'invoice.payment_failed':
      case 'invoice.voided':
      case 'invoice.marked_uncollectible': {
        const invoiceId = str(obj.id);
        if (!invoiceId) return { handled: false, organisationId: null, note: 'no invoice id' };
        const invoice = await this.gateway.retrieveInvoice(invoiceId);
        const organisationId = await orgFor(invoice.customerId, invoice.subscriptionId, null);
        if (!organisationId) return { handled: false, organisationId, note: 'unknown organisation' };
        await this.database.asApi(
          (client) =>
            client.query(`select app.stripe_apply_invoice($1::uuid, $2::jsonb)`, [organisationId, JSON.stringify(invoice)]),
          correlationId,
        );
        // A payment result changes the subscription's status (past due / active): apply that too.
        if (invoice.subscriptionId) await this.syncSubscription(organisationId, invoice.subscriptionId, undefined, correlationId);
        return { handled: true, organisationId };
      }
      default:
        return { handled: false, organisationId: null, note: 'event type not used' };
    }
  }

  private finish(eventId: string, status: 'processed' | 'ignored' | 'failed', note: string | null, organisationId: string | null, correlationId: string) {
    return this.database.asApi(
      (client) => client.query(`select app.stripe_finish_event($1, $2, $3, $4::uuid)`, [eventId, status, note, organisationId]),
      correlationId,
    );
  }

  private async customerFor(ctx: RequestContext, organisationName: string): Promise<string> {
    const org = ctx.organisationId!;
    const existing = await this.database.asApi(
      async (client) => (await client.query(`select app.stripe_customer_for($1::uuid) as id`, [org])).rows[0].id as string | null,
      ctx.correlationId,
    );
    if (existing) return existing;
    const created = await this.gateway.createCustomer({ organisationId: org, name: organisationName, email: ctx.user.email });
    await this.database.asApi((client) => client.query(`select app.stripe_set_customer($1::uuid, $2)`, [org, created]), ctx.correlationId);
    return created;
  }

  private async assertNoSeatProblems(ctx: RequestContext, seats: SeatCounts): Promise<void> {
    const problems = await this.database.asUser(
      ctx,
      async (db) => (await db.execute<Row>(sql`select app.check_seat_change(${ctx.organisationId}::uuid, ${JSON.stringify(seats)}::jsonb) as problems`)).rows[0].problems as string[],
    );
    if (problems.length > 0) throw new ApiError(409, PROBLEM, problems.join(' '), { problems });
  }

  /** The Stripe subscription items to set for these seats (others untouched), and a from/to list for the screen. */
  private async planSeatChange(ctx: RequestContext, seats: SeatCounts) {
    this.requireEnabled();
    const org = ctx.organisationId!;
    const sub = await this.database.asUser(
      ctx,
      async (db) => (await db.execute<Row>(sql`select provider_subscription_id, billing_provider, status from public.organisation_subscriptions where organisation_id = ${org}::uuid`)).rows[0],
    );
    if (!sub || sub.billing_provider !== 'stripe' || !sub.provider_subscription_id || ['cancelled', 'incomplete'].includes(sub.status as string)) {
      throw new ApiError(409, 'no_subscription', 'There is no active Stripe subscription to change. Start your subscription first.');
    }
    await this.assertNoSeatProblems(ctx, seats);
    const snapshot: SubscriptionSnapshot = await this.gateway.retrieveSubscription(sub.provider_subscription_id as string);
    const items: SeatItemChange[] = [];
    const changes: { planSlug: string; from: number; to: number }[] = [];
    await this.database.asApi(async (client) => {
      for (const [slug, quantity] of Object.entries(seats)) {
        const priceId = (await client.query(`select app.stripe_price_for($1, $2) as id`, [slug, snapshot.interval])).rows[0].id as string | null;
        if (!priceId) throw new ApiError(503, 'billing_unavailable', 'Prices have not been set up in Stripe yet');
        const existing = snapshot.items.find((i) => i.priceId === priceId);
        const from = existing?.quantity ?? 0;
        changes.push({ planSlug: slug, from, to: quantity });
        if (from === quantity) continue;
        if (quantity === 0 && existing) items.push({ itemId: existing.itemId, priceId, quantity: 0, remove: true });
        else items.push({ itemId: existing?.itemId, priceId, quantity });
      }
    }, ctx.correlationId);
    return { snapshot, items, changes };
  }

  private requireEnabled(): void {
    if (!this.gateway.enabled) throw new ApiError(503, 'billing_unavailable', 'Billing is not set up on this server yet');
  }

  private requireBaseUrl(): string {
    const base = appBaseUrl(this.env);
    if (!base) throw new ApiError(503, 'billing_unavailable', 'APP_BASE_URL is not set on this server');
    return base;
  }
}

