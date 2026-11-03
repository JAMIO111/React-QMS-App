import { applyDecorators, CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
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
}

/**
 * The route works inside one organisation, named by the X-Organisation-Id header. The caller must be
 * an active member (otherwise 404, so other tenants' ids are not confirmed) and, if given, hold the
 * permission organisation-wide (otherwise 403). RLS enforces the same rules again in the database.
 */
export const OrganisationScoped = (permission?: string) =>
  applyDecorators(
    SetMetadata(SCOPE, { permission } satisfies Scope),
    ApiHeader({ name: 'X-Organisation-Id', required: true, description: 'Organisation to act in (UUID)' }),
    ApiResponse({ status: 404, description: 'Not a member of that organisation' }),
    ...(permission ? [ApiResponse({ status: 403, description: `Requires permission ${permission}` })] : []),
  );

@Injectable()
export class OrganisationGuard implements CanActivate {
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

    const { member, allowed } = await this.db.asUser(contextFrom(req), async (db) => {
      const result = await db.execute<{ member: boolean; allowed: boolean }>(
        sql`select app.is_member(${organisationId}::uuid) as member,
                   (${scope.permission ?? null}::text is null
                    or app.has_permission(${organisationId}::uuid, ${scope.permission ?? null}::text)) as allowed`,
      );
      return result.rows[0];
    });

    if (!member) throw ApiError.notFound('organisation_not_found', 'Organisation not found');
    if (!allowed) throw ApiError.forbidden(undefined, { permission: scope.permission });
    req.organisationId = organisationId.toLowerCase();
    return true;
  }
}
