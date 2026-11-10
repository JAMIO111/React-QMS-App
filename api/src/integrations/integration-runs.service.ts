import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { ENTITY_LABELS, EntityType } from './core/entity-importer';
import { DrainResult, SyncEngine } from './core/sync.engine';
import { ExternalRecordPage, ExternalRecordQuery, InboxRowPage, RequestRunBody, RetryBody, ROW_STATUSES, RowListQuery, Run, RunDetail, RunListQuery, RunPage } from './integration-runs.schemas';
import { ReasonBody } from './integrations.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown user' } : null);

const SELECT = `
  select r.*, c.name as connection_name, ${personName('pq')} as requested_by_name, ${personName('px')} as cancelled_by_name,
         f.file_name, m.version as mapping_version, tv.version as template_version, tt.id as template_id, tt.name as template_name
  from public.integration_sync_runs r
  join public.integration_connections c on c.id = r.connection_id
  left join public.integration_files f on f.id = r.file_id
  left join public.integration_mappings m on m.id = r.mapping_id
  left join public.integration_template_versions tv on tv.id = r.template_version_id
  left join public.integration_templates tt on tt.id = tv.template_id
  left join public.profiles pq on pq.id = r.requested_by
  left join public.profiles px on px.id = r.cancelled_by`;

const toRun = (r: Row): z.infer<typeof Run> => ({
  id: r.id as string,
  connection: { id: r.connection_id as string, name: r.connection_name as string },
  entityType: r.entity_type as EntityType,
  kind: r.kind as z.infer<typeof Run>['kind'],
  trigger: r.trigger as 'user' | 'schedule',
  status: r.status as z.infer<typeof Run>['status'],
  requestedBy: person(r.requested_by, r.requested_by_name),
  requestedAt: iso(r.requested_at)!,
  startedAt: iso(r.started_at),
  finishedAt: iso(r.finished_at),
  counts: {
    total: Number(r.records_total), rejected: Number(r.rejected), unchanged: Number(r.unchanged), created: Number(r.created), updated: Number(r.updated),
    failed: Number(r.failed), superseded: Number(r.superseded), skipped: Number(r.skipped ?? 0),
  },
  attempts: Number(r.attempts),
  nextAttemptAt: ['queued', 'running'].includes(r.status as string) && r.next_attempt_at && new Date(r.next_attempt_at as string) > new Date() ? iso(r.next_attempt_at) : null,
  errorSummary: (r.error_summary as string) ?? null,
  cancelReason: (r.cancel_reason as string) ?? null,
  cancelledBy: person(r.cancelled_by, r.cancelled_by_name),
  fetchDone: !!r.fetch_done,
  file: r.file_id ? { id: r.file_id as string, name: r.file_name as string } : null,
  mappingVersion: r.mapping_version === null || r.mapping_version === undefined ? null : Number(r.mapping_version),
  template: r.template_id ? { id: r.template_id as string, name: r.template_name as string, version: Number(r.template_version) } : null,
  settings: (r.settings as z.infer<typeof Run>['settings']) ?? null,
});

/**
 * Import runs (IN2): ask for a preview, a full or an incremental import, retry failed rows, cancel, and watch what happened. Asking for a run also works it for
 * a while in the same request (the sync engine, on the API login); a run that is not finished is carried on with `continue` or by the cron route.
 */
