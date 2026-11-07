import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import { iso, num, Row } from '../calibration/calibration.service';
import type { RequestContext } from '../common/request-context';
import { ENV, Env, corsOrigins } from '../config/env';
import { DatabaseService } from '../database/database.service';
import { StripeGateway } from './stripe.gateway';
import {
  AccessLevel,
  AssignPackageBody,
  Invoice,
  PlanCatalogue,
  SeatMember,
  SetSeatsBody,
  SubscriptionAccess,
  SubscriptionEvent,
  SubscriptionOverview,
} from './billing.schemas';

const RANK: Record<AccessLevel, number> = { none: 0, view: 1, operational: 2, full: 3 };

/**
 * Subscription and billing. Prices, packages and the module/feature matrix are read from the database;
 * nothing here knows a package name or an amount. All writes go through SECURITY DEFINER functions that
 * check the billing permission and the seat limits, so the rules hold whichever way the data is reached.
 * Subscription is deliberately separate from RBAC: see app.has_permission (RBAC AND entitlement).
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly gateway: StripeGateway,
    @Inject(ENV) private readonly env: Env,
  ) {}

  catalogue(ctx: RequestContext): Promise<PlanCatalogue> {
    return this.database.asUser(ctx, async (db) => {
      const plans = (await db.execute<Row>(sql`select * from public.subscription_plans where status = 'active' order by display_order`)).rows;
      const prices = (await db.execute<Row>(sql`
        select p.*, s.slug from public.subscription_prices p join public.subscription_plans s on s.id = p.subscription_plan_id
        where p.active and p.currency = 'GBP' and p.effective_from <= now() and (p.effective_to is null or p.effective_to > now())`)).rows;
      const modules = (await db.execute<Row>(sql`select * from public.modules where status <> 'retired' order by display_order`)).rows;
      const features = (await db.execute<Row>(sql`select * from public.features where status <> 'retired' order by slug`)).rows;
      const entitlements = (await db.execute<Row>(sql`
        select e.*, s.slug as plan_slug, m.slug as module_slug from public.subscription_entitlements e
        join public.subscription_plans s on s.id = e.subscription_plan_id join public.modules m on m.id = e.module_id
        where e.feature_id is null`)).rows;

      const levelOf = (planSlug: string, moduleSlug: string): AccessLevel => {
        const e = entitlements.find((x) => x.plan_slug === planSlug && x.module_slug === moduleSlug);
        return e && e.enabled ? (e.access_level as AccessLevel) : 'none';
      };

      return {
        plans: plans.map((p) => {
          const price = (interval: string) => {
            const r = prices.find((x) => x.slug === p.slug && x.billing_interval === interval);
            return r ? { unitAmount: Number(r.unit_amount), currency: r.currency as string } : null;
          };
          const monthly = price('month');
          const annual = price('year');
          return {
            slug: p.slug as string,
            name: p.name as string,
            description: (p.description as string) ?? null,
            monthly,
            annual,
            annualMonthlyEquivalent: annual ? Math.round(annual.unitAmount / 12) : null,
            annualSaving: monthly && annual ? monthly.unitAmount * 12 - annual.unitAmount : null,
            levels: Object.fromEntries(modules.map((m) => [m.slug as string, levelOf(p.slug as string, m.slug as string)])),
          };
        }),
        modules: modules.map((m) => ({
          slug: m.slug as string,
          name: m.name as string,
          status: m.status as string,
          features: features
            .filter((f) => f.module_id === m.id)
            .map((f) => ({
              slug: f.slug as string,
              name: f.name as string,
              minLevel: f.min_access_level as AccessLevel,
              includedIn: plans
                .filter((p) => RANK[levelOf(p.slug as string, m.slug as string)] >= RANK[f.min_access_level as AccessLevel])
                .map((p) => p.slug as string),
            })),
        })),
      };
    });
  }

  overview(ctx: RequestContext): Promise<SubscriptionOverview> {
    return this.database.asUser(ctx, async (db) => {
      const org = ctx.organisationId;
      const sub = (await db.execute<Row>(sql`
        select s.*, o.entitlements_enforced, o.grace_period_days, o.vat_rate,
               (select g.billing_required from public.organisations g where g.id = o.organisation_id) as billing_required,
               exists (select 1 from public.subscription_prices pr where pr.provider_price_id is not null and pr.active) as prices_ready
        from public.organisation_settings o left join public.organisation_subscriptions s on s.organisation_id = o.organisation_id
        where o.organisation_id = ${org}::uuid`)).rows[0];
      const items = (await db.execute<Row>(sql`
        select p.slug, p.name, i.quantity, i.unit_amount_snapshot,
               (select count(*) from public.user_subscription_assignments a where a.subscription_item_id = i.id and a.status = 'active') as assigned
        from public.organisation_subscription_items i join public.subscription_plans p on p.id = i.subscription_plan_id
        where i.organisation_id = ${org}::uuid order by p.display_order`)).rows;

      const rows = items.map((i) => ({
        planSlug: i.slug as string,
        planName: i.name as string,
        purchased: Number(i.quantity),
        assigned: Number(i.assigned),
        available: Math.max(0, Number(i.quantity) - Number(i.assigned)),
        unitAmount: Number(i.unit_amount_snapshot),
      }));
      const interval = (sub?.billing_interval as 'month' | 'year' | undefined) ?? 'month';
      const recurring = items.reduce((t, i) => t + Number(i.quantity) * Number(i.unit_amount_snapshot), 0);
      return {
        subscription: sub?.id
          ? {
              status: sub.status as string,
              billingInterval: interval,
              currency: sub.currency as string,
              billingProvider: sub.billing_provider as string,
              currentPeriodStart: iso(sub.current_period_start)!,
              currentPeriodEnd: iso(sub.current_period_end),
              cancelAtPeriodEnd: sub.cancel_at_period_end as boolean,
              pastDueSince: iso(sub.past_due_since),
              trialEnd: iso(sub.trial_end),
              entitlementsEnforced: sub.entitlements_enforced as boolean,
              gracePeriodDays: Number(sub.grace_period_days),
            }
          : null,
        checkoutAvailable: this.gateway.enabled && !!(sub?.prices_ready) && !!(this.env.APP_BASE_URL ?? corsOrigins(this.env).find((o) => typeof o === 'string')),
        providerManaged: !!sub?.billing_required || sub?.billing_provider === 'stripe',
        items: rows,
        totals: {
          seatsPurchased: rows.reduce((t, r) => t + r.purchased, 0),
          seatsAssigned: rows.reduce((t, r) => t + r.assigned, 0),
          seatsAvailable: rows.reduce((t, r) => t + r.available, 0),
          monthlyEquivalent: interval === 'year' ? Math.round(recurring / 12) : recurring,
          annual: interval === 'year' ? recurring : recurring * 12,
          vatRate: Number(sub?.vat_rate ?? 0.2),
        },
      };
    });
  }

  setSeats(ctx: RequestContext, body: SetSeatsBody): Promise<SubscriptionOverview> {
    return this.database
      .asUser(ctx, (db) => db.execute(sql`select app.set_subscription_seats(${ctx.organisationId}::uuid, ${body.planSlug}, ${body.quantity})`))
      .then(() => this.overview(ctx));
  }

  seats(ctx: RequestContext): Promise<SeatMember[]> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`select * from app.list_seat_assignments(${ctx.organisationId}::uuid)`);
      return res.rows.map((r) => ({
        membershipId: r.membership_id as string,
        email: (r.email as string) ?? null,
        firstName: (r.first_name as string) ?? null,
        surname: (r.surname as string) ?? null,
        status: r.status as string,
        roles: (r.roles as string[]) ?? [],
        plan: r.plan_slug ? { slug: r.plan_slug as string, name: r.plan_name as string } : null,
        assignedAt: iso(r.assigned_at),
        unitAmount: num(r.unit_amount),
      }));
    });
  }

  async assign(ctx: RequestContext, membershipId: string, body: AssignPackageBody): Promise<SeatMember> {
    await this.seatFor(ctx, membershipId);
    await this.database.asUser(ctx, (db) => db.execute(sql`select app.assign_subscription_package(${membershipId}::uuid, ${body.planSlug})`));
    return this.seatFor(ctx, membershipId);
  }

  async unassign(ctx: RequestContext, membershipId: string): Promise<void> {
    await this.seatFor(ctx, membershipId);
    await this.database.asUser(ctx, (db) => db.execute(sql`select app.remove_subscription_assignment(${membershipId}::uuid)`));
  }

  check(ctx: RequestContext, moduleSlug: string, featureSlug?: string) {
    return this.database.asUser(ctx, async (db) => {
      const r = (await db.execute<Row>(sql`select * from app.check_entitlement(${ctx.organisationId}::uuid, ${moduleSlug}, ${featureSlug ?? null})`)).rows[0];
      return {
        allowed: r.allowed as boolean,
        reason: r.reason as string,
        currentPlan: (r.current_plan as string) ?? null,
        requiredPlan: (r.required_plan as string) ?? null,
      };
    });
  }

  access(ctx: RequestContext): Promise<SubscriptionAccess> {
    return this.database.asUser(ctx, async (db) => {
      const r = (await db.execute<Row>(sql`select app.my_subscription_access(${ctx.organisationId}::uuid) as access`)).rows[0];
      return r.access as SubscriptionAccess;
    });
  }

  invoices(ctx: RequestContext): Promise<Invoice[]> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`select * from public.billing_invoices where organisation_id = ${ctx.organisationId}::uuid
        order by coalesce(invoice_date, created_at::date) desc, created_at desc limit 200`);
      return res.rows.map((r) => ({
        id: r.id as string,
        invoiceNumber: (r.invoice_number as string) ?? null,
        invoiceDate: r.invoice_date ? new Date(r.invoice_date as string).toISOString().slice(0, 10) : null,
        periodStart: iso(r.period_start),
        periodEnd: iso(r.period_end),
        currency: r.currency as string,
        subtotal: Number(r.subtotal),
        taxAmount: Number(r.tax_amount),
        totalAmount: Number(r.total_amount),
        status: r.status as string,
        paidAt: iso(r.paid_at),
        invoicePdfUrl: (r.invoice_pdf_url as string) ?? null,
      }));
    });
  }

  history(ctx: RequestContext): Promise<SubscriptionEvent[]> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`select * from public.subscription_audit_logs where organisation_id = ${ctx.organisationId}::uuid
        order by created_at desc limit 200`);
      return res.rows.map((r) => ({
        id: r.id as string,
        eventType: r.event_type as string,
        actorUserId: (r.actor_user_id as string) ?? null,
        membershipId: (r.organisation_membership_id as string) ?? null,
        details: (r.details as Record<string, unknown>) ?? {},
        createdAt: iso(r.created_at)!,
      }));
    });
  }

  private async seatFor(ctx: RequestContext, membershipId: string): Promise<SeatMember> {
    const all = await this.seats(ctx);
    const seat = all.find((m) => m.membershipId === membershipId);
    if (!seat) throw ApiError.notFound('member_not_found', 'Member not found');
    return seat;
  }
}
