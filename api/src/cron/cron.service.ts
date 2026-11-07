import { Injectable, Logger } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { DatabaseService } from '../database/database.service';
import { StripeBillingService } from '../billing/stripe-billing.service';
import { StripeGateway } from '../billing/stripe.gateway';

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

  /** Archives unused organisations (see app.system_archive_stale_organisations). A dry run only reports what it would do. */
  archiveStale(unpaidDays: number, lapsedDays: number, dryRun: boolean, correlationId: string): Promise<ArchiveOutcome> {
    return this.database.asApi(
      async (client) =>
        (await client.query(`select app.system_archive_stale_organisations($1::int, $2::int, $3::boolean) as r`, [unpaidDays, lapsedDays, dryRun])).rows[0].r as ArchiveOutcome,
      correlationId,
    );
  }
}