@Injectable()
export class IntegrationRunsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly engine: SyncEngine,
  ) {}

  /** Can this connection preview (adapter + catalogue) or import (adapter + importer) this kind of record with what this deployment has? */
  private async assertRunnable(ctx: RequestContext, connectionId: string, entity: EntityType, kind: 'preview' | 'full' | 'incremental' | 'retry'): Promise<void> {
    const provider = await this.database.asUser(ctx, async (db) => {
      const rows = await db.execute<Row>(sql`select p.key from public.integration_connections c join public.integration_providers p on p.id = c.provider_id where c.id = ${connectionId}::uuid and c.organisation_id = ${orgOf(ctx)}::uuid`);
      if (!rows.rows[0]) throw ApiError.notFound('connection_not_found', 'Connection not found');
      return rows.rows[0].key as string;
    });
    const allowed = kind === 'preview' ? this.engine.runnable(provider) : this.engine.importable(provider);
    if (!allowed.includes(entity)) {
      throw new ApiError(409, 'integration_rule', kind === 'preview' ? `Previewing ${ENTITY_LABELS[entity]} through this connection is not available` : `Importing ${ENTITY_LABELS[entity]} is not available yet: run a preview to check the file`);
    }
  }

  private async drainAndLoad(ctx: RequestContext, runId: string): Promise<RunDetail> {
    const drain: DrainResult = await this.engine.drain(orgOf(ctx), runId, { correlationId: ctx.correlationId });
    const detail = await this.get(ctx, runId);
    return { ...detail, drain: { state: drain.state, reason: drain.reason ?? null } };
  }

  async request(ctx: RequestContext, connectionId: string, b: RequestRunBody): Promise<RunDetail> {
    await this.assertRunnable(ctx, connectionId, b.entityType, b.kind);
    const id = await this.database.asUser(ctx, async (db) => (await db.execute<{ id: string }>(sql`select app.request_integration_run(${connectionId}::uuid, ${b.entityType}, ${b.kind}, ${b.fileId ?? null}::uuid, ${b.templateId ?? null}::uuid) as id`)).rows[0].id);
    return this.drainAndLoad(ctx, id);
  }

  async retry(ctx: RequestContext, connectionId: string, b: RetryBody): Promise<RunDetail> {
    await this.assertRunnable(ctx, connectionId, b.entityType, 'retry');
    const id = await this.database.asUser(ctx, async (db, client) =>
      (await client.query('select app.retry_integration_rows($1::uuid, $2, $3::uuid[]) as id', [connectionId, b.entityType, b.rowIds ?? null])).rows[0].id as string,
    );
    return this.drainAndLoad(ctx, id);
  }

  /** Work an unfinished run for a while longer (it is leased, so two calls never work it at once). */
  async continue(ctx: RequestContext, runId: string): Promise<RunDetail> {
    await this.database.asUser(ctx, async (db) => {
      const rows = await db.execute<Row>(sql`select id from public.integration_sync_runs where id = ${runId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!rows.rows[0]) throw ApiError.notFound('run_not_found', 'Import not found');
      const allowed = await db.execute<{ ok: boolean }>(sql`select app.has_permission(${orgOf(ctx)}::uuid, 'integrations.run') as ok`);
      if (!allowed.rows[0].ok) throw ApiError.forbidden('You are not allowed to run imports');
    });
    return this.drainAndLoad(ctx, runId);
  }

  async cancel(ctx: RequestContext, runId: string, b: ReasonBody): Promise<RunDetail> {
    await this.database.asUser(ctx, (db) => db.execute(sql`select app.cancel_integration_run(${runId}::uuid, ${b.reason})`));
    return this.get(ctx, runId);
  }

  list(ctx: RequestContext, q: RunListQuery): Promise<z.infer<typeof RunPage>> {
    return this.database.asUser(ctx, async (db) => {
      const where = sql`r.organisation_id = ${orgOf(ctx)}::uuid
        and (${q.connectionId ?? null}::uuid is null or r.connection_id = ${q.connectionId ?? null}::uuid)
        and (${q.status ?? null}::text is null or r.status = ${q.status ?? null})`;
      const [rows, total] = await Promise.all([
        db.execute<Row>(sql`${sql.raw(SELECT)} where ${where} order by r.requested_at desc, r.id limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`),
        db.execute<{ n: number }>(sql`select count(*)::int as n from public.integration_sync_runs r where ${where}`),
      ]);
      return { data: rows.rows.map(toRun), page: q.page, pageSize: q.pageSize, total: total.rows[0].n };
    });
  }

  private async load(db: Db, ctx: RequestContext, runId: string): Promise<RunDetail> {
    const rows = await db.execute<Row>(sql`${sql.raw(SELECT)} where r.id = ${runId}::uuid and r.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!rows.rows[0]) throw ApiError.notFound('run_not_found', 'Import not found');
    const [errors, statuses] = await Promise.all([
      db.execute<Row>(sql`select attempt, kind, message, transient, at from public.integration_run_errors where run_id = ${runId}::uuid order by at, attempt`),
      db.execute<Row>(sql`select status, count(*)::int as n from public.integration_inbox where run_id = ${runId}::uuid or last_run_id = ${runId}::uuid group by status`),
    ]);
    const r = rows.rows[0];
    const rowsNow = Object.fromEntries(ROW_STATUSES.map((s) => [s, 0])) as Record<(typeof ROW_STATUSES)[number], number>;
    for (const s of statuses.rows) rowsNow[s.status as (typeof ROW_STATUSES)[number]] = Number(s.n);
    return {
      ...toRun(r),
      cursorStart: (r.cursor_start as string) ?? null,
      cursorNext: (r.cursor_next as string) ?? null,
      errors: errors.rows.map((e) => ({ attempt: Number(e.attempt), kind: e.kind as string, message: e.message as string, transient: !!e.transient, at: iso(e.at)! })),
      rowsNow,
      drain: null,
    };
  }

  get(ctx: RequestContext, runId: string): Promise<RunDetail> {
    return this.database.asUser(ctx, (db) => this.load(db, ctx, runId));
  }

  /** The rows a run staged or worked on (a retry run lists the rows it retried). */
  rows(ctx: RequestContext, runId: string, q: RowListQuery): Promise<z.infer<typeof InboxRowPage>> {
    return this.database.asUser(ctx, async (db) => {
      const exists = await db.execute<Row>(sql`select 1 from public.integration_sync_runs where id = ${runId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!exists.rows[0]) throw ApiError.notFound('run_not_found', 'Import not found');
      const where = sql`i.organisation_id = ${orgOf(ctx)}::uuid and (i.run_id = ${runId}::uuid or i.last_run_id = ${runId}::uuid)
        and (${q.status ?? null}::text is null or i.status = ${q.status ?? null})`;
      const [rows, total] = await Promise.all([
        db.execute<Row>(sql`select i.* from public.integration_inbox i where ${where} order by i.created_at, i.source_row nulls last, i.id limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`),
        db.execute<{ n: number }>(sql`select count(*)::int as n from public.integration_inbox i where ${where}`),
      ]);
      return {
        data: rows.rows.map((i) => ({
          id: i.id as string,
          runId: i.run_id as string,
          externalId: (i.external_id as string) ?? null,
          sourceRow: i.source_row === null ? null : Number(i.source_row),
          status: i.status as (typeof ROW_STATUSES)[number],
          action: (i.action as 'create' | 'update') ?? null,
          internalId: (i.internal_id as string) ?? null,
          errors: ((i.errors as { field?: string | null; message: string }[]) ?? []).map((e) => ({ field: e.field ?? null, message: e.message })),
          attempts: Number(i.attempts),
          payload: (i.payload as Record<string, unknown>) ?? null,
          purgedAt: iso(i.payload_purged_at),
          createdAt: iso(i.created_at)!,
          appliedAt: iso(i.applied_at),
        })),
        page: q.page,
        pageSize: q.pageSize,
        total: total.rows[0].n,
      };
    });
  }

  /** The map: which QMS record each source record became. */
  externalRecords(ctx: RequestContext, connectionId: string, q: ExternalRecordQuery): Promise<z.infer<typeof ExternalRecordPage>> {
    return this.database.asUser(ctx, async (db) => {
      const exists = await db.execute<Row>(sql`select 1 from public.integration_connections where id = ${connectionId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!exists.rows[0]) throw ApiError.notFound('connection_not_found', 'Connection not found');
      const like = q.q ? `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
      const where = sql`x.organisation_id = ${orgOf(ctx)}::uuid and x.connection_id = ${connectionId}::uuid
        and (${q.entityType ?? null}::text is null or x.entity_type = ${q.entityType ?? null})
        and (${like}::text is null or x.external_id ilike ${like})`;
      const [rows, total] = await Promise.all([
        db.execute<Row>(sql`select x.* from public.integration_external_records x where ${where} order by x.entity_type, x.external_id limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`),
        db.execute<{ n: number }>(sql`select count(*)::int as n from public.integration_external_records x where ${where}`),
      ]);
      return {
        data: rows.rows.map((x) => ({
          entityType: x.entity_type as EntityType, externalId: x.external_id as string, internalId: x.internal_id as string,
          firstRunId: x.first_run_id as string, lastRunId: x.last_run_id as string, createdAt: iso(x.created_at)!, updatedAt: iso(x.updated_at)!,
        })),
        page: q.page,
        pageSize: q.pageSize,
        total: total.rows[0].n,
      };
    });
  }
}
