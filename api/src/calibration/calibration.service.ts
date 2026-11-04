import { Injectable } from '@nestjs/common';
import { SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import {
  Characteristic,
  CharacteristicQuery,
  CreateCharacteristicBody,
  CreateGaugeBody,
  CreateGaugeTypeBody,
  GaugeDetail,
  GaugeListQuery,
  GaugeSummary,
  GaugeType,
  GaugeTypeQuery,
  HistoryEntry,
  UpdateCharacteristicBody,
  UpdateGaugeBody,
  UpdateGaugeTypeBody,
} from './calibration.schemas';

export type Row = Record<string, unknown>;
export const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
export const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
export const personName = (alias: string) => `nullif(trim(concat_ws(' ', ${alias}.first_name, ${alias}.surname)), '')`;
export const ref = (id: unknown, name: unknown, fallback = '') => (id ? { id: id as string, name: (name as string) ?? fallback } : null);
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `col = value` assignments for the body fields named in `columns` (undefined fields are skipped). */
export const assignments = (body: Record<string, unknown>, columns: Record<string, string>): SQL[] =>
  Object.entries(body)
    .filter(([k, v]) => v !== undefined && k in columns)
    .map(([k, v]) => sql`${sql.raw(columns[k])} = ${v}`);

/** INSERT column list and values from body fields named in `columns`, plus fixed extra columns. */
export const insertParts = (body: Record<string, unknown>, columns: Record<string, string>, extra: Record<string, unknown>) => {
  const entries = [...Object.entries(extra), ...Object.entries(body).filter(([k, v]) => v !== undefined && k in columns).map(([k, v]) => [columns[k], v] as const)];
  return {
    columns: sql.raw(entries.map(([c]) => c).join(', ')),
    values: sql.join(
      entries.map(([, v]) => sql`${v}`),
      sql`, `,
    ),
  };
};

/** Only active and in-calibration gauges are in use (count towards due and overdue). */
export const IN_USE = `g.status in ('active', 'in_calibration')`;
export const DUE_STATE = `case when not (${IN_USE}) then 'not_in_use'
  when g.next_due_on is null then 'not_set'
  when g.next_due_on < current_date then 'overdue'
  when g.next_due_on <= current_date + 30 then 'due_soon'
  else 'ok' end`;

const GAUGE_COLUMNS: Record<string, string> = {
  assetNumber: 'asset_number', description: 'description', gaugeTypeId: 'gauge_type_id', manufacturer: 'manufacturer',
  model: 'model', serialNumber: 'serial_number', siteId: 'site_id', departmentId: 'department_id', location: 'location',
  custodianId: 'custodian_id', rangeMin: 'range_min', rangeMax: 'range_max', unitCode: 'unit_code', resolution: 'resolution',
  calibrationSource: 'calibration_source', supplierId: 'supplier_id', intervalValue: 'interval_value', intervalUnit: 'interval_unit',
  status: 'status', statusReason: 'status_reason', lastCalibratedOn: 'last_calibrated_on', nextDueOn: 'next_due_on',
  commissionedOn: 'commissioned_on', notes: 'notes',
};
const CHARACTERISTIC_COLUMNS: Record<string, string> = {
  sortOrder: 'sort_order', name: 'name', nominal: 'nominal', toleranceMinus: 'tolerance_minus', tolerancePlus: 'tolerance_plus',
  unitCode: 'unit_code', method: 'method', active: 'active',
};
const TYPE_COLUMNS: Record<string, string> = {
  name: 'name', description: 'description', intervalValue: 'interval_value', intervalUnit: 'interval_unit', active: 'active',
};

const SORT_SQL: Record<GaugeListQuery['sort'], string> = {
  assetNumber: 'upper(g.asset_number)',
  description: 'lower(g.description)',
  type: 'lower(t.name)',
  status: `array_position(array['active','in_calibration','quarantined','out_of_service','retired','lost'], g.status)`,
  nextDueOn: 'g.next_due_on',
  lastCalibratedOn: 'g.last_calibrated_on',
  site: 'lower(s.name)',
  location: 'lower(g.location)',
  manufacturer: 'lower(g.manufacturer)',
  serialNumber: 'upper(g.serial_number)',
  lastOutcome: `array_position(array['pass','adjusted','fail'], lc.outcome)`,
  interval: `g.interval_value * case g.interval_unit when 'days' then 1 when 'weeks' then 7 when 'months' then 30 else 365 end`,
  createdAt: 'g.created_at',
};

const GAUGE_SELECT = `
  g.id, g.asset_number, g.description, g.manufacturer, g.model, g.serial_number, g.location, g.range_min, g.range_max,
  g.unit_code, g.resolution, g.calibration_source, g.interval_value, g.interval_unit, g.status, g.status_reason,
  to_char(g.last_calibrated_on, 'YYYY-MM-DD') as last_calibrated_on, to_char(g.next_due_on, 'YYYY-MM-DD') as next_due_on,
  (g.next_due_on - current_date) as days_until_due, ${DUE_STATE} as due_state,
  g.deleted_at, g.created_at,
  t.id as type_id, t.name as type_name, s.id as site_id, s.code as site_code, s.name as site_name,
  d.id as department_id, d.name as department_name,
  g.custodian_id, ${personName('cu')} as custodian_name,
  sp.id as supplier_id, coalesce(sp.display_name, sp.name) as supplier_name,
  lc.outcome as last_outcome, coalesce(cc.n, 0) as calibration_count`;
const GAUGE_FROM = `
  from public.gauges g
  left join public.gauge_types t on t.id = g.gauge_type_id
  left join public.sites s on s.id = g.site_id
  left join public.departments d on d.id = g.department_id
  left join public.profiles cu on cu.id = g.custodian_id
  left join public.suppliers sp on sp.id = g.supplier_id
  left join lateral (
    select c.outcome from public.calibrations c where c.gauge_id = g.id and c.deleted_at is null
    order by c.calibrated_on desc, c.created_at desc limit 1
  ) lc on true
  left join lateral (select count(*) as n from public.calibrations c where c.gauge_id = g.id and c.deleted_at is null) cc on true`;

const toGaugeSummary = (r: Row): GaugeSummary => ({
  id: r.id as string,
  assetNumber: r.asset_number as string,
  description: r.description as string,
  type: ref(r.type_id, r.type_name),
  manufacturer: (r.manufacturer as string) ?? null,
  model: (r.model as string) ?? null,
  serialNumber: (r.serial_number as string) ?? null,
  site: r.site_id ? { id: r.site_id as string, code: r.site_code as string, name: r.site_name as string } : null,
  department: ref(r.department_id, r.department_name),
  location: (r.location as string) ?? null,
  custodian: ref(r.custodian_id, r.custodian_name, 'Unknown user'),
  rangeMin: num(r.range_min),
  rangeMax: num(r.range_max),
  unitCode: (r.unit_code as string) ?? null,
  resolution: num(r.resolution),
  calibrationSource: r.calibration_source as GaugeSummary['calibrationSource'],
  supplier: ref(r.supplier_id, r.supplier_name),
  intervalValue: Number(r.interval_value),
  intervalUnit: r.interval_unit as GaugeSummary['intervalUnit'],
  status: r.status as GaugeSummary['status'],
  statusReason: (r.status_reason as string) ?? null,
  lastCalibratedOn: (r.last_calibrated_on as string) ?? null,
  nextDueOn: (r.next_due_on as string) ?? null,
  daysUntilDue: num(r.days_until_due),
  dueState: r.due_state as GaugeSummary['dueState'],
  lastOutcome: (r.last_outcome as GaugeSummary['lastOutcome']) ?? null,
  calibrationCount: Number(r.calibration_count ?? 0),
  deletedAt: iso(r.deleted_at),
  createdAt: iso(r.created_at)!,
});

export const toCharacteristic = (r: Row): Characteristic => {
  const nominal = Number(r.nominal);
  return {
    id: r.id as string,
    sortOrder: Number(r.sort_order),
    name: r.name as string,
    nominal,
    toleranceMinus: Number(r.tolerance_minus),
    tolerancePlus: Number(r.tolerance_plus),
    lower: Number(r.lower_limit),
    upper: Number(r.upper_limit),
    unitCode: r.unit_code as string,
    method: (r.method as string) ?? null,
    active: r.active as boolean,
    ...('template_id' in r ? { templateId: (r.template_id as string) ?? null } : {}),
  };
};
const CHARACTERISTIC_SELECT = (table: string) =>
  `select k.*, k.nominal - k.tolerance_minus as lower_limit, k.nominal + k.tolerance_plus as upper_limit from public.${table} k`;

/** Gauge columns that hold ids of other records (named in the history). */
const HISTORY_ID_FIELDS = ['gauge_type_id', 'site_id', 'department_id', 'custodian_id', 'supplier_id', 'deleted_by'] as const;

/**
 * Gauges, their characteristics and gauge types of the current organisation. RLS applies the
 * site-scoped calibration.* permissions; the database owns the rules (template copy, locking,
 * soft delete, status bookkeeping) and its messages come back as 409 calibration_rule.
 */
@Injectable()
export class CalibrationService {
  constructor(private readonly database: DatabaseService) {}

  // ---- gauges --------------------------------------------------------------------------------

  list(ctx: RequestContext, q: GaugeListQuery): Promise<{ data: GaugeSummary[]; page: number; pageSize: number; total: number }> {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`g.organisation_id = ${ctx.organisationId!}::uuid`];
      if (q.deleted === 'exclude') where.push(sql`g.deleted_at is null`);
      if (q.deleted === 'only') where.push(sql`g.deleted_at is not null`);
      // Lists go in as one comma-separated text value (an array parameter would be sent as a row).
      if (q.status.length) where.push(sql`g.status = any(string_to_array(${q.status.join(',')}, ','))`);
      if (q.outcome.length) where.push(sql`lc.outcome = any(string_to_array(${q.outcome.join(',')}, ','))`);
      if (q.due.length) {
        const due = q.due.map((d) =>
          d === 'overdue'
            ? sql.raw(`(${IN_USE} and g.next_due_on < current_date)`)
            : d === 'due_30'
              ? sql.raw(`(${IN_USE} and g.next_due_on between current_date and current_date + 30)`)
              : d === 'due_90'
                ? sql.raw(`(${IN_USE} and g.next_due_on between current_date and current_date + 90)`)
                : sql.raw(`(g.next_due_on is null)`),
        );
        where.push(sql`(${sql.join(due, sql` or `)})`);
      }
      if (q.typeId) where.push(sql`g.gauge_type_id = ${q.typeId}::uuid`);
      if (q.siteId) where.push(sql`g.site_id = ${q.siteId}::uuid`);
      if (q.supplierId) where.push(sql`g.supplier_id = ${q.supplierId}::uuid`);
      if (q.source) where.push(sql`g.calibration_source = ${q.source}`);
      if (q.from) where.push(sql`g.next_due_on >= ${q.from}::date`);
      if (q.to) where.push(sql`g.next_due_on <= ${q.to}::date`);
      if (q.q) {
        const like = likePattern(q.q);
        where.push(sql`(g.asset_number ilike ${like} or g.description ilike ${like} or g.serial_number ilike ${like}
          or g.manufacturer ilike ${like} or g.model ilike ${like} or g.location ilike ${like} or t.name ilike ${like})`);
      }
      const order = sql.raw(`${SORT_SQL[q.sort]} ${q.order} nulls last, upper(g.asset_number) ${q.order}`);
      const result = await db.execute<Row>(sql`
        select ${sql.raw(GAUGE_SELECT)}, count(*) over () as total_count
        ${sql.raw(GAUGE_FROM)}
        where ${sql.join(where, sql` and `)}
        order by ${order}
        limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`);
      let total = result.rows.length ? Number(result.rows[0].total_count) : 0;
      if (!result.rows.length && q.page > 1) {
        const count = await db.execute<{ n: string }>(sql`select count(*) as n ${sql.raw(GAUGE_FROM)} where ${sql.join(where, sql` and `)}`);
        total = Number(count.rows[0].n);
      }
      return { data: result.rows.map(toGaugeSummary), page: q.page, pageSize: q.pageSize, total };
    });
  }

  get(ctx: RequestContext, id: string): Promise<GaugeDetail> {
    return this.database.asUser(ctx, (db) => this.loadGauge(db, ctx, id));
  }

  create(ctx: RequestContext, body: CreateGaugeBody): Promise<GaugeDetail> {
    return this.database.asUser(ctx, async (db) => {
      const { columns, values } = insertParts(body, GAUGE_COLUMNS, { organisation_id: ctx.organisationId! });
      const result = await db.execute<{ id: string }>(sql`insert into public.gauges (${columns}) values (${values}) returning id`);
      return this.loadGauge(db, ctx, result.rows[0].id);
    });
  }

  update(ctx: RequestContext, id: string, body: z.infer<typeof UpdateGaugeBody>): Promise<GaugeDetail> {
    return this.changeGauge(ctx, id, sql.join(assignments(body, GAUGE_COLUMNS), sql`, `));
  }

  remove(ctx: RequestContext, id: string, reason: string): Promise<GaugeDetail> {
    return this.changeGauge(ctx, id, sql`deleted_at = now(), delete_reason = ${reason}`);
  }

  restore(ctx: RequestContext, id: string): Promise<GaugeDetail> {
    return this.changeGauge(ctx, id, sql`deleted_at = null`);
  }

  history(ctx: RequestContext, id: string): Promise<z.infer<typeof HistoryEntry>[]> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadGauge(db, ctx, id); // 404 when not visible
      const result = await db.execute<Row>(sql`
        select h.id, h.created_at, h.entity_type, h.entity_id, h.action, h.changed_fields, h.previous_values, h.new_values,
               h.reason, h.source, h.actor_user_id, ${sql.raw(personName('pr'))} as actor_name
        from app.gauge_history(${id}::uuid) h
        left join public.profiles pr on pr.id = h.actor_user_id`);
      const entries = result.rows.map((r) => ({
        id: r.id as string,
        at: iso(r.created_at)!,
        actor: r.actor_user_id ? { id: r.actor_user_id as string, name: (r.actor_name as string) ?? 'Unknown user' } : null,
        entityType: r.entity_type as string,
        entityId: r.entity_id as string,
        action: r.action as string,
        changedFields: (r.changed_fields as string[]) ?? [],
        previous: (r.previous_values as Record<string, unknown>) ?? null,
        current: (r.new_values as Record<string, unknown>) ?? null,
        reason: (r.reason as string) || null,
        source: r.source as string,
        names: {} as Record<string, string>,
      }));
      const ids = new Set<string>();
      for (const e of entries) {
        for (const values of [e.previous, e.current]) {
          for (const f of HISTORY_ID_FIELDS) {
            const v = values?.[f];
            if (typeof v === 'string' && UUID.test(v)) ids.add(v);
          }
        }
      }
      if (ids.size === 0) return entries;
      const named = await db.execute<Row>(sql`
        with ids as (select unnest(string_to_array(${[...ids].join(',')}, ',')::uuid[]) as id)
        select t.id, t.name from public.gauge_types t join ids using (id)
        union all select s.id, s.name from public.sites s join ids using (id)
        union all select d.id, d.name from public.departments d join ids using (id)
        union all select sp.id, coalesce(sp.display_name, sp.name) from public.suppliers sp join ids using (id)
        union all select u.id, ${sql.raw(personName('u'))} from public.profiles u join ids using (id)`);
      const names = new Map(named.rows.filter((r) => r.name).map((r) => [r.id as string, r.name as string]));
      for (const e of entries) {
        for (const values of [e.previous, e.current]) {
          for (const f of HISTORY_ID_FIELDS) {
            const v = values?.[f];
            if (typeof v === 'string' && names.has(v)) e.names[v] = names.get(v)!;
          }
        }
      }
      return entries;
    });
  }

  // ---- gauge characteristics -----------------------------------------------------------------

  listGaugeCharacteristics(ctx: RequestContext, gaugeId: string, q: z.infer<typeof CharacteristicQuery>): Promise<Characteristic[]> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertGaugeVisible(db, ctx, gaugeId);
      const result = await db.execute<Row>(sql`
        ${sql.raw(CHARACTERISTIC_SELECT('gauge_characteristics'))}
        where k.gauge_id = ${gaugeId}::uuid ${q.includeInactive ? sql`` : sql`and k.active`}
        order by k.sort_order, k.created_at`);
      return result.rows.map(toCharacteristic);
    });
  }

  createGaugeCharacteristic(ctx: RequestContext, gaugeId: string, body: z.infer<typeof CreateCharacteristicBody>): Promise<Characteristic> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertGaugeVisible(db, ctx, gaugeId);
      const sortOrder =
        body.sortOrder ??
        Number((await db.execute<{ n: number }>(sql`select coalesce(max(sort_order), 0) + 1 as n from public.gauge_characteristics where gauge_id = ${gaugeId}::uuid`)).rows[0].n);
      const { columns, values } = insertParts({ ...body, sortOrder }, CHARACTERISTIC_COLUMNS, { organisation_id: ctx.organisationId!, gauge_id: gaugeId });
      const result = await db.execute<{ id: string }>(sql`insert into public.gauge_characteristics (${columns}) values (${values}) returning id`);
      return this.loadCharacteristic(db, ctx, 'gauge_characteristics', result.rows[0].id);
    });
  }

  updateGaugeCharacteristic(ctx: RequestContext, id: string, body: z.infer<typeof UpdateCharacteristicBody>): Promise<Characteristic> {
    return this.changeCharacteristic(ctx, 'gauge_characteristics', id, body);
  }

  // ---- gauge types ---------------------------------------------------------------------------

  listTypes(ctx: RequestContext, q: z.infer<typeof GaugeTypeQuery>): Promise<z.infer<typeof GaugeType>[]> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute<Row>(sql`${sql.raw(TYPE_SELECT)}
        where t.organisation_id = ${ctx.organisationId!}::uuid ${q.includeInactive ? sql`` : sql`and t.active`}
        order by lower(t.name)`);
      return result.rows.map(toType);
    });
  }

  createType(ctx: RequestContext, body: z.infer<typeof CreateGaugeTypeBody>): Promise<z.infer<typeof GaugeType>> {
    return this.database.asUser(ctx, async (db) => {
      const { columns, values } = insertParts(body, TYPE_COLUMNS, { organisation_id: ctx.organisationId! });
      const result = await db.execute<{ id: string }>(sql`insert into public.gauge_types (${columns}) values (${values}) returning id`);
      return this.loadType(db, ctx, result.rows[0].id);
    });
  }

  updateType(ctx: RequestContext, id: string, body: z.infer<typeof UpdateGaugeTypeBody>): Promise<z.infer<typeof GaugeType>> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute(sql`
        update public.gauge_types set ${sql.join(assignments(body, TYPE_COLUMNS), sql`, `)}
        where id = ${id}::uuid and organisation_id = ${ctx.organisationId!}::uuid returning id`);
      if (!result.rows.length) throw ApiError.notFound('gauge_type_not_found', 'Gauge type not found');
      return this.loadType(db, ctx, id);
    });
  }

  listTypeCharacteristics(ctx: RequestContext, typeId: string, q: z.infer<typeof CharacteristicQuery>): Promise<Characteristic[]> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadType(db, ctx, typeId);
      const result = await db.execute<Row>(sql`
        ${sql.raw(CHARACTERISTIC_SELECT('gauge_type_characteristics'))}
        where k.gauge_type_id = ${typeId}::uuid ${q.includeInactive ? sql`` : sql`and k.active`}
        order by k.sort_order, k.created_at`);
      return result.rows.map(toCharacteristic);
    });
  }

  createTypeCharacteristic(ctx: RequestContext, typeId: string, body: z.infer<typeof CreateCharacteristicBody>): Promise<Characteristic> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadType(db, ctx, typeId);
      const sortOrder =
        body.sortOrder ??
        Number((await db.execute<{ n: number }>(sql`select coalesce(max(sort_order), 0) + 1 as n from public.gauge_type_characteristics where gauge_type_id = ${typeId}::uuid`)).rows[0].n);
      const { columns, values } = insertParts({ ...body, sortOrder }, CHARACTERISTIC_COLUMNS, { organisation_id: ctx.organisationId!, gauge_type_id: typeId });
      const result = await db.execute<{ id: string }>(sql`insert into public.gauge_type_characteristics (${columns}) values (${values}) returning id`);
      return this.loadCharacteristic(db, ctx, 'gauge_type_characteristics', result.rows[0].id);
    });
  }

  updateTypeCharacteristic(ctx: RequestContext, id: string, body: z.infer<typeof UpdateCharacteristicBody>): Promise<Characteristic> {
    return this.changeCharacteristic(ctx, 'gauge_type_characteristics', id, body);
  }

  // ---- internals -----------------------------------------------------------------------------

  async assertGaugeVisible(db: Db, ctx: RequestContext, gaugeId: string) {
    const found = await db.execute(sql`select 1 from public.gauges where id = ${gaugeId}::uuid and organisation_id = ${ctx.organisationId!}::uuid`);
    if (!found.rows.length) throw ApiError.notFound('gauge_not_found', 'Gauge not found');
  }

  private changeGauge(ctx: RequestContext, id: string, set: SQL): Promise<GaugeDetail> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute(sql`
        update public.gauges set ${set} where id = ${id}::uuid and organisation_id = ${ctx.organisationId!}::uuid returning id`);
      if (!result.rows.length) {
        // Visible but not changeable (e.g. a site the caller may only read) is a permission problem.
        await this.assertGaugeVisible(db, ctx, id);
        throw ApiError.forbidden();
      }
      return this.loadGauge(db, ctx, id);
    });
  }

  private changeCharacteristic(
    ctx: RequestContext,
    table: 'gauge_characteristics' | 'gauge_type_characteristics',
    id: string,
    body: z.infer<typeof UpdateCharacteristicBody>,
  ): Promise<Characteristic> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute(sql`
        update ${sql.raw(`public.${table}`)} set ${sql.join(assignments(body, CHARACTERISTIC_COLUMNS), sql`, `)}
        where id = ${id}::uuid and organisation_id = ${ctx.organisationId!}::uuid returning id`);
      if (!result.rows.length) throw ApiError.notFound('characteristic_not_found', 'Characteristic not found');
      return this.loadCharacteristic(db, ctx, table, id);
    });
  }

  private async loadCharacteristic(db: Db, ctx: RequestContext, table: string, id: string): Promise<Characteristic> {
    const result = await db.execute<Row>(sql`${sql.raw(CHARACTERISTIC_SELECT(table))} where k.id = ${id}::uuid and k.organisation_id = ${ctx.organisationId!}::uuid`);
    if (!result.rows.length) throw ApiError.notFound('characteristic_not_found', 'Characteristic not found');
    return toCharacteristic(result.rows[0]);
  }

  private async loadType(db: Db, ctx: RequestContext, id: string): Promise<z.infer<typeof GaugeType>> {
    const result = await db.execute<Row>(sql`${sql.raw(TYPE_SELECT)} where t.id = ${id}::uuid and t.organisation_id = ${ctx.organisationId!}::uuid`);
    if (!result.rows.length) throw ApiError.notFound('gauge_type_not_found', 'Gauge type not found');
    return toType(result.rows[0]);
  }

  async loadGauge(db: Db, ctx: RequestContext, id: string): Promise<GaugeDetail> {
    const result = await db.execute<Row>(sql`
      select ${sql.raw(GAUGE_SELECT)}, to_char(g.commissioned_on, 'YYYY-MM-DD') as commissioned_on, g.notes, g.status_changed_at,
             g.delete_reason, g.updated_at,
             g.created_by, ${sql.raw(personName('pc'))} as created_by_name,
             g.deleted_by, ${sql.raw(personName('pdl'))} as deleted_by_name
      ${sql.raw(GAUGE_FROM)}
      left join public.profiles pc on pc.id = g.created_by
      left join public.profiles pdl on pdl.id = g.deleted_by
      where g.organisation_id = ${ctx.organisationId!}::uuid and g.id = ${id}::uuid`);
    const r = result.rows[0];
    if (!r) throw ApiError.notFound('gauge_not_found', 'Gauge not found');
    return {
      ...toGaugeSummary(r),
      commissionedOn: (r.commissioned_on as string) ?? null,
      notes: (r.notes as string) ?? null,
      statusChangedAt: iso(r.status_changed_at),
      createdBy: ref(r.created_by, r.created_by_name, 'Unknown user'),
      deletedBy: ref(r.deleted_by, r.deleted_by_name, 'Unknown user'),
      deleteReason: (r.delete_reason as string) ?? null,
      updatedAt: iso(r.updated_at)!,
    };
  }
}

const TYPE_SELECT = `
  select t.*,
    (select count(*) from public.gauge_type_characteristics k where k.gauge_type_id = t.id and k.active) as characteristic_count,
    (select count(*) from public.gauges g where g.gauge_type_id = t.id and g.deleted_at is null) as gauge_count
  from public.gauge_types t`;

const toType = (r: Row): z.infer<typeof GaugeType> => ({
  id: r.id as string,
  name: r.name as string,
  description: (r.description as string) ?? null,
  intervalValue: Number(r.interval_value),
  intervalUnit: r.interval_unit as z.infer<typeof GaugeType>['intervalUnit'],
  active: r.active as boolean,
  characteristicCount: Number(r.characteristic_count ?? 0),
  gaugeCount: Number(r.gauge_count ?? 0),
});
