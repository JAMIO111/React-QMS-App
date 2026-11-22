import { applyDecorators, CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiHeader, ApiResponse } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import { ApiRequest, contextFrom, PortalAccess } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { hoursWords, sessionTooOld } from '../tenancy/organisation.guard';

const SCOPE = 'qms:portal-scope';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Scope {
  /** Only an admin of the party (who may invite and remove their own colleagues). */
  admin?: boolean;
}

/**
 * The route is for an external person (a supplier's or customer's contact) acting for one party in the organisation named by X-Organisation-Id
 * (docs/external-portal-plan.md). They must hold live access there (otherwise 404, so other organisations' ids are not confirmed). **This is the
 * only place the organisation's network allow-list, "company sign-in required" and seat rules are not applied** — they are about the organisation's
 * own people; external people are never members. Two-factor (the portal's own setting) and the maximum session age are checked here.
 */
export const PortalScoped = (options: Scope = {}) =>
  applyDecorators(
    SetMetadata(SCOPE, options satisfies Scope),
    ApiHeader({ name: 'X-Organisation-Id', required: true, description: 'Organisation whose portal to use (UUID)' }),
    ApiResponse({ status: 404, description: 'No portal access in that organisation' }),
    ...(options.admin ? [ApiResponse({ status: 403, description: 'Requires being an admin of the supplier or customer' })] : []),
  );

@Injectable()
export class PortalGuard implements CanActivate {
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
    if (!UUID.test(organisationId)) throw ApiError.badRequest('invalid_organisation_id', 'X-Organisation-Id must be a UUID');

    const ctx = contextFrom(req);
    const row = await this.db.asUser(ctx, async (db) => {
      const result = await db.execute<{
        access_id: string;
        party_id: string;
        party_kind: 'supplier' | 'customer';
        supplier_id: string | null;
        customer_id: string | null;
        role: 'admin' | 'member';
        mfa_blocked: boolean;
        max_session_hours: number | null;
      }>(
        sql`select a.access_id, a.party_id, a.party_kind, a.supplier_id, a.customer_id, a.role,
                   app.portal_mfa_blocked(${organisationId}::uuid) as mfa_blocked,
                   app.portal_max_session_hours(${organisationId}::uuid) as max_session_hours
              from app.portal_my_access(${organisationId}::uuid) a
             limit 1`,
      );
      const found = result.rows[0];
      // The person's own last sign-in for the access report (at most once an hour; the database decides).
      if (found) await db.execute(sql`select app.portal_record_sign_in(${organisationId}::uuid)`);
      return found;
    });
    if (!row) throw ApiError.notFound('organisation_not_found', 'Organisation not found');
    if (row.mfa_blocked) throw new ApiError(403, 'mfa_required', 'This organisation requires two-factor authentication');
    if (row.max_session_hours != null && sessionTooOld(ctx.user.claims as Record<string, unknown>, Number(row.max_session_hours))) {
      throw new ApiError(401, 'reauthentication_required', `This organisation asks you to sign in again every ${hoursWords(Number(row.max_session_hours))}. Please sign in again.`, {
        maxSessionHours: Number(row.max_session_hours),
      });
    }
    if (scope.admin && row.role !== 'admin') throw ApiError.forbidden(undefined, { permission: 'party admin' });
    const portal: PortalAccess = {
      accessId: row.access_id,
      partyId: row.party_id,
      partyKind: row.party_kind,
      supplierId: row.supplier_id,
      customerId: row.customer_id,
      role: row.role,
    };
    req.organisationId = organisationId.toLowerCase();
    req.portal = portal;
    return true;
  }
}
