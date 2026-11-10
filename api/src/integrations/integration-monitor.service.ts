import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { EntityType } from './core/entity-importer';
import { RECORDS } from './integration-conflicts.service';
import { AttentionList, AttentionQuery, DecideMissingBody, Health, IgnoreRowsBody, MissingListQuery, MissingPage, RestoreRowsBody } from './integration-monitor.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const HAS_ACTIVE = new Set(['supplier', 'customer', 'part', 'machine', 'employee', 'gauge_type']);

/**
 * Keeping imports healthy (IN8, connectors plan §6.16): the health of every connection and kind of record, records a full read no longer
 * contained (listed, held for a person, decided), and rejected or failed rows a person ignores with a reason or brings back. Every change is a
 * database function that checks the permissions; this service reads and reshapes.
 */
@Injectable()
export class IntegrationMonitorService {
  constructor(private readonly database: DatabaseService) {}

  health(ctx: RequestContext): Promise<Health> {
    return this.database.asUser(ctx, async (db) => {
      const rows = (await db.execute<{ h: Health['data'] }>(sql`select app.integration_health(${orgOf(ctx)}::uuid) as h`)).rows[0].h ?? [];
      const data = rows.map((r) => {
        const failing = (r.lastRun?.status === 'failed') || !!r.scheduleProblem || r.failedInARow > 0;
        const attention = r.rowsNeedingAction > 0 || r.missingWaiting > 0 || r.conflictsOpen > 0 || r.lastRun?.status === 'partial' || (r.lastRun?.status === 'running' && !!r.lastRun.nextAttemptAt);
        return { ...r, state: (failing ? 'failing' : attention ? 'attention' : 'ok') as Health['data'][number]['state'] };
      });
      const counts = { ok: 0, attention: 0, failing: 0 };
      for (const r of data) counts[r.state] += 1;
      return { data, counts };
    });
  }

  missing(ctx: RequestContext, q: MissingListQuery): Promise<MissingPage> {
    return this.database.asUser(ctx, async (db) => {
      const statuses = q.status === 'open' ? 'listed,held' : q.status === 'decided' ? 'deactivated,kept,returned' : 'listed,held,deactivated,kept,returned';
      const where = sql`m.organisation_id = ${orgOf(ctx)}::uuid and m.status = any(string_to_array(${statuses}, ','))
        and (${q.connectionId ?? null}::uuid is null or m.connection_id = ${q.connectionId ?? null}::uuid)
        and (${q.entityType ?? null}::text is null or m.entity_type = ${q.entityType ?? null})
        and (${q.runId ?? null}::uuid is null or m.detected_run_id = ${q.runId ?? null}::uuid)`;
      const total = Number((await db.execute<{ n: string }>(sql`select count(*) as n from public.integration_missing_records m where ${where}`)).rows[0].n);
      const openCount = Number(
        (await db.execute<{ n: string }>(sql`select count(*) as n from public.integration_missing_records where organisation_id = ${orgOf(ctx)}::uuid and status in ('listed', 'held')`)).rows[0].n,
      );
      const rows = (
        await db.execute<Row>(sql`select m.*, c.name as connection_name, ${sql.raw(personName('p'))} as decided_by_name
          from public.integration_missing_records m
          join public.integration_connections c on c.id = m.connection_id
          left join public.profiles p on p.id = m.decided_by
          where ${where}
          order by (m.status = 'held') desc, (m.status = 'listed') desc, m.created_at desc, m.external_id
          limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`)
      ).rows;

      // The records themselves (label and whether they are active), read as the caller.
      const records = new Map<string, Record<string, unknown>>();
      for (const entity of new Set(rows.map((r) => r.entity_type as EntityType))) {
        const spec = RECORDS[entity];
        if (!spec) continue;
        const ids = rows.filter((r) => r.entity_type === entity).map((r) => r.internal_id as string);
        const found = await db.execute<{ id: string; row: Record<string, unknown> }>(
          sql`select x.id, to_jsonb(x) as row from ${sql.raw(spec.table)} x where x.organisation_id = ${orgOf(ctx)}::uuid and x.id = any(string_to_array(${ids.join(',')}, ',')::uuid[])`,
        );
        for (const r of found.rows) records.set(r.id, r.row);
      }
      const canDecide = new Map<string, boolean>();
      for (const entity of new Set(rows.map((r) => r.entity_type as string))) {
        const r = await db.execute<{ ok: boolean }>(sql`select app.has_permission(${orgOf(ctx)}::uuid, 'integrations.run') and app.integration_may_write(${orgOf(ctx)}::uuid, ${entity}) as ok`);
        canDecide.set(entity, !!r.rows[0]?.ok);
      }
      return {
        data: rows.map((r) => {
          const entity = r.entity_type as EntityType;
          const rec = records.get(r.internal_id as string);
          const open = r.status === 'listed' || r.status === 'held';
          return {
            id: r.id as string,
            connection: { id: r.connection_id as string, name: r.connection_name as string },
            entityType: entity,
            externalId: r.external_id as string,
            record: { id: r.internal_id as string, label: rec ? (RECORDS[entity]?.label(rec) ?? null) : null, active: rec && 'active' in rec ? !!rec.active : null },
            status: r.status as MissingPage['data'][number]['status'],
            reason: (r.reason as string) ?? null,
            detectedRunId: r.detected_run_id as string,
            detectedAt: iso(r.created_at)!,
            decidedAt: iso(r.decided_at),
            decidedBy: r.decided_by ? { id: r.decided_by as string, name: (r.decided_by_name as string) ?? 'Unknown user' } : null,
            decisionNote: (r.decision_note as string) ?? null,
            canDecide: open && (canDecide.get(entity) ?? false),
            canDeactivate: open && HAS_ACTIVE.has(entity),
          };
        }),
        page: q.page,
        pageSize: q.pageSize,
        total,
        openCount,
      };
    });
  }

