import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { ENV, Env } from '../config/env';
import { DatabaseService, Db } from '../database/database.service';
import { checkVerificationRecord, DnsTxtResolver, verificationValue } from './dns-txt';
import { SamlMetadata, serviceProviderValues, SsoAdminRefused, SsoAdminUnavailable, SupabaseSsoAdmin } from './supabase-sso-admin';

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
    private readonly admin: SupabaseSsoAdmin,
    @Inject(ENV) private readonly env: Env,
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

  async removeDomain(ctx: RequestContext, id: string, reason: string) {
    await this.database.asUser(ctx, async (db) => {
      await this.ownDomain(db, ctx, id);
      await db.execute(sql`select app.remove_sso_domain(${id}::uuid, ${reason})`);
    });
    await this.syncProviderDomains(orgOf(ctx), ctx.correlationId);
    return this.overview(ctx);
  }

  /**
   * Connects the company's identity provider (SS2): registers it with Supabase for the organisation's verified domains, or replaces the active
   * one's metadata. Supabase reads and checks the metadata; its refusal comes back as 409 sso_rule in its own words.
   */
  async saveProvider(ctx: RequestContext, metadata: SamlMetadata) {
    this.requireAdmin();
    const org = orgOf(ctx);
    const state = await this.state(org, ctx.correlationId);
    if (!state.verified.length) throw new ApiError(409, 'sso_rule', 'Verify at least one email domain first: single sign-on is offered to people at your verified domains.');
    const kept = 'metadataUrl' in metadata ? { url: metadata.metadataUrl, sha: null } : { url: null, sha: createHash('sha256').update(metadata.metadataXml).digest('hex') };
    const record = await this.callAdmin(() =>
      state.supabaseId ? this.admin.update(state.supabaseId, { metadata, domains: state.verified }) : this.admin.create(metadata, state.verified),
    );
    try {
      await this.database.asApi(
        (c) =>
          c.query(`select app.system_sso_save_provider($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::text[])`, [
            org, ctx.user.id, record.id, record.entityId, kept.url, kept.sha, state.verified,
          ]),
        ctx.correlationId,
        'sso',
      );
    } catch (e) {
      // Recorded nowhere: take a newly made provider back out of Supabase so the two never disagree.
      if (!state.supabaseId) await this.admin.remove(record.id).catch(() => undefined);
      throw e;
    }
    return this.overview(ctx);
  }

  /**
   * Off / optional / required (SS6). The database refuses required unless this request came through the organisation's own provider, so the
   * person switching has shown the company sign-in works.
   */
  setMode(ctx: RequestContext, mode: 'off' | 'optional' | 'required') {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.set_sso_mode(${orgOf(ctx)}::uuid, ${mode})`);
      return this.load(db, ctx);
    });
  }

  /** Whether a company sign-in meets the organisation's two-factor rule (SS7). */
  setTrustIdpMfa(ctx: RequestContext, trust: boolean) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.set_sso_trust_idp_mfa(${orgOf(ctx)}::uuid, ${trust})`);
      return this.load(db, ctx);
    });
  }

  /** The break-glass members, replaced as a whole (SS8): up to three owners or admins who may use a password and two-factor. */
  setBreakGlass(ctx: RequestContext, userIds: string[]) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.set_sso_break_glass(${orgOf(ctx)}::uuid, ${`{${userIds.join(',')}}`}::uuid[])`);
      return this.load(db, ctx);
    });
  }

  /** Switches single sign-on off: the provider leaves Supabase (its domains are free again) and is kept here as disabled, with the reason. */
  async disableProvider(ctx: RequestContext, reason: string) {
    this.requireAdmin();
    const state = await this.state(orgOf(ctx), ctx.correlationId);
    if (!state.providerId || !state.supabaseId) throw new ApiError(409, 'sso_rule', 'Single sign-on is not connected');
    // Checked before Supabase is touched (the database refuses it again): people sign in through it while single sign-on is in use.
    if (state.mode !== 'off') throw new ApiError(409, 'sso_rule', "Switch single sign-on off before disconnecting your company's sign-in");
    await this.callAdmin(() => this.admin.remove(state.supabaseId!));
    await this.database.asApi(
      (c) => c.query(`select app.system_sso_disable_provider($1::uuid, $2::uuid, $3)`, [state.providerId, ctx.user.id, reason]),
      ctx.correlationId,
      'sso',
    );
    return this.overview(ctx);
  }

  /** Sends the verified domains to Supabase when they differ from what it holds. A failure is recorded on the provider, never thrown. */
  async syncProviderDomains(organisationId: string, correlationId: string) {
    const state = await this.state(organisationId, correlationId);
    if (!state.providerId || !state.supabaseId || !this.admin.enabled) return;
    const same = state.domains.length === state.verified.length && state.domains.every((d, i) => d === state.verified[i]);
    if (same && !state.lastError) return;
    let error: string | null = null;
    try {
      await this.admin.update(state.supabaseId, { domains: state.verified });
    } catch (e) {
      error = (e as Error).message;
      this.log.warn(`SSO domains for ${organisationId} not sent to Supabase: ${error}`);
    }
    await this.database.asApi(
      (c) => c.query(`select app.system_sso_provider_synced($1::uuid, $2::text[], $3)`, [state.providerId, state.verified, error]),
      correlationId,
      'sso',
    );
  }

  private requireAdmin() {
    if (!this.admin.enabled) throw new ApiError(503, 'sso_unavailable', 'Single sign-on cannot be set up yet: Fortress has not been given access to manage sign-in providers.');
  }

  private async callAdmin<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if (e instanceof SsoAdminRefused) throw new ApiError(409, 'sso_rule', `Supabase did not accept it: ${e.message}`);
      if (e instanceof SsoAdminUnavailable) throw new ApiError(503, 'sso_unavailable', 'The sign-in service could not be reached. Try again in a few minutes.');
      throw e;
    }
  }

  private async state(organisationId: string, correlationId: string) {
    const row = await this.database.asApi(
      async (c) =>
        (
          await c.query(
            `select st.provider_id, st.supabase_provider_id, st.domains, st.verified, st.last_error, (select m.mode from app.system_sso_mode($1::uuid) m) as mode
               from app.system_sso_provider_state($1::uuid) st`,
            [organisationId],
          )
        ).rows[0] as Row,
      correlationId,
      'sso',
    );
    return {
      providerId: (row?.provider_id as string) ?? null,
      supabaseId: (row?.supabase_provider_id as string) ?? null,
      domains: ((row?.domains as string[]) ?? []).slice().sort(),
      verified: ((row?.verified as string[]) ?? []).slice().sort(),
      lastError: (row?.last_error as string) ?? null,
      mode: ((row?.mode as string) ?? 'off') as 'off' | 'optional' | 'required',
    };
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
    if (state === 'verified') await this.syncProviderDomains(orgOf(ctx), ctx.correlationId);
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
        select s.sso_mode, s.sso_join, s.sso_trust_idp_mfa, s.allowed_email_domains, s.require_mfa, s.max_session_hours, s.sso_mode_changed_at,
               nullif(btrim(concat_ws(' ', mp.first_name, mp.surname)), '') as sso_mode_changed_by,
               app.has_permission(${org}::uuid, 'security.manage') as can_manage,
               app.sso_session_for(${org}::uuid) as via_sso, app.session_aal() as aal
          from public.organisation_settings s
          left join public.profiles mp on mp.id = s.sso_mode_changed_by
         where s.organisation_id = ${org}::uuid`)
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
    const providers = await db.execute<Row>(sql`
      select p.id, p.supabase_provider_id, p.entity_id, p.metadata_url, p.metadata_sha256, p.status, p.domains, p.last_synced_at, p.last_error,
             p.created_at, p.disabled_at, p.disabled_reason,
             nullif(btrim(concat_ws(' ', cp.first_name, cp.surname)), '') as created_by,
             nullif(btrim(concat_ws(' ', up.first_name, up.surname)), '') as updated_by,
             nullif(btrim(concat_ws(' ', dp.first_name, dp.surname)), '') as disabled_by
        from public.organisation_sso_providers p
        left join public.profiles cp on cp.id = p.created_by
        left join public.profiles up on up.id = p.updated_by
        left join public.profiles dp on dp.id = p.disabled_by
       where p.organisation_id = ${org}::uuid
       order by p.status = 'active' desc, p.created_at desc
       limit 6`);
    const providerOf = (p: Row) => ({
      id: p.id as string,
      /** The id Supabase knows it by: "Test sign-in" starts a sign-in with it. */
      supabaseProviderId: p.supabase_provider_id as string,
      status: p.status as 'active' | 'disabled',
      entityId: (p.entity_id as string) ?? null,
      metadataUrl: (p.metadata_url as string) ?? null,
      metadataKind: (p.metadata_url ? 'url' : 'xml') as 'url' | 'xml',
      domains: (p.domains as string[]) ?? [],
      lastSyncedAt: iso(p.last_synced_at),
      lastError: (p.last_error as string) ?? null,
      createdAt: iso(p.created_at)!,
      createdBy: (p.created_by as string) ?? null,
      updatedBy: (p.updated_by as string) ?? null,
      disabledAt: iso(p.disabled_at),
      disabledBy: (p.disabled_by as string) ?? null,
      disabledReason: (p.disabled_reason as string) ?? null,
    });
    const active = providers.rows.find((p) => p.status === 'active');
    // Password members (owners and admins among them can be break-glass); SSO users have no password, so they never can.
    const people = await db.execute<Row>(sql`select user_id, name, email, break_glass, owner_or_admin from app.sso_password_members(${org}::uuid)`);
    const glass = await db.execute<Row>(sql`
      select b.user_id, b.added_at from public.sso_break_glass_members b
       where b.organisation_id = ${org}::uuid and b.ended_at is null order by b.added_at`);
    const person = new Map(people.rows.map((p) => [p.user_id as string, p]));
    const signIns = await db.execute<Row>(sql`
      select i.user_id, i.method, sum(i.count)::int as requests, max(i.last_at) as last_at, min(i.first_at) as first_at
        from public.sso_sign_ins i where i.organisation_id = ${org}::uuid and i.hour > now() - interval '30 days'
       group by i.user_id, i.method order by max(i.last_at) desc limit 50`);
    const names = new Map(people.rows.map((p) => [p.user_id as string, (p.name as string) ?? (p.email as string)]));
    const changes = await db.execute<Row>(sql`
      select c.id, c.kind, c.from_value, c.to_value, c.user_name, c.reason, c.summary, c.created_at
        from public.sso_changes c where c.organisation_id = ${org}::uuid order by c.created_at desc limit 20`);
    const mode = ((s.sso_mode as string) ?? 'off') as 'off' | 'optional' | 'required';
    const storedHours = s.max_session_hours == null ? null : Number(s.max_session_hours);
    return {
      /** Whether this server can register providers with Supabase (SUPABASE_MANAGEMENT_TOKEN set). */
      available: this.admin.enabled,
      /** What the company's IT enters for Fortress. */
      serviceProvider: serviceProviderValues(this.env.SUPABASE_URL),
      provider: active ? providerOf(active) : null,
      previousProviders: providers.rows.filter((p) => p.status !== 'active').map(providerOf),
      mode,
      modeChangedAt: iso(s.sso_mode_changed_at),
      modeChangedBy: (s.sso_mode_changed_by as string) ?? null,
      /** How this request signed in: through the organisation's own provider (needed to switch to required) and its two-factor level. */
      session: { viaSso: Boolean(s.via_sso), aal: (s.aal as string) === 'aal2' ? 'aal2' : 'aal1' },
      requireMfa: Boolean(s.require_mfa),
      /** The session limit applied: the stored one, else 12 hours while required (SS9). */
      sessionHours: { stored: storedHours, effective: storedHours ?? (mode === 'required' ? 12 : null) },
      breakGlass: glass.rows.map((b) => ({
        userId: b.user_id as string,
        name: (person.get(b.user_id as string)?.name as string) ?? null,
        email: (person.get(b.user_id as string)?.email as string) ?? null,
        addedAt: iso(b.added_at)!,
      })),
      /** Members who sign in with a password: blocked while required unless they are break-glass. Owners and admins among them can be break-glass. */
      passwordMembers: people.rows.map((p) => ({
        userId: p.user_id as string,
        name: (p.name as string) ?? null,
        email: (p.email as string) ?? null,
        breakGlass: Boolean(p.break_glass),
        ownerOrAdmin: Boolean(p.owner_or_admin),
      })),
      signIns: signIns.rows.map((i) => ({
        userId: i.user_id as string,
        name: names.get(i.user_id as string) ?? null,
        method: i.method as 'sso' | 'break_glass',
        requests: Number(i.requests),
        firstAt: iso(i.first_at)!,
        lastAt: iso(i.last_at)!,
      })),
      changes: changes.rows.map((c) => ({
        id: c.id as string,
        kind: c.kind as 'mode' | 'two_factor' | 'break_glass_list' | 'break_glass_used' | 'recovery',
        from: (c.from_value as string) ?? null,
        to: (c.to_value as string) ?? null,
        by: (c.user_name as string) ?? null,
        reason: (c.reason as string) ?? null,
        summary: c.summary as string,
        at: iso(c.created_at)!,
      })),
      join: ((s.sso_join as string) ?? 'invited') as 'invited' | 'domain',
      trustIdpMfa: s.sso_trust_idp_mfa !== false,
      canManage: Boolean(s.can_manage),
      /** Invitations only to these (SE6); an SSO domain must be one of them, or a sub-domain of one, while the list is set. */
      allowedEmailDomains: (s.allowed_email_domains as string[]) ?? [],
      domains,
    };
  }
}
