import { Injectable } from '@nestjs/common';
import { and, asc, eq, SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { ncrClassifications, nonconformances } from '../database/schema';
import {
  Classification,
  ClassificationQuery,
  CreateClassificationBody,
  CreateNcrBody,
  Employee,
  HistoryEntry,
  NcrDetail,
  NcrListQuery,
  NcrSummary,
  TransitionBody,
  UpdateClassificationBody,
  UpdateNcrBody,
} from './ncr.schemas';

const STAGE_ORDER = `array_position(array['draft','open','contained','investigating','dispositioned','awaiting_closure','closed','cancelled'], n.stage)`;
const SORT_SQL: Record<NcrListQuery['sort'], string> = {
  reference: 'n.reference',
  detectedAt: 'n.detected_at',
  title: 'lower(n.title)',
  stage: STAGE_ORDER,
  severity: `array_position(array['critical','major','minor'], n.severity)`,
  quantityAffected: 'n.quantity_affected',
  partNumber: 'upper(p.part_number)',
  customer: 'lower(coalesce(c.display_name, c.name))',
  supplier: 'lower(coalesce(s.display_name, s.name))',
  failureMode: 'lower(fm.name)',
  createdAt: 'n.created_at',
};

const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const personName = (alias: string) => `nullif(trim(concat_ws(' ', ${alias}.first_name, ${alias}.surname)), '')`;

/** Columns shared by list and detail. */
const SELECT_SUMMARY = `
  n.id, n.reference, n.source, n.stage, n.severity, n.title, to_char(n.detected_at, 'YYYY-MM-DD') as detected_at,
  n.quantity_affected, n.work_order, n.purchase_order, n.customer_reference, n.deleted_at, n.created_at,
  p.id as part_id, p.part_number, p.name as part_name, r.revision,
  c.id as customer_id, coalesce(c.display_name, c.name) as customer_name,
  s.id as supplier_id, coalesce(s.display_name, s.name) as supplier_name,
  fm.id as fm_id, fm.name as fm_name, sfm.id as sfm_id, sfm.name as sfm_name, cp.id as cp_id, cp.name as cp_name`;
const FROM = `
  from public.nonconformances n
  left join public.parts p on p.id = n.part_id
  left join public.part_revisions r on r.id = n.part_revision_id
  left join public.customers c on c.id = n.customer_id
  left join public.suppliers s on s.id = n.supplier_id
  left join public.ncr_classifications fm on fm.id = n.failure_mode_id
  left join public.ncr_classifications sfm on sfm.id = n.sub_failure_mode_id
  left join public.ncr_classifications cp on cp.id = n.causal_process_id`;

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
  customer: ref(r.customer_id, r.customer_name),
  supplier: ref(r.supplier_id, r.supplier_name),
  workOrder: (r.work_order as string) ?? null,
  purchaseOrder: (r.purchase_order as string) ?? null,
  customerReference: (r.customer_reference as string) ?? null,
  failureMode: ref(r.fm_id, r.fm_name),
  subFailureMode: ref(r.sfm_id, r.sfm_name),
  causalProcess: ref(r.cp_id, r.cp_name),
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
@Injectable()
export class NcrService {
  constructor(private readonly database: DatabaseService) {}

  list(ctx: RequestContext, q: NcrListQuery): Promise<{ data: NcrSummary[]; page: number; pageSize: number; total: number }> {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`n.organisation_id = ${ctx.organisationId!}::uuid`];
      if (q.source) where.push(sql`n.source = ${q.source}`);
      if (q.stage.length) where.push(sql`n.stage = any(${q.stage}::text[])`);
      if (q.deleted === 'exclude') where.push(sql`n.deleted_at is null`);
      if (q.deleted === 'only') where.push(sql`n.deleted_at is not null`);
      if (q.failureModeId) where.push(sql`n.failure_mode_id = ${q.failureModeId}::uuid`);
      if (q.subFailureModeId) where.push(sql`n.sub_failure_mode_id = ${q.subFailureModeId}::uuid`);
      if (q.partId) where.push(sql`n.part_id = ${q.partId}::uuid`);
      if (q.customerId) where.push(sql`n.customer_id = ${q.customerId}::uuid`);
      if (q.supplierId) where.push(sql`n.supplier_id = ${q.supplierId}::uuid`);
      if (q.from) where.push(sql`n.detected_at >= ${q.from}::date`);
      if (q.to) where.push(sql`n.detected_at <= ${q.to}::date`);
      if (q.q) {
        const like = likePattern(q.q);
        where.push(sql`(n.reference ilike ${like} or n.title ilike ${like} or n.description ilike ${like} or n.work_order ilike ${like}
          or n.purchase_order ilike ${like} or n.customer_reference ilike ${like} or p.part_number ilike ${like}
          or c.name ilike ${like} or c.display_name ilike ${like} or s.name ilike ${like} or s.display_name ilike ${like} or fm.name ilike ${like})`);
      }
      const order = sql.raw(`${SORT_SQL[q.sort]} ${q.order} nulls last, n.reference ${q.order}`);
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
      return { data: result.rows.map(toSummary), page: q.page, pageSize: q.pageSize, total };
    });
  }

  get(ctx: RequestContext, id: string): Promise<NcrDetail> {
    return this.database.asUser(ctx, (db) => this.load(db, ctx, id));
  }

  create(ctx: RequestContext, body: CreateNcrBody): Promise<NcrDetail> {
    return this.database.asUser(ctx, async (db) => {
      const { open, source, ...rest } = body;
      const [row] = await db
        .insert(nonconformances)
        .values({ ...toColumns(rest), title: rest.title, organisationId: ctx.organisationId!, source, stage: open ? 'open' : 'draft', detectedBy: ctx.user.id })
        .returning({ id: nonconformances.id });
      return this.load(db, ctx, row.id);
    });
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
      return result.rows.map((r) => ({
        id: r.id as string,
        at: iso(r.created_at)!,
        actor: r.actor_user_id ? { id: r.actor_user_id as string, name: (r.actor_name as string) ?? 'Unknown user' } : null,
        action: r.action as string,
        changedFields: (r.changed_fields as string[]) ?? [],
        previous: (r.previous_values as Record<string, unknown>) ?? null,
        current: (r.new_values as Record<string, unknown>) ?? null,
        reason: (r.reason as string) || null,
        source: r.source as string,
      }));
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

  listEmployees(ctx: RequestContext): Promise<z.infer<typeof Employee>[]> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute<Row>(sql`
        select id, ${sql.raw(personName('e'))} as name, job_title, coalesce(active, true) as active
        from public."Employees" e where e.organisation_id = ${ctx.organisationId!}::uuid
        order by lower(e.surname), lower(e.first_name)`);
      return result.rows.map((r) => ({ id: r.id as string, name: (r.name as string) ?? 'Unnamed', jobTitle: (r.job_title as string) ?? null, active: r.active as boolean }));
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
             n.stage_reason, n.description, n.requirement, n.actual_result, n.part_revision_id, n.lot_number, n.serial_number,
             n.quantity_inspected, n.closed_at, n.delete_reason, n.updated_at,
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
      left join public.ncr_classifications dp on dp.id = n.detection_process_id
      left join public."Employees" e on e.id = n.responsible_employee_id
      left join public.profiles po on po.id = n.owner_id
      left join public.profiles pd on pd.id = n.detected_by
      left join public.profiles pc on pc.id = n.created_by
      left join public.profiles pcl on pcl.id = n.closed_by
      left join public.profiles pdl on pdl.id = n.deleted_by
      where n.organisation_id = ${ctx.organisationId!}::uuid and n.id = ${id}::uuid`);
    const r = result.rows[0];
    if (!r) throw ApiError.notFound('ncr_not_found', 'Non-conformance not found');
    const person = (idKey: string, nameKey: string) => (r[idKey] ? { id: r[idKey] as string, name: (r[nameKey] as string) ?? 'Unknown user' } : null);
    return {
      ...toSummary(r),
      stageReason: (r.stage_reason as string) ?? null,
      description: (r.description as string) ?? null,
      requirement: (r.requirement as string) ?? null,
      actualResult: (r.actual_result as string) ?? null,
      site: r.site_id ? { id: r.site_id as string, code: r.site_code as string, name: r.site_name as string } : null,
      partRevisionId: (r.part_revision_id as string) ?? null,
      lotNumber: (r.lot_number as string) ?? null,
      serialNumber: (r.serial_number as string) ?? null,
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
