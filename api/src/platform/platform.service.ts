import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import type { Overview, OverviewQuery } from './platform.schemas';

type Status = 'none' | 'needs_mfa' | 'ok';

/** The operator's monitor: what is happening to sign-ups. Reads only the platform's own tables through admin-only database functions. */
@Injectable()
export class PlatformService {
  constructor(private readonly database: DatabaseService) {}

  me(ctx: RequestContext): Promise<{ status: Status }> {
    return this.database.asUser(ctx, async (db) => ({ status: await this.status(db) }));
  }

  overview(ctx: RequestContext, q: OverviewQuery): Promise<Overview> {
    return this.database.asUser(ctx, async (db) => {
      const status = await this.status(db);
      // Someone who is not an operator is told nothing about the area; an operator without MFA is told what to do.
      if (status === 'none') throw ApiError.notFound('not_found', 'Not found');
      if (status === 'needs_mfa') throw new ApiError(403, 'mfa_required', 'Platform administration needs a session that has passed two-factor authentication');
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
