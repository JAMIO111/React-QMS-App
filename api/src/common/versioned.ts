import { CallHandler, ExecutionContext, HttpStatus, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import { Observable, catchError, from, mergeMap, throwError } from 'rxjs';
import { DatabaseService } from '../database/database.service';
import { ApiError } from './api-error';
import { ApiRequest, contextFrom } from './request-context';

/**
 * Edit conflicts (docs/edit-conflicts-plan.md EC2). A record's GET and PATCH/PUT handlers carry @Versioned('<table>'):
 *
 *  - the answer gets `rowVersion` (the record's updated_at to the microsecond, app.row_version) when it is the record named by the route's :id
 *    (not `version`: audits, workflow rules and part revisions already use that name for their own numbering);
 *  - a save may say which version it was based on, as `rowVersion` in the body (removed before the body is checked, so strict schemas
 *    are unchanged) or as an If-Match header; the API puts it in the request context and DatabaseService.asUser hands it to the database, whose touch_updated
 *    refuses the update when the record changed since (QM031);
 *  - a refused save answers 409 edit_conflict with what changed since that version: { version, changedAt, changedBy, fields, people }, the
 *    fields named as the API names them (camel case).
 *
 * A save without a version behaves as before: the last save wins.
 */
export const VERSIONED = 'qms:versioned';
export const Versioned = (table: string) => SetMetadata(VERSIONED, table);

const VERSION_PATTERN = /^[0-9]{1,20}$/;
const MUTATING = new Set(['PATCH', 'PUT', 'POST']);

/** The version a save says it was based on: If-Match ("…", W/"…") or body.rowVersion; null when absent or malformed. Removes it from the body. */
export function takeExpectedVersion(req: { headers: Record<string, unknown>; body?: unknown }): string | null {
  let version: string | null = null;
  const body = req.body;
  if (body && typeof body === 'object' && !Array.isArray(body) && 'rowVersion' in body) {
    const v = (body as Record<string, unknown>).rowVersion;
    delete (body as Record<string, unknown>).rowVersion;
    if (typeof v === 'string' && VERSION_PATTERN.test(v)) version = v;
  }
  const raw = req.headers['if-match'];
  const header = (Array.isArray(raw) ? raw[0] : raw) as string | undefined;
  if (!version && typeof header === 'string') {
    const v = header.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
    if (VERSION_PATTERN.test(v)) version = v;
  }
  return version;
}

/** Database column → the API's field name: snake_case to camelCase, with the few names the API spells differently. */
const FIELD_NAMES: Record<string, string> = {
  owner_user_id: 'ownerId',
  detection_process_id: 'detectionProcessId',
  causal_process_id: 'causalProcessId',
};
export const apiFieldName = (column: string) => FIELD_NAMES[column] ?? column.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

interface ConflictDetails {
  version: string;
  changedAt: string | null;
  changedBy: { id: string; name: string | null } | null;
  fields: string[];
  people: Array<{ id: string; name: string | null }>;
}

const isConflict = (error: unknown) => {
  if (error instanceof ApiError) return error.code === 'edit_conflict';
  const candidates = [error, (error as { cause?: unknown })?.cause];
  return candidates.some((c) => c && typeof c === 'object' && (c as { code?: string }).code === 'QM031');
};

@Injectable()
export class VersionInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly database: DatabaseService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const table = this.reflector.get<string | undefined>(VERSIONED, context.getHandler());
    if (!table || context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<ApiRequest & { params: Record<string, string> }>();
    const res = context.switchToHttp().getResponse<{ setHeader: (k: string, v: string) => void; headersSent?: boolean }>();
    const id = req.params?.id;
    if (!id || !req.user) return next.handle();

    const expected = MUTATING.has(req.method) ? takeExpectedVersion(req as never) : null;
    if (expected) req.expectedVersions = { [`${table}:${id}`]: expected };

    return next.handle().pipe(
      mergeMap((body) => from(this.attachVersion(req, res, table, id, body))),
      catchError((error) => (expected && isConflict(error) ? from(this.conflict(req, table, id, expected)).pipe(mergeMap((e) => throwError(() => e))) : throwError(() => error))),
    );
  }

  /** Adds the record's current version to an answer that is the record itself (and as an ETag either way). */
  private async attachVersion(req: ApiRequest, res: { setHeader: (k: string, v: string) => void; headersSent?: boolean }, table: string, id: string, body: unknown) {
    const ctx = { ...contextFrom(req), expectedVersions: undefined };
    const version = await this.database
      .asUser(ctx, async (db) => (await db.execute<{ v: string | null }>(sql`select app.row_version(updated_at) as v from ${sql.raw(quoteTable(table))} where id = ${id}::uuid`)).rows[0]?.v ?? null)
      .catch(() => null);
    if (!version) return body;
    if (!res.headersSent) res.setHeader('ETag', `"${version}"`);
    if (body && typeof body === 'object' && !Array.isArray(body) && (body as { id?: unknown }).id === id) return { ...(body as object), rowVersion: version };
    return body;
  }

  /** The 409 answer: what changed since the version the save was based on, and who changed it. */
  private async conflict(req: ApiRequest, table: string, id: string, since: string): Promise<ApiError> {
    const ctx = { ...contextFrom(req), expectedVersions: undefined };
    const details = await this.database
      .asUser(ctx, async (db) => (await db.execute<{ d: ConflictDetails }>(sql`select app.edit_conflict_details(${table}, ${id}::uuid, ${since}) as d`)).rows[0]?.d)
      .catch(() => undefined);
    const by = details?.changedBy?.name;
    return new ApiError(
      HttpStatus.CONFLICT,
      'edit_conflict',
      by ? `${by} changed this since you opened it` : 'Someone else changed this since you opened it',
      details ? { ...details, fields: details.fields.map(apiFieldName) } : undefined,
    );
  }
}

const quoteTable = (table: string) => `public."${table.replace(/"/g, '""')}"`;
