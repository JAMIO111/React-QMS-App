import { applyDecorators, CanActivate, ExecutionContext, Injectable, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiHeader, ApiResponse } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import { ApiRequest, contextFrom } from '../common/request-context';
import { DatabaseService } from '../database/database.service';

const SCOPE = 'qms:organisation-scope';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Scope {
  permission?: string;
  /** Admit users who hold the permission for any site or department; RLS filters the rows by site. */
  anyScope?: boolean;
}

/**
 * The route works inside one organisation, named by the X-Organisation-Id header. The caller must be
 * an active member (otherwise 404, so other tenants' ids are not confirmed) and, if given, hold the
 * permission organisation-wide (otherwise 403). RLS enforces the same rules again in the database.
 */
export const OrganisationScoped = (permission?: string, options: { anyScope?: boolean } = {}) =>
  applyDecorators(
    SetMetadata(SCOPE, { permission, anyScope: options.anyScope } satisfies Scope),
    ApiHeader({ name: 'X-Organisation-Id', required: true, description: 'Organisation to act in (UUID)' }),
    ApiResponse({ status: 404, description: 'Not a member of that organisation' }),
    ...(permission ? [ApiResponse({ status: 403, description: `Requires permission ${permission}` })] : []),
  );

/**
 * When the person last signed in, from the token's amr claim (Supabase lists each method with its time; a later sign-in or second factor is the
 * newest). Seconds since 1970, or null when the token says nothing about it.
 */
export function signedInAt(claims: Record<string, unknown>): number | null {
  const amr = claims.amr;
  if (!Array.isArray(amr)) return null;
  const times = amr.map((m) => (m && typeof m === 'object' ? Number((m as { timestamp?: unknown }).timestamp) : NaN)).filter((t) => Number.isFinite(t) && t > 0);
  return times.length ? Math.max(...times) : null;
}

/** True when the session is older than the limit, or when its sign-in time cannot be known (then the person signs in again). */
export function sessionTooOld(claims: Record<string, unknown>, maxHours: number, nowSeconds = Date.now() / 1000): boolean {
  const at = signedInAt(claims);
  return at == null || nowSeconds - at > maxHours * 3600;
}

export const hoursWords = (h: number) => (h % 24 === 0 ? `${h / 24} day${h === 24 ? '' : 's'}` : `${h} hour${h === 1 ? '' : 's'}`);

