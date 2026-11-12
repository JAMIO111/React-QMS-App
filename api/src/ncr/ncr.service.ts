import { attachCustomValues, customFilterSql, customValuesOf, writeCustomValues } from '../custom-fields/custom-values';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { LINK_COLUMNS, linkJoins, toLinks } from '../production/production-links';
import { DatabaseService, Db } from '../database/database.service';
import { ncrClassifications, nonconformances } from '../database/schema';
import {
  Classification,
  ClassificationQuery,
  CreateClassificationBody,
  ChangeSourceBody,
  CreateNcrBody,
  HistoryEntry,
  NcrDetail,
  NcrListQuery,
  NcrNewDefaults,
  NcrNewDefaultsQuery,
  NcrRanges,
  NcrRangesQuery,
  NcrSummary,
  NCR_SOURCES,
  NCR_SOURCE_LABELS,
  SetSourceCategoryBody,
  SourceCategoryList,
  TransitionBody,
  UpdateClassificationBody,
  UpdateNcrBody,
} from './ncr.schemas';

/**
 * Sorts references by their running number, not as text: NC numbers moved from three digits to four (SNC-26-010, then SNC-26-0011), and
 * as text -0011 would come before -010. The part before the number (prefix and year) sorts as text, the number as a number.
 */
const REFERENCE_ORDER = `regexp_replace(n.reference, '[0-9]+$', '') || lpad(coalesce(substring(n.reference from '[0-9]+$'), ''), 12, '0')`;
const STAGE_ORDER = `array_position(array['draft','open','contained','investigating','dispositioned','awaiting_closure','closed','cancelled'], n.stage)`;
const SORT_SQL: Record<NcrListQuery['sort'], string> = {
  reference: REFERENCE_ORDER,
  detectedAt: 'n.detected_at',
  title: 'lower(n.title)',
  stage: STAGE_ORDER,
  severity: `array_position(array['critical','major','minor'], n.severity)`,
  quantityAffected: 'n.quantity_affected',
  partNumber: 'upper(p.part_number)',
  customer: 'lower(coalesce(c.display_name, c.name))',
  supplier: 'lower(coalesce(s.display_name, s.name))',
  failureMode: 'lower(fm.name)',
  source: 'n.source',
  category: 'lower(cat.name)',
  totalCost: 'coalesce(tc.total, 0)',
  capaCount: 'coalesce(cl.n_capa, 0)',
  createdAt: 'n.created_at',
  raisedBy: "lower(nullif(trim(concat_ws(' ', rb.first_name, rb.surname)), ''))",
  detectedByEmployee: "lower(nullif(trim(concat_ws(' ', de.first_name, de.surname)), ''))",
  responsibleDepartment: 'lower(rd.name)',
};

