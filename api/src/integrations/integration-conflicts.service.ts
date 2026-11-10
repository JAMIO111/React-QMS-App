import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { CatalogueField, catalogueFor, RefKind } from './core/catalogue';
import { ENTITY_COLUMNS } from './core/columns';
import { EntityType } from './core/entity-importer';
import { outKey } from './core/references';
import { Conflict, ConflictListQuery, ConflictPage } from './integration-conflicts.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;

/** Each kind of record's table and the words that name one (read as the caller, so a record they cannot see has no label). */
export const RECORDS: Partial<Record<EntityType, { table: string; label: (r: Record<string, unknown>) => string }>> = {
  supplier: { table: 'public.suppliers', label: (r) => `${r.code} — ${r.name}` },
  customer: { table: 'public.customers', label: (r) => `${r.code} — ${r.name}` },
  part: { table: 'public.parts', label: (r) => `${r.part_number} — ${r.name}` },
  machine: { table: 'public.machines', label: (r) => `${r.code} — ${r.name}` },
  employee: { table: 'public."Employees"', label: (r) => `${r.employee_number} — ${[r.first_name, r.surname].filter(Boolean).join(' ')}` },
  gauge_type: { table: 'public.gauge_types', label: (r) => `${r.code} — ${r.name}` },
  gauge: { table: 'public.gauges', label: (r) => `${r.asset_number} — ${r.description}` },
  nonconformance: { table: 'public.nonconformances', label: (r) => `${r.reference} — ${r.title}` },
  production_order: { table: 'public.production_orders', label: (r) => String(r.order_number) },
  // An order line, named by its order's number.
  purchase_order: {
    table: '(select l.*, o.po_number from public.purchase_order_lines l join public.purchase_orders o on o.id = l.purchase_order_id)',
    label: (r) => `${r.po_number} line ${r.line_number}`,
  },
};

/** Where a link's code lives, to show a linked record by its code rather than its id. Units are stored by their code already. */
const REF_CODES: Partial<Record<RefKind, { table: string; column: string }>> = {
  site: { table: 'public.sites', column: 'code' },
  department: { table: 'public.departments', column: 'code' },
  category: { table: 'public.ncr_classifications', column: 'code' },
  supplier: { table: 'public.suppliers', column: 'code' },
  customer: { table: 'public.customers', column: 'code' },
  part: { table: 'public.parts', column: 'part_number' },
  machine: { table: 'public.machines', column: 'code' },
  employee: { table: 'public."Employees"', column: 'employee_number' },
  gauge_type: { table: 'public.gauge_types', column: 'code' },
};

const words = (field: CatalogueField | undefined, v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  const option = field?.options?.find((o) => o.value === s);
  return option ? option.label : s;
};

/**
 * The review queue (IN5, plan §6.5). A field set to "Review" in an import template is never written by an update: when its new value would change the
 * record the database parks it here. A person who may run imports and edit that kind of record accepts it (Fortress then writes it, as them, under the
 * same rules) or rejects it with a reason (Fortress keeps its own, and the same value is not asked about again).
 */
@Injectable()
export class IntegrationConflictsService {
  constructor(private readonly database: DatabaseService) {}

  list(ctx: RequestContext, q: ConflictListQuery): Promise<ConflictPage> {
    return this.database.asUser(ctx, async (db) => {
      const statuses = q.status === 'all' ? ['open', 'accepted', 'rejected', 'superseded'] : q.status === 'decided' ? ['accepted', 'rejected'] : [q.status];
      const where = sql`c.organisation_id = ${orgOf(ctx)}::uuid and c.status = any(string_to_array(${statuses.join(',')}, ','))
        and (${q.entityType ?? null}::text is null or c.entity_type = ${q.entityType ?? null})
        and (${q.connectionId ?? null}::uuid is null or c.connection_id = ${q.connectionId ?? null}::uuid)
        and (${q.runId ?? null}::uuid is null or c.run_id = ${q.runId ?? null}::uuid)
        and (${q.recordId ?? null}::uuid is null or c.internal_id = ${q.recordId ?? null}::uuid)`;
      const total = Number((await db.execute<{ n: string }>(sql`select count(*) as n from public.integration_conflicts c where ${where}`)).rows[0].n);
      const openCount = Number(
        (await db.execute<{ n: string }>(sql`select count(*) as n from public.integration_conflicts where organisation_id = ${orgOf(ctx)}::uuid and status = 'open'`)).rows[0].n,
      );
      const rows = (
        await db.execute<Row>(sql`select c.*, n.name as connection_name, ${sql.raw(personName('p'))} as decided_by_name
          from public.integration_conflicts c
          join public.integration_connections n on n.id = c.connection_id
          left join public.profiles p on p.id = c.decided_by
          where ${where}
          order by (c.status = 'open') desc, c.created_at desc, c.id
          limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`)
      ).rows;
      return { data: await this.present(db, ctx, rows), page: q.page, pageSize: q.pageSize, total, openCount };
    });
  }

