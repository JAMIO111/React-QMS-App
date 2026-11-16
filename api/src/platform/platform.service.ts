import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import { ENV, Env } from '../config/env';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { WorkerJobRegistry } from '../worker/job-registry';
import { manifestProblem, parseReleaseKeys, verifyRelease } from '../integrations/agents/agent-release';
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
      const ids = res.rows.map((r) => r.organisation_id as string);
      const policies = new Map<string, string>();
      const sso = new Map<string, { mode: 'off' | 'optional' | 'required'; connected: boolean }>();
      if (ids.length) {
        const p = await db.execute<{ organisation_id: string; network_policy: string }>(
          sql`select organisation_id, network_policy from app.platform_network_policies(${`{${ids.join(',')}}`}::uuid[])`,
        );
        for (const row of p.rows) policies.set(row.organisation_id, row.network_policy);
        const m = await db.execute<{ organisation_id: string; sso_mode: string; connected: boolean }>(
          sql`select organisation_id, sso_mode, connected from app.platform_sso_modes(${`{${ids.join(',')}}`}::uuid[])`,
        );
        for (const row of m.rows) sso.set(row.organisation_id, { mode: row.sso_mode as 'off' | 'optional' | 'required', connected: Boolean(row.connected) });
      }
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
          networkPolicy: (policies.get(r.organisation_id as string) ?? 'off') as 'off' | 'monitor' | 'enforce',
          sso: sso.get(r.organisation_id as string) ?? { mode: 'off' as const, connected: false },
        })),
      };
    });
  }

  /**
   * Recovery when everyone is locked out (docs/security-plan.md S6): an enforced policy goes back to monitor, never off, with a reason and how
   * ownership was verified. The database checks the operator (allow-list and MFA), writes the history row and tells every owner and admin.
   */
  recoverNetworkPolicy(ctx: RequestContext, organisationId: string, body: { reason: string; verification: string }) {
    return this.database.asUser(ctx, async (db) => {
      await this.requireOperator(db);
      const r = await db.execute<{ id: string }>(
        sql`select app.platform_recover_network_policy(${organisationId}::uuid, ${body.reason}, ${body.verification}) as id`,
      );
      return { organisationId, networkPolicy: 'monitor' as const, changeId: r.rows[0].id };
    });
  }

  /**
   * Recovery when the company sign-in fails and nobody can get in (docs/sso-plan.md SS8): required goes back to optional, never off, with a reason
   * and how ownership was verified. The database checks the operator, writes the history row and tells every owner and admin.
   */
  recoverSso(ctx: RequestContext, organisationId: string, body: { reason: string; verification: string }) {
    return this.database.asUser(ctx, async (db) => {
      await this.requireOperator(db);
      const r = await db.execute<{ id: string }>(sql`select app.platform_recover_sso(${organisationId}::uuid, ${body.reason}, ${body.verification}) as id`);
      return { organisationId, ssoMode: 'optional' as const, changeId: r.rows[0].id };
    });
  }

  /**
   * Connector agent releases (docs/connector-agent-plan.md AG6b), every one including withdrawn, with how many agents run each version. The keys
   * Fortress checks signatures with come from AGENT_RELEASE_KEYS; without any, nothing can be published.
   */
  agentReleases(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      await this.requireOperator(db);
      const res = await db.execute<Record<string, unknown>>(sql`
        select r.id, r.version, r.platform, r.url, r.sha256, r.size_bytes, r.notes, r.key_id, r.status, r.published_at, r.withdrawn_at, r.withdrawn_reason,
               nullif(btrim(concat_ws(' ', p.first_name, p.surname)), '') as published_by,
               (select count(*) from app.platform_agent_versions() v where v.version = r.version and v.platform = r.platform)::int as agents_on
          from public.integration_agent_releases r
          left join public.profiles p on p.id = r.published_by
         order by r.published_at desc`);
      const keys = parseReleaseKeys(this.env.AGENT_RELEASE_KEYS);
      return {
        data: res.rows.map((r) => ({
          id: r.id as string, version: r.version as string, platform: r.platform as 'win-x64' | 'linux-x64', url: r.url as string,
          sha256: r.sha256 as string, sizeBytes: Number(r.size_bytes), notes: (r.notes as string | null) ?? null, keyId: r.key_id as string,
          status: r.status as 'published' | 'withdrawn', publishedAt: new Date(r.published_at as string).toISOString(),
          publishedBy: (r.published_by as string | null) ?? null,
          withdrawnAt: r.withdrawn_at ? new Date(r.withdrawn_at as string).toISOString() : null,
          withdrawnReason: (r.withdrawn_reason as string | null) ?? null, agentsOn: Number(r.agents_on),
        })),
        keysConfigured: keys.length > 0,
        keyIds: keys.map((k) => k.keyId),
      };
    });
  }

  /** Publish a signed release: the manifest must read right and be signed by one of the keys in AGENT_RELEASE_KEYS. */
  publishAgentRelease(ctx: RequestContext, body: { manifest: string; signature: string }) {
    return this.database.asUser(ctx, async (db) => {
      await this.requireOperator(db);
      const keys = parseReleaseKeys(this.env.AGENT_RELEASE_KEYS);
      if (!keys.length) throw new ApiError(503, 'release_keys_unavailable', 'No release signing key is configured (AGENT_RELEASE_KEYS), so no release can be published');
      const problem = manifestProblem(body.manifest);
      if (problem) throw ApiError.badRequest('invalid_release', problem);
      const keyId = verifyRelease(body.manifest, body.signature, keys);
      if (!keyId) throw ApiError.badRequest('invalid_release', 'The signature does not match the manifest with any configured release key');
      const r = await db.execute<{ id: string }>(sql`select app.platform_publish_agent_release(${body.manifest}, ${body.signature}, ${keyId}) as id`);
      return { id: r.rows[0].id, keyId };
    });
  }

  withdrawAgentRelease(ctx: RequestContext, id: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.requireOperator(db);
      await db.execute(sql`select app.platform_withdraw_agent_release(${id}::uuid, ${reason})`);
      return { id, status: 'withdrawn' as const };
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
