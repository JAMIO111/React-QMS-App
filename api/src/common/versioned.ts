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

/**
 * On a GET that answers several records of one table (a register page, or a list inside a record such as a plan's revisions): every row gets its
 * `rowVersion`, read in one query, so an edit dialog opened from a row can say which version it was based on. `key` names the list in the answer
 * (default: `data`, then `items`, then the answer itself when it is an array).
 */
export const VERSIONED_ROWS = 'qms:versioned-rows';
export const VersionedRows = (table: string, key?: string) => SetMetadata(VERSIONED_ROWS, { table, key });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROWS = 1000;

/** The objects of an answer that are rows of the table. */
export function rowsOf(body: unknown, key?: string): Array<Record<string, unknown>> {
  if (!body || typeof body !== 'object') return [];
  const b = body as Record<string, unknown>;
  const list = key ? b[key] : Array.isArray(body) ? body : (b.data ?? b.items);
  if (!Array.isArray(list)) return [];
  return list.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string' && UUID.test((r as { id: string }).id)).slice(0, MAX_ROWS);
}

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
    if (context.getType() !== 'http') return next.handle();
    const table = this.reflector.get<string | undefined>(VERSIONED, context.getHandler());
    const rows = this.reflector.get<{ table: string; key?: string } | undefined>(VERSIONED_ROWS, context.getHandler());
    if (!table && !rows) return next.handle();
    const req = context.switchToHttp().getRequest<ApiRequest & { params: Record<string, string> }>();
    if (!table) {
      if (!rows || !req.user || req.method !== 'GET') return next.handle();
      return next.handle().pipe(mergeMap((body) => from(this.attachRowVersions(req, rows.table, rowsOf(body, rows.key)).then(() => body))));
    }
    const listed = rows && req.method === 'GET' ? rows : null;
    const res = context.switchToHttp().getResponse<{ setHeader: (k: string, v: string) => void; headersSent?: boolean }>();
    const id = req.params?.id;
    if (!id || !req.user) return next.handle();

    const expected = MUTATING.has(req.method) ? takeExpectedVersion(req as never) : null;
    if (expected) req.expectedVersions = { [`${table}:${id}`]: expected };

    return next.handle().pipe(
      mergeMap((body) => from(this.attachVersion(req, res, table, id, body))),
      mergeMap((body) => (listed ? from(this.attachRowVersions(req, listed.table, rowsOf(body, listed.key)).then(() => body)) : from([body]))),
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

  /** Puts each row's version on it, in place (rows the caller may not read under RLS, or tables without the column, are left as they are). */
  private async attachRowVersions(req: ApiRequest, table: string, rows: Array<Record<string, unknown>>) {
    if (!rows.length) return;
    const ctx = { ...contextFrom(req), expectedVersions: undefined };
    const ids = `{${rows.map((r) => r.id as string).join(',')}}`;
    const found = await this.database
      .asUser(ctx, async (db) => (await db.execute<{ id: string; v: string | null }>(sql`select id::text as id, app.row_version(updated_at) as v from ${sql.raw(quoteTable(table))} where id = any(${ids}::uuid[])`)).rows)
      .catch(() => [] as Array<{ id: string; v: string | null }>);
    const byId = new Map(found.map((f) => [f.id, f.v]));
    for (const row of rows) {
      const v = byId.get(String(row.id).toLowerCase());
      if (v) row.rowVersion = v;
    }
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