@Injectable()
export class OrganisationGuard implements CanActivate {
  private readonly log = new Logger(OrganisationGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly db: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const scope = this.reflector.getAllAndOverride<Scope | undefined>(SCOPE, [context.getHandler(), context.getClass()]);
    if (!scope) return true;

    const req = context.switchToHttp().getRequest<ApiRequest>();
    const raw = req.headers['x-organisation-id'];
    const organisationId = Array.isArray(raw) ? raw[0] : raw;
    if (!organisationId) throw ApiError.badRequest('organisation_required', 'X-Organisation-Id header is required');
    if (!UUID.test(organisationId)) {
      throw ApiError.badRequest('invalid_organisation_id', 'X-Organisation-Id must be a UUID');
    }

    const ctx = contextFrom(req);
    const { member, allowed, mfa_blocked, sso_provider, sso_blocked, sso_break_glass, sso_method, network, max_session_hours } = await this.db.asUser(ctx, async (db) => {
      const result = await db.execute<{
        member: boolean;
        allowed: boolean;
        mfa_blocked: boolean;
        sso_blocked: boolean;
        sso_provider: string | null;
        sso_break_glass: boolean | null;
        sso_method: 'sso' | 'break_glass' | null;
        network: string | null;
        max_session_hours: number | null;
      }>(
        sql`select app.is_member(${organisationId}::uuid) as member,
                   (${scope.permission ?? null}::text is null
                    or case when ${scope.anyScope ?? false}::boolean
                            then app.has_permission_somewhere(${organisationId}::uuid, ${scope.permission ?? null}::text)
                            else app.has_permission(${organisationId}::uuid, ${scope.permission ?? null}::text) end) as allowed,
                   exists (select 1 from app.mfa_blocked_organisations() b
                           where b.organisation_id = ${organisationId}::uuid) as mfa_blocked,
                   sb.organisation_id is not null as sso_blocked, sb.provider_id as sso_provider, sb.break_glass as sso_break_glass,
                   app.sso_session_method(${organisationId}::uuid) as sso_method,
                   app.network_allowed(${organisationId}::uuid, ${ctx.address ?? null}::inet) as network,
                   app.max_session_hours(${organisationId}::uuid) as max_session_hours
              from (select 1) one
              left join app.sso_blocked_organisations() sb on sb.organisation_id = ${organisationId}::uuid`,
      );
      return result.rows[0];
    });

    // An organisation that requires its company sign-in, which this session did not use (docs/sso-plan.md SS6). Checked before two-factor:
    // signing in through the company may meet the two-factor rule too. Only the caller's own memberships are reported.
    if (sso_blocked) {
      throw new ApiError(
        403,
        'sso_required',
        sso_break_glass
          ? 'This organisation requires its company sign-in. As a break-glass member you can also sign in with your password and two-factor authentication.'
          : 'This organisation requires you to sign in with your company account.',
        { providerId: sso_provider ?? null, breakGlass: Boolean(sso_break_glass) },
      );
    }
    // A member whose session has not passed MFA, in an organisation that requires it. Only the
    // caller's own memberships are reported, so this does not reveal other tenants.
    if (mfa_blocked) throw new ApiError(403, 'mfa_required', 'This organisation requires two-factor authentication');
    if (!member) throw ApiError.notFound('organisation_not_found', 'Organisation not found');
    // The organisation's network rule (docs/security-plan.md S1): checked on every request, in the same query, so a change applies at once.
    if (network === 'denied' || network === 'monitored') {
      await this.recordDenial(organisationId, ctx.user.id, ctx.address ?? null, network === 'denied' ? 'enforce' : 'monitor', req.originalUrl ?? req.url, ctx.correlationId);
      if (network === 'denied') {
        throw new ApiError(403, 'network_not_allowed', 'This organisation does not allow access from your network. Connect through your company network or VPN, or ask an administrator.', {
          address: ctx.address ?? null,
        });
      }
    }
    // The organisation's maximum session age (docs/security-plan.md S11): sign in again after N hours, counted from the sign-in in the token.
    if (max_session_hours != null && sessionTooOld(ctx.user.claims as Record<string, unknown>, Number(max_session_hours))) {
      throw new ApiError(401, 'reauthentication_required', `This organisation asks you to sign in again every ${hoursWords(Number(max_session_hours))}. Please sign in again.`, {
        maxSessionHours: Number(max_session_hours),
      });
    }
    if (!allowed) throw ApiError.forbidden(undefined, { permission: scope.permission });
    if (sso_method) await this.recordSignIn(organisationId.toLowerCase(), ctx.user.id, sso_method, ctx.correlationId);
    req.organisationId = organisationId.toLowerCase();
    return true;
  }

  /** Hours already recorded by this process, so a busy session writes once an hour, not on every request. */
  private readonly signInsSeen = new Set<string>();

  /**
   * Records a request made through the company sign-in or break-glass (one row per person, method and hour; the first break-glass use of an hour
   * is told to owners and admins by the database). Never lets a failure to record change the answer.
   */
  private async recordSignIn(organisationId: string, userId: string, method: 'sso' | 'break_glass', correlationId: string) {
    const hour = Math.floor(Date.now() / 3_600_000);
    const key = `${organisationId}:${userId}:${method}:${hour}`;
    if (this.signInsSeen.has(key)) return;
    try {
      await this.db.asApi((c) => c.query('select app.system_record_sso_sign_in($1::uuid, $2::uuid, $3)', [organisationId, userId, method]), correlationId, 'security');
      if (this.signInsSeen.size > 10_000) this.signInsSeen.clear();
      this.signInsSeen.add(key);
    } catch (e) {
      this.log.warn(`Could not record a ${method} sign-in: ${(e as Error).message}`);
    }
  }

  /** Records a blocked (or, in monitor mode, would-be blocked) request on the API login. Never lets a failure to record change the answer. */
  private async recordDenial(organisationId: string, userId: string, address: string | null, mode: 'enforce' | 'monitor', path: string, correlationId: string) {
    try {
      await this.db.asApi(
        (c) => c.query('select app.system_record_access_denial($1::uuid, $2::uuid, $3, $4, $5)', [organisationId, userId, address ?? 'unknown', mode, path]),
        correlationId,
        'security',
      );
    } catch (e) {
      this.log.warn(`Could not record a ${mode} network denial: ${(e as Error).message}`);
    }
  }
}
