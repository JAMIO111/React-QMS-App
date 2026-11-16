import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { PasswordCheckUnavailable, PasswordVerifier } from '../sso/password-verifier';
import { DatabaseService, Db } from '../database/database.service';
import { profiles } from '../database/schema';
import type { MeResponse, UpdateMeBody } from './me.schemas';

@Injectable()
export class MeService {
  constructor(
    private readonly database: DatabaseService,
    private readonly passwords: PasswordVerifier,
  ) {}

  /** Joins an organisation that lets people at its domains join with their company account (docs/sso-plan.md SS4). */
  joinWithCompanyAccount(ctx: RequestContext, organisationId: string): Promise<MeResponse> {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.join_by_company_sign_in(${organisationId}::uuid)`);
      return this.load(db, ctx);
    });
  }

  /**
   * Moves the person's old password account onto the company account they are signed in with (SS5): they prove the old account with its password,
   * checked against Supabase Auth; the database then moves the membership and the open work.
   */
  async moveOwnAccount(ctx: RequestContext, organisationId: string, password: string): Promise<MeResponse> {
    const email = ctx.user.email;
    if (!email) throw new ApiError(409, 'sso_rule', 'Your company account has no email address');
    const candidate = await this.database.asUser(ctx, async (db) => {
      const r = await db.execute<{ password_user_id: string }>(
        sql`select password_user_id from app.my_sso_move_candidates() where organisation_id = ${organisationId}::uuid`,
      );
      return r.rows[0]?.password_user_id ?? null;
    });
    if (!candidate) throw new ApiError(409, 'sso_rule', 'There is no password account of yours to move in that organisation');
    let checked: string | null;
    try {
      checked = await this.passwords.verify(email, password);
    } catch (e) {
      if (e instanceof PasswordCheckUnavailable) throw new ApiError(503, 'password_check_unavailable', 'Your old password cannot be checked on this server. Ask an administrator to move your account.');
      throw e;
    }
    if (!checked || checked !== candidate) throw new ApiError(409, 'sso_rule', 'That is not the password of your old account');
    await this.database.asApi(
      (c) => c.query('select app.system_move_own_account($1::uuid, $2::uuid, $3::uuid)', [organisationId, candidate, ctx.user.id]),
      ctx.correlationId,
      'sso',
    );
    return this.get(ctx);
  }

  get(ctx: RequestContext): Promise<MeResponse> {
    return this.database.asUser(ctx, (db) => this.load(db, ctx));
  }

  update(ctx: RequestContext, body: UpdateMeBody): Promise<MeResponse> {
    return this.database.asUser(ctx, async (db) => {
      await db
        .update(profiles)
        .set({
          ...(body.firstName !== undefined ? { firstName: body.firstName } : {}),
          ...(body.surname !== undefined ? { surname: body.surname } : {}),
          ...(body.jobTitle !== undefined ? { jobTitle: body.jobTitle || null } : {}),
        })
        .where(eq(profiles.id, ctx.user.id));
      return this.load(db, ctx);
    });
  }

  /** Records that the person accepted this version of the terms (SS2: a first company sign-in never saw our sign-up form). */
  acceptTerms(ctx: RequestContext, version: string): Promise<MeResponse> {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.accept_terms(${version})`);
      return this.load(db, ctx);
    });
  }

  private async load(db: Db, ctx: RequestContext): Promise<MeResponse> {
    const [profile] = await db.select().from(profiles).where(eq(profiles.id, ctx.user.id));
    const memberships = await db.execute<{
      membership_id: string;
      organisation_id: string;
      name: string;
      slug: string;
      permissions: string[] | null;
      access_state: string | null;
      onboarding: string;
      network: string | null;
    }>(sql`
      select m.id as membership_id, o.id as organisation_id, o.name, o.slug,
             array(select p from app.my_visible_permissions(o.id) p order by p) as permissions,
             app.organisation_access_state(o.id) as access_state,
             case when o.onboarding_completed_at is not null then 'complete'
                  when exists (select 1 from public.organisation_onboarding w where w.organisation_id = o.id) then 'in_progress'
                  else 'none' end as onboarding,
             app.network_allowed(o.id, ${ctx.address ?? null}::inet) as network
      from public.organisation_users m
      join public.organisations o on o.id = m.organisation_id and o.status = 'active'
      where m.user_id = auth.uid() and m.status = 'active'
      order by o.name`);
    // Organisations requiring MFA are left out of `memberships` (RLS hides them from an aal1
    // session); list them so the app can ask the user to set up or confirm two-factor.
    const blocked = await db.execute<{ organisation_id: string; name: string }>(
      sql`select organisation_id, name from app.mfa_blocked_organisations()`,
    );
    // Organisations that require their company sign-in, which this session did not use (docs/sso-plan.md SS6): left out of `memberships`
    // too, and listed so the app can offer the right sign-in (or, for a break-glass member, two-factor).
    const ssoBlocked = await db.execute<{ organisation_id: string; name: string; provider_id: string | null; break_glass: boolean }>(
      sql`select organisation_id, name, provider_id, break_glass from app.sso_blocked_organisations()`,
    );
    const blockedIds = new Set([...blocked.rows, ...ssoBlocked.rows].map((b) => b.organisation_id));
    // Organisations this company sign-in may join by itself, and password accounts of the same person waiting to be moved across (SS4, SS5).
    const joinable = await db.execute<{ organisation_id: string; name: string; role_name: string }>(
      sql`select organisation_id, name, role_name from app.sso_joinable_organisations()`,
    );
    const moves = await db.execute<{ organisation_id: string; name: string }>(sql`select organisation_id, name from app.my_sso_move_candidates()`);

    return {
      profile: {
        id: ctx.user.id,
        email: ctx.user.email ?? null,
        firstName: profile?.firstName ?? null,
        surname: profile?.surname ?? null,
        jobTitle: profile?.jobTitle ?? null,
        avatarPath: profile?.avatarPath ?? null,
        termsAcceptedAt: profile?.termsAcceptedAt ? new Date(profile.termsAcceptedAt).toISOString() : null,
        termsVersion: profile?.termsVersion ?? null,
      },
      mfa: {
        level: ctx.user.claims.aal === 'aal2' ? 'aal2' : 'aal1',
        requiredBy: blocked.rows.map((b) => ({ id: b.organisation_id, name: b.name })),
      },
      sso: {
        requiredBy: ssoBlocked.rows.map((b) => ({ id: b.organisation_id, name: b.name, providerId: b.provider_id ?? null, breakGlass: Boolean(b.break_glass) })),
        joinable: joinable.rows.map((j) => ({ id: j.organisation_id, name: j.name, roleName: j.role_name })),
        moveCandidates: moves.rows.map((m) => ({ id: m.organisation_id, name: m.name })),
      },
      memberships: memberships.rows.filter((m) => !blockedIds.has(m.organisation_id)).map((m) => ({
        membershipId: m.membership_id,
        organisation: { id: m.organisation_id, name: m.name, slug: m.slug },
        accessState: (m.access_state ?? 'open') as 'open' | 'needs_subscription' | 'lapsed',
        onboarding: m.onboarding as 'none' | 'in_progress' | 'complete',
        permissions: m.permissions ?? [],
        network: { state: (m.network ?? 'open') as 'open' | 'allowed' | 'monitored' | 'denied', address: ctx.address ?? null },
      })),
    };
  }
}
