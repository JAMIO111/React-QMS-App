import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { iso, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { DATASETS, datasetByKey, selectList } from './datasets';
import { makeReportKey } from './report-key';
import type { CreateReportKeyBody, DatasetQuery, ReportKey, RevokeReportKeyBody } from './reporting.schemas';
import { ISO_MICROS } from './reporting.schemas';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const encodeCursor = (updatedAt: string, id: string): string => Buffer.from(JSON.stringify({ u: updatedAt, i: id }), 'utf8').toString('base64url');

export function decodeCursor(cursor: string): { u: string; i: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { u?: unknown; i?: unknown };
    if (typeof value.u === 'string' && ISO_MICROS.test(value.u) && typeof value.i === 'string' && UUID.test(value.i)) return { u: value.u, i: value.i };
  } catch {
    // fall through
  }
  throw ApiError.badRequest('invalid_cursor', 'That page marker is not valid. Start again without "after".');
}

const toKey = (r: Row, userId: string): ReportKey => ({
  id: r.id as string,
  name: r.name as string,
  keyPrefix: r.key_prefix as string,
  status: r.status as ReportKey['status'],
  expiresAt: iso(r.expires_at)!,
  lastUsedAt: iso(r.last_used_at),
  lastUsedAddress: (r.last_used_address as string | null) ?? null,
  revokedAt: iso(r.revoked_at),
  revokedReason: (r.revoked_reason as string | null) ?? null,
  createdAt: iso(r.created_at)!,
  mine: r.user_id === userId,
});

const KEY_COLUMNS = sql.raw(`k.id, k.name, k.key_prefix, k.user_id, k.expires_at, k.last_used_at, k.last_used_address, k.revoked_at, k.revoked_reason, k.created_at,
  case when k.revoked_at is not null then 'revoked' when k.expires_at <= now() then 'expired' else 'active' end as status`);

/**
 * The reporting datasets and the keys that read them (docs/reporting-api-plan.md). Everything runs as the person the key stands for, so row-level security
 * decides which rows come back; the dataset's own read permission is checked first so a person without it gets a clear 403 rather than an empty table.
 */
@Injectable()
export class ReportingService {
  constructor(private readonly database: DatabaseService) {}

  catalogue() {
    return {
      datasets: DATASETS.map((d) => ({
        key: d.key,
        title: d.title,
        description: d.description,
        path: `/api/v1/reporting/v1/${d.key}`,
        columns: d.columns.map((c) => ({ name: c.name, type: c.type, description: c.description })),
      })),
    };
  }

  /** One page of a dataset, oldest change first, so a reader can follow `nextCursor` to the end and later ask only for what changed since. */
  page(ctx: RequestContext, key: string, query: DatasetQuery) {
    const dataset = datasetByKey(key);
    if (!dataset) throw ApiError.notFound('dataset_not_found', 'There is no such dataset. GET /api/v1/reporting/v1/datasets lists them.');
    const after = query.after ? decodeCursor(query.after) : null;
    return this.database.asUser(ctx, async (db) => {
      const org = ctx.organisationId!;
      const allowed = (await db.execute<{ ok: boolean }>(sql`select app.has_permission_somewhere(${org}::uuid, ${dataset.permission}::text) as ok`)).rows[0]?.ok;
      if (!allowed) throw ApiError.forbidden(undefined, { permission: dataset.permission });
      const since = query.updatedSince ? sql`and v.updated_at >= ${query.updatedSince}::timestamptz` : sql``;
      const cursor = after ? sql`and (v.updated_at, v.id) > (${after.u}::timestamptz, ${after.i}::uuid)` : sql``;
      const res = await db.execute<Row>(sql`
        select ${sql.raw(selectList(dataset))},
               to_char(v.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "__cursor"
          from public.${sql.raw(dataset.view)} v
         where v.organisation_id = ${org}::uuid ${since} ${cursor}
         order by v.updated_at, v.id
         limit ${query.limit + 1}`);
      const more = res.rows.length > query.limit;
      const rows = more ? res.rows.slice(0, query.limit) : res.rows;
      const last = rows[rows.length - 1];
      const data = rows.map(({ __cursor: _drop, ...rest }) => rest);
      return {
        dataset: dataset.key,
        asOf: new Date().toISOString(),
        count: data.length,
        nextCursor: more && last ? encodeCursor(last.__cursor as string, last.id as string) : null,
        data,
      };
    });
  }

  listKeys(ctx: RequestContext): Promise<{ data: ReportKey[] }> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`select ${KEY_COLUMNS} from public.reporting_keys k where k.organisation_id = ${ctx.organisationId}::uuid order by k.created_at desc`);
      return { data: res.rows.map((r) => toKey(r, ctx.user.id)) };
    });
  }

  /** Makes a key that stands for the caller. The key is returned once; only its hash is stored. */
  createKey(ctx: RequestContext, body: CreateReportKeyBody): Promise<{ secret: string; key: ReportKey }> {
    const made = makeReportKey();
    return this.database.asUser(ctx, async (db) => {
      const created = (await db.execute<{ r: { id: string } }>(
        sql`select app.create_reporting_key(${ctx.organisationId}::uuid, ${body.name}, ${body.days}::int, ${made.hash}, ${made.prefix}) as r`,
      )).rows[0].r;
      const res = await db.execute<Row>(sql`select ${KEY_COLUMNS} from public.reporting_keys k where k.id = ${created.id}::uuid`);
      return { secret: made.secret, key: toKey(res.rows[0], ctx.user.id) };
    });
  }

  revokeKey(ctx: RequestContext, id: string, body: RevokeReportKeyBody): Promise<ReportKey> {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.revoke_reporting_key(${id}::uuid, ${body.reason})`);
      const res = await db.execute<Row>(sql`select ${KEY_COLUMNS} from public.reporting_keys k where k.id = ${id}::uuid and k.organisation_id = ${ctx.organisationId}::uuid`);
      if (!res.rows[0]) throw ApiError.notFound();
      return toKey(res.rows[0], ctx.user.id);
    });
  }
}