const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
/** NCR columns that hold ids of other records (named in the history). */
const HISTORY_ID_FIELDS = [
  'site_id', 'part_id', 'part_revision_id', 'customer_id', 'supplier_id', 'detection_process_id', 'causal_process_id',
  'failure_mode_id', 'sub_failure_mode_id', 'category_id', 'responsible_employee_id', 'owner_id', 'detected_by', 'closed_by', 'deleted_by',
  'detected_by_employee_id', 'responsible_department_id',
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const personName = (alias: string) => `nullif(trim(concat_ws(' ', ${alias}.first_name, ${alias}.surname)), '')`;

/** Columns shared by list and detail. */
const SELECT_SUMMARY = `
  n.id, n.reference, n.source, n.stage, n.severity, n.title, to_char(n.detected_at, 'YYYY-MM-DD') as detected_at,
  n.quantity_affected, n.work_order, n.purchase_order, n.customer_reference, n.deleted_at, n.created_at,
  p.id as part_id, p.part_number, p.name as part_name, r.revision,
  c.id as customer_id, coalesce(c.display_name, c.name) as customer_name,
  s.id as supplier_id, coalesce(s.display_name, s.name) as supplier_name,
  fm.id as fm_id, fm.name as fm_name, sfm.id as sfm_id, sfm.name as sfm_name, cp.id as cp_id, cp.name as cp_name, cat.id as cat_id, cat.name as cat_name,
  coalesce(tc.total, 0) as total_cost, os.base_currency,
  coalesce(cl.n_capa, 0) as capa_count, case when cl.n_capa = 1 then cl.capa_id end as capa_id, case when cl.n_capa = 1 then cl.capa_reference end as capa_reference,
  n.created_by as raised_by_id, nullif(trim(concat_ws(' ', rb.first_name, rb.surname)), '') as raised_by_name,
  de.id as detected_employee_id, nullif(trim(concat_ws(' ', de.first_name, de.surname)), '') as detected_employee_name,
  rd.id as responsible_department_id, rd.name as responsible_department_name`;
const FROM = `
  from public.nonconformances n
  left join public.parts p on p.id = n.part_id
  left join public.part_revisions r on r.id = n.part_revision_id
  left join public.customers c on c.id = n.customer_id
  left join public.suppliers s on s.id = n.supplier_id
  left join public.ncr_classifications fm on fm.id = n.failure_mode_id
  left join public.ncr_classifications sfm on sfm.id = n.sub_failure_mode_id
  left join public.machines cp on cp.id = n.causal_process_id
  left join public.ncr_classifications cat on cat.id = n.category_id
  left join public.organisation_settings os on os.organisation_id = n.organisation_id
  -- Who raised it (the person who created the record).
  left join public.profiles rb on rb.id = n.created_by
  -- Who found it (Employees register; hidden without master_data.read, like the responsible employee) and the responsible department.
  left join public."Employees" de on de.id = n.detected_by_employee_id
  left join public.departments rd on rd.id = n.responsible_department_id
  -- Total of the NCR's costs that are not deleted, in the organisation's base currency.
  left join lateral (
    select sum(k.gross_base) as total from public.ncr_costs k where k.nonconformance_id = n.id and k.deleted_at is null
  ) tc on true
  -- The 8Ds this is linked to (live links; only those the caller may read).
  left join lateral (
    select count(*)::int as n_capa, (array_agg(c8.id order by c8.reference))[1] as capa_id, (array_agg(c8.reference order by c8.reference))[1] as capa_reference
    from public.capa_ncr_links l join public.capas c8 on c8.id = l.capa_id
    where l.nonconformance_id = n.id and l.ended_at is null
  ) cl on true`;

type Row = Record<string, unknown>;
const ref = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? '' } : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

const toSummary = (r: Row): NcrSummary => ({
  id: r.id as string,
  reference: r.reference as string,
  source: r.source as string,
  stage: r.stage as NcrSummary['stage'],
  severity: (r.severity as NcrSummary['severity']) ?? null,
  title: r.title as string,
  detectedAt: r.detected_at as string,
  quantityAffected: num(r.quantity_affected),
  part: r.part_id ? { id: r.part_id as string, partNumber: r.part_number as string, name: r.part_name as string, revision: (r.revision as string) ?? null } : null,
  category: ref(r.cat_id, r.cat_name),
  customer: ref(r.customer_id, r.customer_name),
  supplier: ref(r.supplier_id, r.supplier_name),
  workOrder: (r.work_order as string) ?? null,
  purchaseOrder: (r.purchase_order as string) ?? null,
  customerReference: (r.customer_reference as string) ?? null,
  failureMode: ref(r.fm_id, r.fm_name),
  subFailureMode: ref(r.sfm_id, r.sfm_name),
  causalProcess: ref(r.cp_id, r.cp_name),
  totalCost: Number(r.total_cost ?? 0),
  costCurrency: (r.base_currency as string) ?? 'GBP',
  capaCount: Number(r.capa_count ?? 0),
  capa: r.capa_id ? { id: r.capa_id as string, reference: r.capa_reference as string } : null,
  raisedBy: r.raised_by_id ? { id: r.raised_by_id as string, name: (r.raised_by_name as string) ?? '' } : null,
  detectedByEmployee: ref(r.detected_employee_id, r.detected_employee_name),
  responsibleDepartment: ref(r.responsible_department_id, r.responsible_department_name),
  deletedAt: iso(r.deleted_at),
  createdAt: iso(r.created_at)!,
});

