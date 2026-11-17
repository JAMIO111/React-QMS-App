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

  /** A member's own set-up after joining (docs/seats-and-member-onboarding-plan.md SM6): about you, how we reach you, done. Allowed while waiting for a seat. */
  setWelcomeStep(ctx: RequestContext, organisationId: string, step: 'about' | 'notifications' | 'done'): Promise<MeResponse> {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.set_member_onboarding_step(${organisationId}::uuid, ${step})`);
      return this.load(db, ctx);
    });
  }

  /** Waiting for a seat: tells the people who give seats again (docs/seats-and-member-onboarding-plan.md SM4); once a day, else 409 subscription_rule. */
  remindSeatManagers(ctx: RequestContext, organisationId: string): Promise<MeResponse> {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.remind_seat_managers(${organisationId}::uuid)`);
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
    // Organisations that enforce packages, where this person is waiting for a seat (docs/seats-and-member-onboarding-plan.md SM3): left out
    // of `memberships` too (they are not a member until given one), and listed with who can give a seat for the waiting screen.
    const seatBlocked = await db.execute<{ organisation_id: string; name: string; wait: { managers?: string[]; lastToldAt?: string | null } | null }>(
      sql`select b.organisation_id, b.name, app.my_seat_wait(b.organisation_id) as wait from app.seat_blocked_organisations() b`,
    );
    const welcome = await db.execute<{ organisation_id: string; name: string; about_done: boolean; notifications_done: boolean; waiting_for_seat: boolean }>(
      sql`select organisation_id, name, about_done, notifications_done, waiting_for_seat from app.my_pending_welcomes()`,
    );
    // Organisations the person was suspended from (they are not members while suspended): who did it and when, for the "you have been suspended" screen.
    const suspended = await db.execute<{ organisation_id: string; name: string; suspended_at: string | Date | null; suspended_by_name: string | null }>(
      sql`select organisation_id, name, suspended_at, suspended_by_name from app.my_suspensions()`,
    );
    const blockedIds = new Set([...blocked.rows, ...ssoBlocked.rows, ...seatBlocked.rows].map((b) => b.organisation_id));
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
      suspended: suspended.rows.map((s) => ({
        id: s.organisation_id,
        name: s.name,
        suspendedAt: s.suspended_at ? new Date(s.suspended_at).toISOString() : null,
        suspendedBy: s.suspended_by_name ?? null,
      })),
      welcome: welcome.rows.map((w) => ({
        id: w.organisation_id,
        name: w.name,
        aboutDone: Boolean(w.about_done),
        notificationsDone: Boolean(w.notifications_done),
        waitingForSeat: Boolean(w.waiting_for_seat),
      })),
      seats: {
        waitingIn: seatBlocked.rows.map((b) => ({
          id: b.organisation_id,
          name: b.name,
          managers: b.wait?.managers ?? [],
          lastToldAt: b.wait?.lastToldAt ? new Date(b.wait.lastToldAt).toISOString() : null,
        })),
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
