import { Injectable, Logger } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { DatabaseService } from '../database/database.service';
import { StripeBillingService } from '../billing/stripe-billing.service';
import { StripeGateway } from '../billing/stripe.gateway';
import { SyncEngine } from '../integrations/core/sync.engine';

export interface ArchiveOutcome {
  dryRun: boolean;
  unpaidDays: number;
  lapsedDays: number;
  unpaid: { organisationId: string; name: string; createdAt: string }[];
  lapsed: { organisationId: string; name: string; lapsedSince: string }[];
  archived: number;
}

/**
 * The scheduled jobs. They run as the API login (no signed-in person) and only call database functions made for that: nothing here can read or change an
 * organisation's business data. Both are safe to run as often as you like.
 */
@Injectable()
export class CronService {
  private readonly log = new Logger(CronService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly billing: StripeBillingService,
    private readonly gateway: StripeGateway,
    private readonly sync: SyncEngine,
  ) {}

  /**
   * Re-reads Stripe-billed subscriptions that have not been synced for `staleMinutes` (oldest first, up to `limit`) and applies them through the same idempotent
   * path as the webhook, so a webhook that was lost is repaired. One failing subscription never stops the others.
   */
  async reconcile(limit: number, staleMinutes: number, correlationId: string) {
    if (!this.gateway.enabled) throw new ApiError(503, 'billing_unavailable', 'Billing is not set up on this server yet');
    const candidates = await this.database.asApi(
      async (client) =>
        (await client.query(`select organisation_id, provider_subscription_id from app.system_reconcile_candidates($1::int, $2::int)`, [limit, staleMinutes])).rows as {
          organisation_id: string;
          provider_subscription_id: string;
        }[],
      correlationId,
    );
    const failed: { organisationId: string; error: string }[] = [];
    let synced = 0;
    for (const c of candidates) {
      try {
        await this.billing.syncSubscription(c.organisation_id, c.provider_subscription_id, undefined, correlationId);
        synced += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        this.log.warn(`Reconcile of ${c.organisation_id} failed: ${message}`);
        failed.push({ organisationId: c.organisation_id, error: message.slice(0, 300) });
      }
    }
    return { checked: candidates.length, synced, failed };
  }

  /** Expires every active quality alert past its expiry date, in every organisation, and logs each in the alert's history. Safe to run as often as you like. */
  async expireQualityAlerts(correlationId: string): Promise<{ expired: number }> {
    const expired = await this.database.asApi(async (client) => Number((await client.query(`select app.system_expire_quality_alerts() as n`)).rows[0].n), correlationId);
    return { expired };
  }

  /** Archives unused organisations (see app.system_archive_stale_organisations). A dry run only reports what it would do. */
  archiveStale(unpaidDays: number, lapsedDays: number, dryRun: boolean, correlationId: string): Promise<ArchiveOutcome> {
    return this.database.asApi(
      async (client) =>
        (await client.query(`select app.system_archive_stale_organisations($1::int, $2::int, $3::boolean) as r`, [unpaidDays, lapsedDays, dryRun])).rows[0].r as ArchiveOutcome,
      correlationId,
    );
  }

  /**
   * The daily integration job (IN8): asks for every scheduled import (once a day each, as the person who scheduled it; one still waiting from
   * before carries on instead), then works the runs that are waiting for as long as this call allows.
   */
  async integrationSchedule(limit: number, correlationId: string) {
    const scheduled = await this.database.asApi(
      async (client) => (await client.query(`select app.system_schedule_integration_runs() as r`)).rows[0].r as { connectionId: string; entityType: string; runId: string | null; skipped: string | null }[],
      correlationId,
      'integration',
    );
    const worked = await this.integrationRuns(limit, correlationId);
    return { scheduled, ...worked };
  }

  /**
   * Works integration runs that are waiting (queued, part-done, or due to try again), oldest first, each for a short while, stopping after about 45 seconds
   * in all. Each run is leased, so this never collides with a person's "Run now"; anything left is picked up by the next call.
   */
  async integrationRuns(limit: number, correlationId: string): Promise<{ due: number; results: { runId: string; state: string; reason: string | null }[] }> {
    const due = await this.database.asApi(
      async (client) => (await client.query(`select organisation_id, run_id from app.system_integration_runs_due($1::int)`, [limit])).rows as { organisation_id: string; run_id: string }[],
      correlationId,
      'integration',
    );
    const stopAt = Date.now() + 45_000;
    const results: { runId: string; state: string; reason: string | null }[] = [];
    for (const d of due) {
      const left = stopAt - Date.now();
      if (left < 2_000) break;
      try {
        const r = await this.sync.drain(d.organisation_id, d.run_id, { correlationId, budgetMs: Math.min(20_000, left) });
        results.push({ runId: d.run_id, state: r.state, reason: r.reason ?? null });
      } catch (error) {
        this.log.warn(`Integration run ${d.run_id} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        results.push({ runId: d.run_id, state: 'error', reason: 'The run could not be worked on' });
      }
    }
    return { due: due.length, results };
  }
}