/** API body (camelCase, numbers) → table columns. */
const toColumns = (body: Partial<z.infer<typeof UpdateNcrBody>>) => {
  const out: Record<string, unknown> = { ...body };
  for (const k of ['quantityAffected', 'quantityInspected'] as const) {
    if (k in body) out[k] = body[k] === null || body[k] === undefined ? null : String(body[k]);
  }
  return out as Partial<typeof nonconformances.$inferInsert>;
};

/**
 * Non-conformances (internal, customer, supplier) of the current organisation. RLS applies the
 * site-scoped ncr.* permissions, so rows a user may not see behave as missing (404). The database
 * owns the rules (reference generation, stage machine, locking, soft delete, events); errors come
 * back as 409 with a readable message.
 */
/** The sites the caller may raise a non-conformance at, the one a new NC starts with marked (app.my_ncr_site_choices). */
const siteChoices = async (db: Db, ctx: RequestContext) =>
  (await db.execute<{ id: string; code: string; name: string; suggested: boolean }>(sql`
    select id, code, name, suggested from app.my_ncr_site_choices(${ctx.organisationId!}::uuid)`)).rows;

@Injectable()
export class NcrService {
  constructor(private readonly database: DatabaseService) {}

  list(ctx: RequestContext, q: NcrListQuery, custom: Record<string, string> = {}): Promise<{ data: NcrSummary[]; page: number; pageSize: number; total: number }> {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`n.organisation_id = ${ctx.organisationId!}::uuid`];
      if (q.source.length) where.push(sql`n.source = any(string_to_array(${q.source.join(',')}, ','))`);
      if (q.categoryId) where.push(sql`n.category_id = ${q.categoryId}::uuid`);
      if (q.uncategorised === 'true') where.push(sql`n.category_id is null`);
      // Lists go in as one comma-separated text value (an array parameter would be sent as a row).
      if (q.stage.length) where.push(sql`n.stage = any(string_to_array(${q.stage.join(',')}, ','))`);
      if (q.deleted === 'exclude') where.push(sql`n.deleted_at is null`);
      if (q.deleted === 'only') where.push(sql`n.deleted_at is not null`);
      if (q.failureModeId) where.push(sql`n.failure_mode_id = ${q.failureModeId}::uuid`);
      if (q.subFailureModeId) where.push(sql`n.sub_failure_mode_id = ${q.subFailureModeId}::uuid`);
      if (q.partId) where.push(sql`n.part_id = ${q.partId}::uuid`);
      if (q.customerId) where.push(sql`n.customer_id = ${q.customerId}::uuid`);
      if (q.supplierId) where.push(sql`n.supplier_id = ${q.supplierId}::uuid`);
      if (q.productionOrderId) {
        where.push(sql`(n.production_order_id = ${q.productionOrderId}::uuid or exists (select 1 from public.ncr_affected_lots al join public.lots l on l.id = al.lot_id
          where al.nonconformance_id = n.id and al.removed_at is null and l.production_order_id = ${q.productionOrderId}::uuid))`);
      }
      if (q.lotId) {
        where.push(sql`(n.lot_id = ${q.lotId}::uuid or exists (select 1 from public.ncr_affected_lots al where al.nonconformance_id = n.id and al.removed_at is null and al.lot_id = ${q.lotId}::uuid))`);
      }
      if (q.from) where.push(sql`n.detected_at >= ${q.from}::date`);
      if (q.to) where.push(sql`n.detected_at <= ${q.to}::date`);
      // The day it was raised in the caller's time zone (the request's TimeZone setting).
      if (q.raisedFrom) where.push(sql`n.created_at >= ${q.raisedFrom}::date::timestamptz`);
      if (q.raisedTo) where.push(sql`n.created_at < (${q.raisedTo}::date + 1)::timestamptz`);
      if (q.responsibleDepartmentId) where.push(sql`n.responsible_department_id = ${q.responsibleDepartmentId}::uuid`);
      if (q.detectedByEmployeeId) where.push(sql`n.detected_by_employee_id = ${q.detectedByEmployeeId}::uuid`);
      if (q.severity.length) where.push(sql`n.severity = any(string_to_array(${q.severity.join(',')}, ','))`);
      if (q.costMin !== undefined) where.push(sql`coalesce(tc.total, 0) >= ${q.costMin}`);
      if (q.costMax !== undefined) where.push(sql`coalesce(tc.total, 0) <= ${q.costMax}`);
      if (q.qtyMin !== undefined) where.push(sql`coalesce(n.quantity_affected, 0) >= ${q.qtyMin}`);
      if (q.qtyMax !== undefined) where.push(sql`coalesce(n.quantity_affected, 0) <= ${q.qtyMax}`);
      if (q.q) {
        const like = likePattern(q.q);
        where.push(sql`(n.reference ilike ${like} or n.title ilike ${like} or n.description ilike ${like} or n.work_order ilike ${like}
          or n.purchase_order ilike ${like} or n.customer_reference ilike ${like} or p.part_number ilike ${like}
          or c.name ilike ${like} or c.display_name ilike ${like} or s.name ilike ${like} or s.display_name ilike ${like} or fm.name ilike ${like})`);
      }
      const cf = await customFilterSql(db, ctx.organisationId!, 'nonconformance', sql`n.id`, custom);
      if (cf) where.push(cf);
      const order = sql.raw(`${SORT_SQL[q.sort]} ${q.order} nulls last, ${REFERENCE_ORDER} ${q.order}`);
      const result = await db.execute<Row>(sql`
        select ${sql.raw(SELECT_SUMMARY)}, count(*) over () as total_count
        ${sql.raw(FROM)}
        where ${sql.join(where, sql` and `)}
        order by ${order}
        limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`);
      let total = result.rows.length ? Number(result.rows[0].total_count) : 0;
      if (!result.rows.length && q.page > 1) {
        const count = await db.execute<{ n: string }>(sql`select count(*) as n ${sql.raw(FROM)} where ${sql.join(where, sql` and `)}`);
        total = Number(count.rows[0].n);
      }
      return { data: await attachCustomValues(db, 'nonconformance', result.rows.map(toSummary)), page: q.page, pageSize: q.pageSize, total };
    });
  }

  /** Highest total cost and quantity among the register's (non-deleted) NCRs. */
  ranges(ctx: RequestContext, q: z.infer<typeof NcrRangesQuery>): Promise<z.infer<typeof NcrRanges>> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute<Row>(sql`
        select coalesce(max(coalesce(tc.total, 0)), 0) as cost_max, coalesce(max(n.quantity_affected), 0) as qty_max,
               (select base_currency from public.organisation_settings where organisation_id = ${ctx.organisationId!}::uuid) as base_currency
        ${sql.raw(FROM)}
        where n.organisation_id = ${ctx.organisationId!}::uuid and n.deleted_at is null
          ${q.source.length ? sql`and n.source = any(string_to_array(${q.source.join(',')}, ','))` : sql``}`);
      const r = result.rows[0] ?? {};
      return { cost: { max: Number(r.cost_max ?? 0) }, quantity: { max: Number(r.qty_max ?? 0) }, baseCurrency: (r.base_currency as string) ?? 'GBP' };
    });
  }

  get(ctx: RequestContext, id: string): Promise<NcrDetail> {
    return this.database.asUser(ctx, (db) => this.load(db, ctx, id));
  }

  create(ctx: RequestContext, body: CreateNcrBody): Promise<NcrDetail> {
    return this.database.asUser(ctx, async (db) => {
      const { open, source, customValues, ...rest } = body;
      // No site given: someone who may raise NCs at one site only raises it there (otherwise the database would refuse an NC with no site).
      if (!rest.siteId) {
        const choices = await siteChoices(db, ctx);
        if (choices.length === 1) rest.siteId = choices[0].id;
      }
      const [row] = await db
        .insert(nonconformances)
        .values({ ...toColumns(rest), title: rest.title, organisationId: ctx.organisationId!, source, stage: open ? 'open' : 'draft', detectedBy: ctx.user.id })
        .returning({ id: nonconformances.id });
      await writeCustomValues(db, 'nonconformance', row.id, customValues);
      return this.load(db, ctx, row.id);
    });
  }

  /** What a non-conformance raised by hand starts with: severity minor, the source's suggested category, the person's site and the sites they may choose. */
  newDefaults(ctx: RequestContext, q: z.infer<typeof NcrNewDefaultsQuery>): Promise<z.infer<typeof NcrNewDefaults>> {
    return this.database.asUser(ctx, async (db) => {
      const choices = await siteChoices(db, ctx);
      const [counts] = (await db.execute<{ sites: number }>(sql`
        select count(*)::int as sites from public.sites where organisation_id = ${ctx.organisationId!}::uuid and active`)).rows;
      const [category] = (await db.execute<{ id: string; name: string }>(sql`
        select c.id, c.name from public.ncr_source_categories s
          join public.ncr_classifications c on c.id = s.category_id and c.active
         where s.organisation_id = ${ctx.organisationId!}::uuid and s.source = ${q.source}`)).rows;
      const [me] = (await db.execute<{ id: string; name: string | null }>(sql`select id, name from app.my_employee(${ctx.organisationId!}::uuid)`)).rows;
      return {
        detectedBy: me ? { id: me.id, name: me.name ?? '' } : null,
        source: q.source,
        severity: 'minor' as const,
        category: category ? { id: category.id, name: category.name } : null,
        site: {
          suggestedId: choices.find((c) => c.suggested)?.id ?? null,
          choices: choices.map(({ id, code, name }) => ({ id, code, name })),
          organisationHasOneSite: Number(counts?.sites ?? 0) === 1,
        },
      };
    });
  }

  /** The suggested category of every source, in the fixed order of sources. */
  sourceCategories(ctx: RequestContext): Promise<z.infer<typeof SourceCategoryList>> {
    return this.database.asUser(ctx, (db) => this.loadSourceCategories(db, ctx));
  }

  setSourceCategory(ctx: RequestContext, body: z.infer<typeof SetSourceCategoryBody>): Promise<z.infer<typeof SourceCategoryList>> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute(sql`
        update public.ncr_source_categories set category_id = ${body.categoryId}::uuid
         where organisation_id = ${ctx.organisationId!}::uuid and source = ${body.source} returning id`);
      if (!result.rows.length) throw ApiError.notFound('source_not_found', 'That source has no suggestion to change');
      return this.loadSourceCategories(db, ctx);
    });
  }

  private async loadSourceCategories(db: Db, ctx: RequestContext): Promise<z.infer<typeof SourceCategoryList>> {
    const rows = (await db.execute<{ source: string; category_id: string | null; name: string | null; active: boolean | null }>(sql`
      select s.source, c.id as category_id, c.name, c.active
        from public.ncr_source_categories s left join public.ncr_classifications c on c.id = s.category_id
       where s.organisation_id = ${ctx.organisationId!}::uuid`)).rows;
    const [perm] = (await db.execute<{ manage: boolean }>(sql`select app.has_permission(${ctx.organisationId!}::uuid, 'lookups.manage') as manage`)).rows;
    const bySource = new Map(rows.map((r) => [r.source, r]));
    return {
      data: NCR_SOURCES.map((source) => {
        const r = bySource.get(source);
        return {
          source,
          label: NCR_SOURCE_LABELS[source],
          category: r?.category_id ? { id: r.category_id, name: r.name!, active: !!r.active } : null,
        };
      }),
      canManage: !!perm?.manage,
    };
  }

  update(ctx: RequestContext, id: string, body: z.infer<typeof UpdateNcrBody>): Promise<NcrDetail> {
    return this.change(ctx, id, toColumns(body));
  }

  async transition(ctx: RequestContext, id: string, body: z.infer<typeof TransitionBody>): Promise<NcrDetail> {
    return this.database.asUser(ctx, async (db) => {
      const current = await this.load(db, ctx, id);
      if (current.stage === body.to) throw new ApiError(409, 'ncr_rule', `This non-conformance is already ${body.to.replace('_', ' ')}`);
      await this.update1(db, ctx, id, { stage: body.to, stageReason: body.reason || null });
      return this.load(db, ctx, id);
    });
  }

  /** Change the source with a reason: the database function checks the permission, the reason and what a customer / supplier needs, and writes the history. */
  changeSource(ctx: RequestContext, id: string, body: ChangeSourceBody): Promise<NcrDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      await db.execute(sql`select app.change_ncr_source(${id}::uuid, ${body.source}, ${body.reason})`);
      return this.load(db, ctx, id);
    });
  }

  remove(ctx: RequestContext, id: string, reason: string): Promise<NcrDetail> {
    return this.change(ctx, id, { deletedAt: new Date(), deleteReason: reason });
  }

  restore(ctx: RequestContext, id: string): Promise<NcrDetail> {
    return this.change(ctx, id, { deletedAt: null });
  }

  history(ctx: RequestContext, id: string): Promise<z.infer<typeof HistoryEntry>[]> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id); // 404 when not visible
      const result = await db.execute<Row>(sql`
        select h.id, h.created_at, h.action, h.changed_fields, h.previous_values, h.new_values, h.reason, h.source,
               h.actor_user_id, ${sql.raw(personName('pr'))} as actor_name
        from app.ncr_history(${id}::uuid) h
        left join public.profiles pr on pr.id = h.actor_user_id`);
      const entries = result.rows.map((r) => ({
        id: r.id as string,
        at: iso(r.created_at)!,
        actor: r.actor_user_id ? { id: r.actor_user_id as string, name: (r.actor_name as string) ?? 'Unknown user' } : null,
        action: r.action as string,
        changedFields: (r.changed_fields as string[]) ?? [],
        previous: (r.previous_values as Record<string, unknown>) ?? null,
        current: (r.new_values as Record<string, unknown>) ?? null,
        reason: (r.reason as string) || null,
        source: r.source as string,
        names: {} as Record<string, string>,
      }));
      // Linked records are stored as ids in the audit trail; give the history their names.
      const ids = new Set<string>();
      for (const e of entries) {
        for (const values of [e.previous, e.current]) {
          for (const f of HISTORY_ID_FIELDS) {
            const v = values?.[f];
            if (typeof v === 'string' && UUID.test(v)) ids.add(v);
          }
        }
      }
      const linked = await this.linkEntries(db, id);
      if (ids.size === 0) return this.merge(entries, linked);
      const list = [...ids].join(',');
      const named = await db.execute<Row>(sql`
        with ids as (select unnest(string_to_array(${list}, ',')::uuid[]) as id)
        select p.id, concat_ws(' · ', p.part_number, p.name) as name from public.parts p join ids using (id)
        union all select r.id, concat(p.part_number, ' rev ', r.revision) from public.part_revisions r join ids using (id) join public.parts p on p.id = r.part_id
        union all select c.id, coalesce(c.display_name, c.name) from public.customers c join ids using (id)
        union all select s.id, coalesce(s.display_name, s.name) from public.suppliers s join ids using (id)
        union all select k.id, k.name from public.ncr_classifications k join ids using (id)
        union all select mc.id, mc.name from public.machines mc join ids using (id)
        union all select t.id, t.name from public.sites t join ids using (id)
        union all select e.id, ${sql.raw(personName('e'))} from public."Employees" e join ids using (id)
        union all select d.id, d.name from public.departments d join ids using (id)
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
      return this.merge(entries, linked);
    });
  }

  private merge(entries: z.infer<typeof HistoryEntry>[], linked: z.infer<typeof HistoryEntry>[]) {
    return [...entries, ...linked].sort((a, b) => a.at.localeCompare(b.at));
  }

  /**
   * Inspection readings put on this NC, from the audit trail of the links: one entry per transaction (raising the NC
   * from the inspection, or adding readings later). Readings of inspections the reader may not see are only counted.
   */
  private async linkEntries(db: Db, id: string): Promise<z.infer<typeof HistoryEntry>[]> {
    const events = await db.execute<Row>(sql`
      select l.id, l.created_at, l.actor_user_id, l.transaction_id::text as tx, l.inspection_record_id, l.measurement_id, l.raised_with_ncr,
             ${sql.raw(personName('pr'))} as actor_name
      from app.ncr_link_history(${id}::uuid) l left join public.profiles pr on pr.id = l.actor_user_id`);
    if (!events.rows.length) return [];
    const measurementIds = events.rows.map((e) => e.measurement_id as string | null).filter((x): x is string => !!x);
    const recordIds = [...new Set(events.rows.map((e) => e.inspection_record_id as string))];
    const readings = measurementIds.length
      ? await db.execute<Row>(sql`
          select m.id, q.name, s.sample_number, m.value_numeric::text as value_text, m.value_pass, m.value_count, q.unit_code
          from public.inspection_measurements m
          join public.resolved_inspection_requirements q on q.id = m.requirement_id
          join public.inspection_samples s on s.id = m.sample_id
          where m.id = any (string_to_array(${measurementIds.join(',')}, ',')::uuid[])`)
      : { rows: [] as Row[] };
    const byId = new Map(readings.rows.map((r) => [r.id as string, r]));
    const records = await db.execute<Row>(sql`select id, reference from public.inspection_records where id = any (string_to_array(${recordIds.join(',')}, ',')::uuid[])`);
    const reference = new Map(records.rows.map((r) => [r.id as string, r.reference as string]));

    const groups = new Map<string, Row[]>();
    for (const e of events.rows) groups.set(e.tx as string, [...(groups.get(e.tx as string) ?? []), e]);
    return [...groups.values()].map((group) => {
      const first = group[0];
      const at = iso(first.created_at)!;
      const recordId = first.inspection_record_id as string;
      const shown = group.flatMap((e) => (e.measurement_id && byId.has(e.measurement_id as string) ? [byId.get(e.measurement_id as string)!] : []));
      const whole = group.every((e) => !e.measurement_id);
      return {
        id: first.id as string,
        at,
        actor: first.actor_user_id ? { id: first.actor_user_id as string, name: (first.actor_name as string) ?? 'Unknown user' } : null,
        action: 'readings_linked',
        changedFields: [],
        previous: null,
        current: null,
        reason: null,
        source: 'inspection',
        names: {},
        linked: {
          kind: first.raised_with_ncr === true ? ('raised' as const) : ('added' as const),
          inspection: reference.has(recordId) ? { id: recordId, reference: reference.get(recordId)! } : null,
          readings: shown.map((r) => ({
            id: r.id as string,
            characteristic: r.name as string,
            sampleNumber: Number(r.sample_number),
            value: r.value_pass !== null && r.value_pass !== undefined ? (r.value_pass ? 'Pass' : 'Fail') : r.value_count !== null && r.value_count !== undefined ? `${r.value_count} ${Number(r.value_count) === 1 ? 'defect' : 'defects'}` : `${r.value_text}${r.unit_code ? ` ${r.unit_code}` : ''}`,
          })),
          hidden: group.filter((e) => e.measurement_id).length - shown.length,
          wholeInspection: whole,
        },
      };
    });
  }

  // ---- classifications and people --------------------------------------------------------

  listClassifications(ctx: RequestContext, q: z.infer<typeof ClassificationQuery>): Promise<z.infer<typeof Classification>[]> {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [eq(ncrClassifications.organisationId, ctx.organisationId!)];
      if (q.kind) where.push(eq(ncrClassifications.kind, q.kind));
      if (!q.includeInactive) where.push(eq(ncrClassifications.active, true));
      const rows = await db
        .select()
        .from(ncrClassifications)
        .where(and(...where))
        .orderBy(asc(ncrClassifications.kind), asc(ncrClassifications.sortOrder), asc(sql`lower(${ncrClassifications.name})`));
      return rows.map(toClassification);
    });
  }

  createClassification(ctx: RequestContext, body: z.infer<typeof CreateClassificationBody>): Promise<z.infer<typeof Classification>> {
    return this.database.asUser(ctx, async (db) => {
      const [row] = await db
        .insert(ncrClassifications)
        .values({ organisationId: ctx.organisationId!, ...body })
        .returning();
      return toClassification(row);
    });
  }

  updateClassification(ctx: RequestContext, id: string, body: z.infer<typeof UpdateClassificationBody>): Promise<z.infer<typeof Classification>> {
    return this.database.asUser(ctx, async (db) => {
      const [row] = await db
        .update(ncrClassifications)
        .set(body)
        .where(and(eq(ncrClassifications.id, id), eq(ncrClassifications.organisationId, ctx.organisationId!)))
        .returning();
      if (!row) throw ApiError.notFound('classification_not_found', 'Classification not found');
      return toClassification(row);
    });
  }

  // ---- internals ---------------------------------------------------------------------------

  private change(ctx: RequestContext, id: string, set: Partial<typeof nonconformances.$inferInsert>): Promise<NcrDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.update1(db, ctx, id, set);
      return this.load(db, ctx, id);
    });
  }

  private async update1(db: Db, ctx: RequestContext, id: string, set: Partial<typeof nonconformances.$inferInsert>) {
    const [row] = await db
      .update(nonconformances)
      .set(set)
      .where(and(eq(nonconformances.id, id), eq(nonconformances.organisationId, ctx.organisationId!)))
      .returning({ id: nonconformances.id });
    if (!row) throw ApiError.notFound('ncr_not_found', 'Non-conformance not found');
  }

  private async load(db: Db, ctx: RequestContext, id: string): Promise<NcrDetail> {
    const result = await db.execute<Row>(sql`
      select ${sql.raw(SELECT_SUMMARY)},
             n.source_change_reason, n.stage_reason, n.description, n.requirement, n.actual_result, n.part_revision_id, n.lot_number, n.serial_number,
             n.quantity_inspected, n.closed_at, n.delete_reason, n.updated_at, ${sql.raw(LINK_COLUMNS)},
             site.id as site_id, site.code as site_code, site.name as site_name,
             dp.id as dp_id, dp.name as dp_name,
             e.id as employee_id, ${sql.raw(personName('e'))} as employee_name,
             n.owner_id, ${sql.raw(personName('po'))} as owner_name,
             n.detected_by, ${sql.raw(personName('pd'))} as detected_by_name,
             n.created_by, ${sql.raw(personName('pc'))} as created_by_name,
             n.closed_by, ${sql.raw(personName('pcl'))} as closed_by_name,
             n.deleted_by, ${sql.raw(personName('pdl'))} as deleted_by_name
      ${sql.raw(FROM)}
      left join public.sites site on site.id = n.site_id
      left join public.machines dp on dp.id = n.detection_process_id
      left join public."Employees" e on e.id = n.responsible_employee_id
      left join public.profiles po on po.id = n.owner_id
      left join public.profiles pd on pd.id = n.detected_by
      left join public.profiles pc on pc.id = n.created_by
      left join public.profiles pcl on pcl.id = n.closed_by
      left join public.profiles pdl on pdl.id = n.deleted_by
      ${sql.raw(linkJoins('n'))}
      where n.organisation_id = ${ctx.organisationId!}::uuid and n.id = ${id}::uuid`);
    const r = result.rows[0];
    if (!r) throw ApiError.notFound('ncr_not_found', 'Non-conformance not found');
    const person = (idKey: string, nameKey: string) => (r[idKey] ? { id: r[idKey] as string, name: (r[nameKey] as string) ?? 'Unknown user' } : null);
    return {
      ...toSummary(r),
      customValues: await customValuesOf(db, 'nonconformance', id),
      sourceChangeReason: (r.source_change_reason as string) ?? null,
      stageReason: (r.stage_reason as string) ?? null,
      description: (r.description as string) ?? null,
      requirement: (r.requirement as string) ?? null,
      actualResult: (r.actual_result as string) ?? null,
      site: r.site_id ? { id: r.site_id as string, code: r.site_code as string, name: r.site_name as string } : null,
      partRevisionId: (r.part_revision_id as string) ?? null,
      lotNumber: (r.lot_number as string) ?? null,
      serialNumber: (r.serial_number as string) ?? null,
      links: toLinks(r),
      quantityInspected: num(r.quantity_inspected),
      detectionProcess: ref(r.dp_id, r.dp_name),
      responsibleEmployee: ref(r.employee_id, r.employee_name),
      owner: person('owner_id', 'owner_name'),
      detectedBy: person('detected_by', 'detected_by_name'),
      createdBy: person('created_by', 'created_by_name'),
      closedAt: iso(r.closed_at),
      closedBy: person('closed_by', 'closed_by_name'),
      deletedBy: person('deleted_by', 'deleted_by_name'),
      deleteReason: (r.delete_reason as string) ?? null,
      updatedAt: iso(r.updated_at)!,
    };
  }
}

const toClassification = (r: typeof ncrClassifications.$inferSelect): z.infer<typeof Classification> => ({
  id: r.id,
  kind: r.kind as z.infer<typeof Classification>['kind'],
  parentId: r.parentId,
  code: r.code,
  name: r.name,
  description: r.description,
  active: r.active,
});