  async decideMissing(ctx: RequestContext, b: DecideMissingBody): Promise<{ decided: number }> {
    return this.database.asUser(ctx, async (db, client) => {
      // Ids from another organisation are "not found", never a hint they exist.
      const mine = await db.execute<{ n: string }>(
        sql`select count(*) as n from public.integration_missing_records where organisation_id = ${orgOf(ctx)}::uuid and id = any(string_to_array(${b.ids.join(',')}, ',')::uuid[])`,
      );
      if (Number(mine.rows[0].n) !== new Set(b.ids).size) throw ApiError.notFound('missing_record_not_found', 'Record not found');
      const r = await client.query('select app.decide_missing_records($1::uuid[], $2, $3) as n', [b.ids, b.deactivate, b.note || null]);
      return { decided: Number(r.rows[0].n) };
    });
  }

  attention(ctx: RequestContext, connectionId: string, q: AttentionQuery): Promise<AttentionList> {
    return this.database.asUser(ctx, async (db) => {
      await this.connection(db, ctx, connectionId);
      const rows = (
        await db.execute<Row>(
          q.ignored === 'only'
            ? sql`select i.*, ${sql.raw(personName('p'))} as ignored_by_name from public.integration_inbox i left join public.profiles p on p.id = i.ignored_by
                   where i.connection_id = ${connectionId}::uuid and i.entity_type = ${q.entityType} and i.status = 'ignored'
                   order by i.ignored_at desc limit 500`
            : sql`with latest as (
                     select distinct on (i.external_id) i.id, i.status from public.integration_inbox i
                       join public.integration_sync_runs r on r.id = i.run_id and r.kind <> 'preview'
                      where i.connection_id = ${connectionId}::uuid and i.entity_type = ${q.entityType} and i.external_id is not null
                        and i.status in ('applied', 'unchanged', 'skipped', 'rejected', 'failed', 'ignored')
                      order by i.external_id, i.created_at desc),
                   last_run as (
                     select r.id from public.integration_sync_runs r where r.connection_id = ${connectionId}::uuid and r.entity_type = ${q.entityType}
                        and r.kind in ('full', 'incremental') and r.status in ('succeeded', 'partial', 'failed') order by r.requested_at desc limit 1)
                   select i.*, null as ignored_by_name from public.integration_inbox i
                    where i.id in (select id from latest where status in ('rejected', 'failed'))
                       or (i.external_id is null and i.status = 'rejected' and i.run_id = (select id from last_run))
                    order by i.created_at desc limit 500`,
        )
      ).rows;
      return {
        data: rows.map((r) => ({
          id: r.id as string,
          runId: r.run_id as string,
          externalId: (r.external_id as string) ?? null,
          sourceRow: r.source_row === null || r.source_row === undefined ? null : Number(r.source_row),
          status: r.status as AttentionList['data'][number]['status'],
          errors: (r.errors as { field: string | null; message: string }[]) ?? [],
          payload: (r.payload as Record<string, unknown>) ?? null,
          createdAt: iso(r.created_at)!,
          ignored:
            r.status === 'ignored'
              ? { at: iso(r.ignored_at)!, by: r.ignored_by ? { id: r.ignored_by as string, name: (r.ignored_by_name as string) ?? 'Unknown user' } : null, reason: r.ignore_reason as string, from: r.ignored_from as string }
              : null,
        })),
        total: rows.length,
      };
    });
  }

  ignore(ctx: RequestContext, connectionId: string, b: IgnoreRowsBody): Promise<{ changed: number }> {
    return this.database.asUser(ctx, async (db, client) => {
      await this.connection(db, ctx, connectionId);
      const r = await client.query('select app.ignore_integration_rows($1::uuid, $2::uuid[], $3) as n', [connectionId, b.rowIds, b.reason]);
      return { changed: Number(r.rows[0].n) };
    });
  }

  restore(ctx: RequestContext, connectionId: string, b: RestoreRowsBody): Promise<{ changed: number }> {
    return this.database.asUser(ctx, async (db, client) => {
      await this.connection(db, ctx, connectionId);
      const r = await client.query('select app.restore_integration_rows($1::uuid, $2::uuid[]) as n', [connectionId, b.rowIds]);
      return { changed: Number(r.rows[0].n) };
    });
  }

  private async connection(db: Parameters<Parameters<DatabaseService['asUser']>[1]>[0], ctx: RequestContext, id: string) {
    const found = await db.execute<{ id: string }>(sql`select id from public.integration_connections where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
    if (!found.rows[0]) throw ApiError.notFound('connection_not_found', 'Connection not found');
  }
}
