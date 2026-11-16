import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { checkVerificationRecord, DnsTxtResolver, verificationValue } from './dns-txt';

type Row = Record<string, unknown>;
const orgOf = (ctx: RequestContext) => {
  if (!ctx.organisationId) throw new Error('organisation-scoped route without an organisation');
  return ctx.organisationId;
};
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export type DomainState = 'verified' | 'unverified' | 'failing' | 'removed';

/**
 * Settings → Security → Single sign-on (docs/sso-plan.md SS1): the organisation's SSO settings and its email domains. Adding and removing go
 * through the database functions (security.manage); a DNS check is looked up here and recorded by the API login (`app.system_sso_domain_check`),
 * because a person must never be able to mark a domain verified. Reads run as the person under RLS (security.read).
 */
@Injectable()
export class SsoService {
  private readonly log = new Logger(SsoService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly dns: DnsTxtResolver,
  ) {}

  overview(ctx: RequestContext) {
    return this.database.asUser(ctx, (db) => this.load(db, ctx));
  }

  addDomain(ctx: RequestContext, domain: string) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.add_sso_domain(${orgOf(ctx)}::uuid, ${domain})`);
      return this.load(db, ctx);
    });
  }

  removeDomain(ctx: RequestContext, id: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.ownDomain(db, ctx, id);
      await db.execute(sql`select app.remove_sso_domain(${id}::uuid, ${reason})`);
      return this.load(db, ctx);
    });
  }

  /** Look the record up now and record the outcome. Answers with the overview plus what this check found. */
  async verifyDomain(ctx: RequestContext, id: string) {
    const domain = await this.database.asUser(ctx, (db) => this.ownDomain(db, ctx, id));
    if (domain.removed) throw new ApiError(409, 'sso_rule', 'That domain was removed. Add it again.');
    const check = await checkVerificationRecord(this.dns, domain.domain, domain.token);
    const state = await this.database.asApi(
      async (c) =>
        (await c.query(`select app.system_sso_domain_check($1::uuid, $2, $3, $4::uuid) as state`, [id, check.found, check.error, ctx.user.id])).rows[0]
          .state as string,
      ctx.correlationId,
      'sso',
    );
    const overview = await this.overview(ctx);
    return { ...overview, check: { domainId: id, outcome: state as 'verified' | 'unverified' | 'failed' | 'refused' } };
  }

  /** The worker's weekly check of verified domains. A missing record flags the domain (owners see it); nothing is removed. */
  async recheckDue(correlationId: string, limit = 20) {
    const due = await this.database.asApi(
      async (c) => (await c.query(`select id, domain, verification_token from app.system_sso_domains_due($1::int)`, [limit])).rows as Row[],
      correlationId,
      'worker',
    );
    let verified = 0;
    let failing = 0;
    for (const d of due) {
      const check = await checkVerificationRecord(this.dns, d.domain as string, d.verification_token as string);
      try {
        const state = await this.database.asApi(
          async (c) => (await c.query(`select app.system_sso_domain_check($1::uuid, $2, $3, null) as state`, [d.id, check.found, check.error])).rows[0].state,
          correlationId,
          'worker',
        );
        if (state === 'verified') verified++;
        else failing++;
      } catch (e) {
        // A domain removed between the list and the check: skip it.
        this.log.warn(`SSO domain check for ${d.id as string} not recorded: ${(e as Error).message}`);
      }
    }
    return { checked: due.length, verified, failing };
  }

  private async ownDomain(db: Db, ctx: RequestContext, id: string) {
    const r = await db.execute<Row>(sql`
      select domain, verification_token, removed_at from public.organisation_sso_domains where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
    const row = r.rows[0];
    if (!row) throw ApiError.notFound('sso_domain_not_found', 'Domain not found');
    return { domain: row.domain as string, token: row.verification_token as string, removed: row.removed_at != null };
  }

  private async load(db: Db, ctx: RequestContext) {
    const org = orgOf(ctx);
    const s = (
      await db.execute<Row>(sql`
        select s.sso_mode, s.sso_join, s.sso_trust_idp_mfa, s.allowed_email_domains,
               app.has_permission(${org}::uuid, 'security.manage') as can_manage
          from public.organisation_settings s where s.organisation_id = ${org}::uuid`)
    ).rows[0] ?? {};
    const rows = await db.execute<Row>(sql`
      select d.id, d.domain, d.verification_token, d.verified_at, d.last_checked_at, d.check_failed_at, d.check_error,
             d.removed_at, d.removed_reason, d.created_at,
             nullif(btrim(concat_ws(' ', vp.first_name, vp.surname)), '') as verified_by,
             nullif(btrim(concat_ws(' ', cp.first_name, cp.surname)), '') as created_by,
             nullif(btrim(concat_ws(' ', rp.first_name, rp.surname)), '') as removed_by
        from public.organisation_sso_domains d
        left join public.profiles vp on vp.id = d.verified_by
        left join public.profiles cp on cp.id = d.created_by
        left join public.profiles rp on rp.id = d.removed_by
       where d.organisation_id = ${org}::uuid
       order by d.removed_at is not null, d.removed_at desc nulls first, d.domain
       limit 60`);
    const domains = rows.rows.map((d) => {
      const removed = d.removed_at != null;
      const state: DomainState = removed ? 'removed' : d.verified_at ? (d.check_failed_at ? 'failing' : 'verified') : 'unverified';
      return {
        id: d.id as string,
        domain: d.domain as string,
        state,
        /** What to add at the company's DNS provider. Shown until removed. */
        record: removed ? null : { type: 'TXT' as const, name: d.domain as string, value: verificationValue(d.verification_token as string) },
        verifiedAt: iso(d.verified_at),
        verifiedBy: (d.verified_by as string) ?? null,
        lastCheckedAt: iso(d.last_checked_at),
        checkFailedAt: iso(d.check_failed_at),
        checkError: (d.check_error as string) ?? null,
        createdAt: iso(d.created_at)!,
        createdBy: (d.created_by as string) ?? null,
        removedAt: iso(d.removed_at),
        removedBy: (d.removed_by as string) ?? null,
        removedReason: (d.removed_reason as string) ?? null,
      };
    });
    return {
      mode: ((s.sso_mode as string) ?? 'off') as 'off' | 'optional' | 'required',
      join: ((s.sso_join as string) ?? 'invited') as 'invited' | 'domain',
      trustIdpMfa: s.sso_trust_idp_mfa !== false,
      canManage: Boolean(s.can_manage),
      /** Invitations only to these (SE6); an SSO domain must be one of them, or a sub-domain of one, while the list is set. */
      allowedEmailDomains: (s.allowed_email_domains as string[]) ?? [],
      domains,
    };
  }
}
