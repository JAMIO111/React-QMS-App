import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import { ENV, Env } from '../config/env';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { WorkerJobRegistry } from '../worker/job-registry';
import type { HoursQuery, LimitQuery, Overview, OverviewQuery, OrganisationsQuery, PlatformActivity, PlatformOrganisations } from './platform.schemas';

type Status = 'none' | 'needs_mfa' | 'ok';

/** The operator's monitor: what is happening to sign-ups. Reads only the platform's own tables through admin-only database functions. */
@Injectable()
export class PlatformService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(ENV) private readonly env: Env,
    private readonly jobs: WorkerJobRegistry,
  ) {}

  me(ctx: RequestContext): Promise<{ status: Status }> {
    return this.database.asUser(ctx, async (db) => ({ status: await this.status(db) }));
  }

  /** Someone who is not an operator is told nothing about the area; an operator without MFA is told what to do. */
  private async requireOperator(db: Db): Promise<void> {
    const status = await this.status(db);
    if (status === 'none') throw ApiError.notFound('not_found', 'Not found');
    if (status === 'needs_mfa') throw new ApiError(403, 'mfa_required', 'Platform administration needs a session that has passed two-factor authentication');
  }

  organisations(ctx: RequestContext, q: OrganisationsQuery): Promise<PlatformOrganisations> {
    return this.database.asUser(ctx, async (db) => {
      await this.requireOperator(db);
      const res = await db.execute<Record<string, unknown>>(sql`select * from app.platform_organisations(${q.search ?? null}, ${q.limit}::int, ${q.offset}::int)`);
      const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
      return {
        total: res.rows.length ? Number(res.rows[0].total_rows) : 0,
        data: res.rows.map((r) => ({
          organisationId: r.organisation_id as string,
          name: r.name as string,
          status: r.status as string,
          createdAt: iso(r.created_at)!,
          country: (r.country as string) ?? null,
          billingRequired: r.billing_required as boolean,
          setupFinishedAt: iso(r.onboarding_completed_at),
          ownerEmails: (r.owner_emails as string[]) ?? [],
          members: Number(r.members),
          subscriptionStatus: (r.subscription_status as string) ?? null,
          billingProvider: (r.billing_provider as string) ?? null,
          billingInterval: (r.billing_interval as string) ?? null,
          trialEnd: iso(r.trial_end),
          currentPeriodEnd: iso(r.current_period_end),
          cancelAtPeriodEnd: (r.cancel_at_period_end as boolean) ?? null,
          pastDueSince: iso(r.past_due_since),
          seatsPurchased: Number(r.seats_purchased),
          seatsAssigned: Number(r.seats_assigned),
          mrrPence: Number(r.mrr_pence),
          lastSyncedAt: iso(r.last_synced_at),
        })),
      };
    });
  }

  revenue(ctx: RequestContext): Promise<Record<string, unknown>> {
    return this.json(ctx, (db) => db.execute<{ r: Record<string, unknown> }>(sql`select app.platform_revenue() as r`));
  }

  payments(ctx: RequestContext, q: LimitQuery): Promise<Record<string, unknown>> {
    return this.json(ctx, (db) => db.execute<{ r: Record<string, unknown> }>(sql`select app.platform_payments(${q.limit}::int) as r`));
  }

  async email(ctx: RequestContext, q: HoursQuery): Promise<Record<string, unknown>> {
    const r = await this.json(ctx, (db) => db.execute<{ r: Record<string, unknown> }>(sql`select app.platform_email_outbox(${q.hours}::int) as r`));
    return { provider: this.env.MAIL_PROVIDER, sending: this.env.MAIL_PROVIDER !== 'none', ...r };
  }

  /** The background worker (WK1): last ticks, the job queue, failures and outbox backlogs; whether this server can be ticked at all. */
  async worker(ctx: RequestContext): Promise<Record<string, unknown>> {
    const r = await this.json(ctx, (db) => db.execute<{ r: Record<string, unknown> }>(sql`select app.platform_worker_health() as r`));
    return { cronConfigured: !!this.env.CRON_SECRET, jobKinds: this.jobs.kinds(), ...r };
  }

  webhooks(ctx: RequestContext, q: HoursQuery): Promise<Record<string, unknown>> {
    return this.json(ctx, (db) => db.execute<{ r: Record<string, unknown> }>(sql`select app.platform_webhooks(${q.hours}::int) as r`));
  }

  activity(ctx: RequestContext, q: LimitQuery): Promise<PlatformActivity> {
    return this.database.asUser(ctx, async (db) => {
      await this.requireOperator(db);
      const res = await db.execute<Record<string, unknown>>(sql`select * from app.platform_activity(${q.limit}::int)`);
      return {
        data: res.rows.map((r) => ({
          at: new Date(r.occurred_at as string).toISOString(),
          kind: r.kind as string,
          event: r.event as string,
          organisationId: r.organisation_id as string,
          organisation: r.organisation_name as string,
          details: (r.details as Record<string, unknown>) ?? {},
        })),
      };
    });
  }

  private json(ctx: RequestContext, query: (db: Db) => Promise<{ rows: { r: Record<string, unknown> }[] }>): Promise<Record<string, unknown>> {
    return this.database.asUser(ctx, async (db) => {
      await this.requireOperator(db);
      return (await query(db)).rows[0].r;
    });
  }

  overview(ctx: RequestContext, q: OverviewQuery): Promise<Overview> {
    return this.database.asUser(ctx, async (db) => {
      await this.requireOperator(db);
      const funnel = await db.execute<{ f: Record<string, unknown> }>(sql`select app.platform_funnel(${q.days}::int) as f`);
      const rows = await db.execute<Record<string, unknown>>(sql`select * from app.platform_recent_signups(25)`);
      const f = funnel.rows[0].f;
      return {
        funnel: {
          days: Number(f.days),
          since: String(f.since),
          signedUp: Number(f.signedUp),
          verified: Number(f.verified),
          orgStarted: Number(f.orgStarted),
          totalAccounts: Number(f.totalAccounts),
          totalOrganisations: Number(f.totalOrganisations),
        },
        recentSignups: rows.rows.map((r) => ({
          userId: r.user_id as string,
          email: (r.email as string) ?? null,
          name: [r.first_name, r.surname].filter(Boolean).join(' ') || null,
          signedUpAt: new Date(r.signed_up_at as string).toISOString(),
          verifiedAt: r.verified_at ? new Date(r.verified_at as string).toISOString() : null,
          orgStartedAt: r.org_started_at ? new Date(r.org_started_at as string).toISOString() : null,
          organisationName: (r.organisation_name as string) ?? null,
        })),
      };
    });
  }

  private async status(db: Db): Promise<Status> {
    const res = await db.execute<{ s: Status }>(sql`select app.platform_account_status() as s`);
    return res.rows[0].s;
  }
}