  async decide(ctx: RequestContext, id: string, accept: boolean, note: string | null): Promise<Conflict> {
    return this.database.asUser(ctx, async (db, client) => {
      const found = await db.execute<Row>(sql`select id from public.integration_conflicts where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!found.rows[0]) throw ApiError.notFound('conflict_not_found', 'Value not found');
      await client.query('select app.decide_integration_conflict($1::uuid, $2, $3)', [id, accept, note]);
      return this.load(db, ctx, id);
    });
  }

  private async load(db: Db, ctx: RequestContext, id: string): Promise<Conflict> {
    const rows = (
      await db.execute<Row>(sql`select c.*, n.name as connection_name, ${sql.raw(personName('p'))} as decided_by_name
        from public.integration_conflicts c
        join public.integration_connections n on n.id = c.connection_id
        left join public.profiles p on p.id = c.decided_by
        where c.id = ${id}::uuid and c.organisation_id = ${orgOf(ctx)}::uuid`)
    ).rows;
    if (!rows[0]) throw ApiError.notFound('conflict_not_found', 'Value not found');
    return (await this.present(db, ctx, rows))[0];
  }

  /** Turn rows into what people read: the record's name, the field's label and both values in words (links by their code). */
  private async present(db: Db, ctx: RequestContext, rows: Row[]): Promise<Conflict[]> {
    if (rows.length === 0) return [];
    const org = orgOf(ctx);
    const entities = [...new Set(rows.map((r) => r.entity_type as EntityType))];

    // The records themselves (their names, and the current value for a conflict that could not be applied).
    const records = new Map<string, Record<string, unknown>>();
    for (const entity of entities) {
      const spec = RECORDS[entity];
      if (!spec) continue;
      const ids = rows.filter((r) => r.entity_type === entity).map((r) => r.internal_id as string);
      const found = await db.execute<{ id: string; row: Record<string, unknown> }>(
        sql`select x.id, to_jsonb(x) as row from ${sql.raw(spec.table)} x where x.organisation_id = ${org}::uuid and x.id = any(string_to_array(${ids.join(',')}, ',')::uuid[])`,
      );
      for (const r of found.rows) records.set(r.id, r.row);
    }

    // Who may decide, per kind of record.
    const canDecide = new Map<string, boolean>();
    for (const entity of entities) {
      const r = await db.execute<{ ok: boolean }>(sql`select app.has_permission(${org}::uuid, 'integrations.run') and app.integration_may_write(${org}::uuid, ${entity}) as ok`);
      canDecide.set(entity, !!r.rows[0]?.ok);
    }

    // Each conflict's Fortress value (from what the change would have replaced, else the record as it is now) and the source's.
    const pending = rows.map((r) => {
      const entity = r.entity_type as EntityType;
      const field = catalogueFor(entity)?.fields.find((f) => f.key === r.field);
      const column = ENTITY_COLUMNS[entity]?.fields[r.field as string]?.column;
      const change = r.fortress_change as Record<string, { from: unknown; to: unknown }> | null;
      const record = records.get(r.internal_id as string);
      const fortressRaw = column && change && column in change ? change[column].from : column && record ? record[column] : null;
      const data = r.source_data as Record<string, unknown>;
      return { r, entity, field, fortressRaw, sourceRaw: data[r.field as string] };
    });

    // Links are stored as ids: show their codes.
    const refIds = new Map<RefKind, Set<string>>();
    for (const p of pending) {
      const kind = p.field?.ref?.kind;
      if (kind && REF_CODES[kind] && typeof p.fortressRaw === 'string') {
        if (!refIds.has(kind)) refIds.set(kind, new Set());
        refIds.get(kind)!.add(p.fortressRaw);
      }
    }
    const refCodes = new Map<string, string>();
    for (const [kind, ids] of refIds) {
      const spec = REF_CODES[kind]!;
      const found = await db.execute<{ id: string; code: string }>(
        sql`select x.id, x.${sql.raw(spec.column)} as code from ${sql.raw(spec.table)} x where x.id = any(string_to_array(${[...ids].join(',')}, ',')::uuid[])`,
      );
      for (const f of found.rows) refCodes.set(`${kind}:${f.id}`, f.code);
    }

    return pending.map(({ r, entity, field, fortressRaw, sourceRaw }) => {
      const record = records.get(r.internal_id as string);
      const kind = field?.ref?.kind;
      const fortressValue =
        kind && REF_CODES[kind] && typeof fortressRaw === 'string' ? (refCodes.get(`${kind}:${fortressRaw}`) ?? 'A record you cannot see') : words(field, fortressRaw);
      // A link the source named by code shows that code; one that resolved to nothing shows as empty.
      const sourceValue = field?.ref && (r.source_data as Record<string, unknown>)[outKey(field)] === null ? null : words(field, sourceRaw);
      return {
        id: r.id as string,
        status: r.status as Conflict['status'],
        entityType: entity,
        record: { id: r.internal_id as string, label: record ? (RECORDS[entity]?.label(record) ?? null) : null },
        externalId: r.external_id as string,
        field: { key: r.field as string, label: field?.label ?? (r.field as string) },
        fortressValue,
        sourceValue,
        applyError: (r.apply_error as string) ?? null,
        connection: { id: r.connection_id as string, name: r.connection_name as string },
        runId: r.run_id as string,
        createdAt: iso(r.created_at)!,
        decidedAt: iso(r.decided_at),
        decidedBy: r.decided_by ? { id: r.decided_by as string, name: (r.decided_by_name as string) ?? 'Unknown user' } : null,
        decisionNote: (r.decision_note as string) ?? null,
        supersededAt: iso(r.superseded_at),
        canDecide: r.status === 'open' && (canDecide.get(entity) ?? false),
      };
    });
  }
}
