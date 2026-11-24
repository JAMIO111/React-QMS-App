import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { assignments, iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import {
  AllQuery, Attachment, BoardBody, ChangeListQuery, CompleteTaskBody, CreateAttachmentBody, CreateTaskBody, CustomerApprovalBody, CutInBody, DecideBody, ImpactBody, CreateChangeBody, CreateFunctionBody,
  CreateTypeBody, DeletedQuery, LinkItem, LinkTaskBody, ListItem, ReviewBody, StartRevisionBody, UpdateAreaBody, UpdateChangeBody, UpdateFunctionBody, UpdateTaskBody, UpdateTypeBody,
} from './change.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown' } : null);
const json = (v: unknown) => JSON.stringify(v);

const LINK_COLUMN: Record<string, string> = {
  part: 'part_id', part_family: 'part_family_id', machine: 'machine_id', supplier: 'supplier_id', customer: 'customer_id', production_order: 'production_order_id',
};
const KIND_ORDER = ['part', 'part_family', 'machine', 'supplier', 'customer', 'production_order', 'operation_code'];
const TARGET = sql.raw(`coalesce(${Object.values(LINK_COLUMN).map((c) => `l.${c}`).join(', ')})`);

/** The records a change covers, each read under the caller's own rules, so a record they may not read has no label. */
const labelledLinks = (changeId: string, org: string) => sql`
  select l.kind, ${TARGET} as target_id, l.operation_code, l.created_at,
         coalesce(p.part_number, pf.code, m.code, s.code, c.code, po.order_number) as t_reference,
         coalesce(p.name, pf.name, m.name, s.name, c.name, po.order_number) as t_name
    from public.change_links l
    left join public.parts p on l.kind = 'part' and p.id = l.part_id
    left join public.part_families pf on l.kind = 'part_family' and pf.id = l.part_family_id
    left join public.machines m on l.kind = 'machine' and m.id = l.machine_id
    left join public.suppliers s on l.kind = 'supplier' and s.id = l.supplier_id
    left join public.customers c on l.kind = 'customer' and c.id = l.customer_id
    left join public.production_orders po on l.kind = 'production_order' and po.id = l.production_order_id
   where l.change_id = ${changeId}::uuid and l.organisation_id = ${org}::uuid`;

/** The record a change was raised from, read under the caller's rules (null label when they may not read it). */
const originLabel = (kind: string, id: string) => {
  switch (kind) {
    case 'ncr': return sql`select reference as ref, title as name from public.nonconformances where id = ${id}::uuid`;
    case 'capa': return sql`select reference as ref, title as name from public.capas where id = ${id}::uuid`;
    case 'audit_finding': return sql`select reference as ref, title as name from public.audit_findings where id = ${id}::uuid`;
    case 'risk': return sql`select reference as ref, title as name from public.risks where id = ${id}::uuid`;
    default: return sql`select reference as ref, null::text as name from public.document_change_requests where id = ${id}::uuid`;
  }
};

const toLink = (r: Row) => ({
  kind: r.kind as string,
  id: (r.target_id as string) ?? null,
  code: (r.operation_code as string) ?? null,
  reference: r.kind === 'operation_code' ? (r.operation_code as string) : ((r.t_reference as string) ?? null),
  name: (r.t_name as string) ?? null,
  readable: r.kind === 'operation_code' || r.t_reference != null,
});

const CHANGE_SELECT = sql`
  select c.*, t.label as type_label, t.needs_customer_approval, ${sql.raw(personName('pr'))} as raised_by_name, ${sql.raw(personName('pc'))} as cancelled_by_name,
         (select count(*)::int from public.change_links l where l.change_id = c.id) as link_count,
         (select count(*)::int from public.change_attachments a where a.change_id = c.id and a.deleted_at is null) as file_count,
         exists (select 1 from public.change_signoffs w where w.change_id = c.id and w.signer_user_id = auth.uid() and w.status = 'pending') as waiting_for_me,
         ${sql.raw(personName('pap'))} as approved_by_name, ${sql.raw(personName('pcl'))} as closed_by_name,
         (select string_agg(coalesce(p.part_number, pf.code, m.code, s.code, cu.code, po.order_number, l.operation_code), ' ')
            from public.change_links l
            left join public.parts p on p.id = l.part_id left join public.part_families pf on pf.id = l.part_family_id left join public.machines m on m.id = l.machine_id
            left join public.suppliers s on s.id = l.supplier_id left join public.customers cu on cu.id = l.customer_id left join public.production_orders po on po.id = l.production_order_id
           where l.change_id = c.id) as link_text
    from public.change_requests c
    join public.change_types t on t.id = c.type_id
    left join public.profiles pr on pr.id = c.raised_by
    left join public.profiles pc on pc.id = c.cancelled_by
    left join public.profiles pap on pap.id = c.approved_by
    left join public.profiles pcl on pcl.id = c.closed_by`;

const SORT: Record<ChangeListQuery['sort'], string> = {
  reference: 'c.reference',
  title: 'lower(c.title)',
  type: 'lower(c.type_label)',
  stage: 'c.stage',
  urgency: 'c.urgency',
  raisedBy: 'lower(c.raised_by_name)',
  createdAt: 'c.created_at',
  updatedAt: 'c.updated_at',
};

const toSummary = (r: Row) => ({
  id: r.id as string,
  reference: r.reference as string,
  title: r.title as string,
  stage: r.stage as string,
  urgency: r.urgency as 'normal' | 'expedited',
  type: { id: r.type_id as string, label: r.type_label as string, needsCustomerApproval: !!r.needs_customer_approval },
  raisedBy: person(r.raised_by, r.raised_by_name),
  originKind: (r.origin_kind as string) ?? null,
  /** A sign-off on this change is waiting for the caller. */
  waitingForMe: !!r.waiting_for_me,
  linkCount: Number(r.link_count ?? 0),
  fileCount: Number(r.file_count ?? 0),
  createdAt: iso(r.created_at) as string,
  updatedAt: iso(r.updated_at) as string,
});

const toListItem = (r: Row): ListItem => ({
  id: r.id as string,
  key: r.key as string,
  label: r.label as string,
  description: (r.description as string) ?? null,
  sequence: Number(r.sequence),
  active: !!r.active,
  ...(r.needs_customer_approval !== undefined ? { needsCustomerApproval: !!r.needs_customer_approval, changes: Number(r.change_count ?? 0) } : {}),
});

const ATTACHMENT_SELECT = sql`
  select a.*, ${sql.raw(personName('pc'))} as created_by_name
  from public.change_attachments a left join public.profiles pc on pc.id = a.created_by`;
const toAttachment = (r: Row): z.infer<typeof Attachment> => ({
  id: r.id as string,
  fileName: r.file_name as string,
  contentType: (r.content_type as string) ?? null,
  sizeBytes: Number(r.size_bytes),
  description: (r.description as string) ?? null,
  storagePath: r.storage_path as string,
  createdAt: iso(r.created_at)!,
  createdBy: r.created_by ? { id: r.created_by as string, name: (r.created_by_name as string) ?? 'Unknown user' } : null,
  deletedAt: iso(r.deleted_at),
  deleteReason: (r.delete_reason as string) ?? null,
});

/**
 * A change's tasks with the record each one changes, read under the caller's own rules: a record they may not read has no label. `link_state` comes from the
 * database (app.change_task_link_state), so the screen, the completion rule and the closing rule agree.
 */
const TASK_SELECT = sql`
  select t.*, ${sql.raw(personName('po'))} as owner_name, ${sql.raw(personName('pd'))} as done_by_name, a.label as area_label,
         app.change_task_link_state(t.id) as link_state, (t.status = 'open' and t.due_on is not null and t.due_on < current_date) as overdue,
         pr.status as pr_status, pr.revision as pr_revision, pr.version as pr_version, pr.part_id as pr_part_id, ppt.part_number as pr_part_number,
         cr.status as cr_status, cr.revision_code as cr_code, cr.control_plan_id as cr_plan_id, cpl.plan_code as cr_plan_code,
         dr.status as dr_status, dr.letter as dr_letter, dr.document_id as dr_document_id, dd.number as dr_number, dd.title as dr_title,
         gt.code as gt_code, gt.name as gt_name, gt.active as gt_active,
         ts.reference as ts_reference, ts.title as ts_title, ts.status as ts_status,
         su.code as su_code, su.name as su_name, su.approval_status as su_status,
         ir.name as ir_name, ir.status as ir_status,
         qa.reference as qa_reference, qa.title as qa_title, qa.status as qa_status,
         rk.reference as rk_reference, rk.title as rk_title, rk.status as rk_status
    from public.change_tasks t
    left join public.profiles po on po.id = t.owner_user_id
    left join public.profiles pd on pd.id = t.done_by
    left join public.change_areas a on a.id = t.area_id
    left join public.part_revisions pr on pr.id = t.part_revision_id
    left join public.parts ppt on ppt.id = pr.part_id
    left join public.control_plan_revisions cr on cr.id = t.control_plan_revision_id
    left join public.control_plans cpl on cpl.id = cr.control_plan_id
    left join public.document_revisions dr on dr.id = t.document_revision_id
    left join public.documents dd on dd.id = dr.document_id
    left join public.gauge_types gt on gt.id = t.gauge_type_id
    left join public.competence_training_sessions ts on ts.id = t.training_session_id
    left join public.suppliers su on su.id = t.supplier_id
    left join public.supplier_inspection_requirements ir on ir.id = t.inspection_requirement_id
    left join public.quality_alerts qa on qa.id = t.quality_alert_id
    left join public.risks rk on rk.id = t.risk_id`;

/** The record a task changes: what it is called, where it stands now (raw status and the worked-out state) and where to open it. */
const toTaskLink = (r: Row) => {
  const kind = r.link_kind as string | null;
  if (!kind) return null;
  const base = { kind, state: (r.link_state as string) ?? 'none' };
  switch (kind) {
    case 'part_revision': {
      const v = Number(r.pr_version ?? 1);
      return { ...base, id: r.part_revision_id as string, readable: r.pr_status != null, label: r.pr_status == null ? null : `${r.pr_part_number} · rev ${r.pr_revision}${v > 1 ? ` v${v}` : ''}`,
               status: (r.pr_status as string) ?? null, parentId: (r.pr_part_id as string) ?? null };
    }
    case 'control_plan_revision':
      return { ...base, id: r.control_plan_revision_id as string, readable: r.cr_status != null, label: r.cr_status == null ? null : `${r.cr_plan_code} · rev ${r.cr_code}`,
               status: (r.cr_status as string) ?? null, parentId: (r.cr_plan_id as string) ?? null };
    case 'document_revision':
      return { ...base, id: r.document_revision_id as string, readable: r.dr_status != null, label: r.dr_status == null ? null : `${r.dr_number}${r.dr_letter ? ` rev ${r.dr_letter}` : ' (draft)'} · ${r.dr_title}`,
               status: (r.dr_status as string) ?? null, parentId: (r.dr_document_id as string) ?? null };
    case 'gauge_type':
      return { ...base, id: r.gauge_type_id as string, readable: r.gt_code != null, label: r.gt_code == null ? null : `${r.gt_code} · ${r.gt_name}`, status: r.gt_code == null ? null : r.gt_active ? 'active' : 'inactive', parentId: null };
    case 'training_session':
      return { ...base, id: r.training_session_id as string, readable: r.ts_reference != null, label: r.ts_reference == null ? null : `${r.ts_reference} · ${r.ts_title}`, status: (r.ts_status as string) ?? null, parentId: null };
    case 'supplier':
      return { ...base, id: r.supplier_id as string, readable: r.su_code != null, label: r.su_code == null ? null : `${r.su_code} · ${r.su_name}`, status: (r.su_status as string) ?? null, parentId: null };
    case 'inspection_requirement':
      return { ...base, id: r.inspection_requirement_id as string, readable: r.ir_name != null, label: (r.ir_name as string) ?? null, status: (r.ir_status as string) ?? null, parentId: null };
    case 'quality_alert':
      return { ...base, id: r.quality_alert_id as string, readable: r.qa_reference != null, label: r.qa_reference == null ? null : `${r.qa_reference} · ${r.qa_title}`, status: (r.qa_status as string) ?? null, parentId: null };
    default:
      return { ...base, id: r.risk_id as string, readable: r.rk_reference != null, label: r.rk_reference == null ? null : `${r.rk_reference} · ${r.rk_title}`, status: (r.rk_status as string) ?? null, parentId: null };
  }
};

const TYPE_COLUMNS: Record<string, string> = { label: 'label', description: 'description', sequence: 'sequence', active: 'active', needsCustomerApproval: 'needs_customer_approval' };
const FUNCTION_COLUMNS: Record<string, string> = { label: 'label', description: 'description', sequence: 'sequence', active: 'active' };

/** The key of a new list entry: made from its label and kept (renaming later never changes it). */
const keyFor = async (db: Db, table: 'change_types' | 'change_functions', org: string, label: string) => {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36) || 'item';
  const start = /^[a-z]/.test(base) && base.length >= 2 ? base : `c_${base}`;
  let key = start;
  for (let i = 2; ; i++) {
    const taken = await db.execute(sql`select 1 from ${sql.raw(`public.${table}`)} where organisation_id = ${org}::uuid and key = ${key}`);
    if (taken.rows.length === 0) return key;
    key = `${start.slice(0, 34)}_${i}`;
  }
};

/** Change management (CH1): the lists a change is set up with, and the change itself with its scope and files. Every write to a change is a database function; reading is by RLS. */
@Injectable()
export class ChangeService {
  constructor(private readonly database: DatabaseService) {}

  // ---- the lists -----------------------------------------------------------------------------------

  types(ctx: RequestContext, q: AllQuery) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`
        select t.*, (select count(*)::int from public.change_requests c where c.type_id = t.id) as change_count
          from public.change_types t where t.organisation_id = ${orgOf(ctx)}::uuid ${q.all === 'true' ? sql`` : sql`and t.active`}
         order by t.sequence, lower(t.label)`);
      return { data: res.rows.map(toListItem) };
    });
  }

  createType(ctx: RequestContext, body: CreateTypeBody) {
    return this.database.asUser(ctx, async (db) => {
      const org = orgOf(ctx);
      const key = await keyFor(db, 'change_types', org, body.label);
      const res = await db.execute<Row>(sql`
        insert into public.change_types (organisation_id, key, label, description, needs_customer_approval, sequence)
        values (${org}::uuid, ${key}, ${body.label}, ${body.description ?? null}, ${body.needsCustomerApproval ?? false},
                ${body.sequence ?? sql`(select coalesce(max(sequence), 0) + 1 from public.change_types where organisation_id = ${org}::uuid)`})
        returning *, 0 as change_count`);
      return toListItem(res.rows[0]);
    });
  }

  updateType(ctx: RequestContext, id: string, body: UpdateTypeBody) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`
        update public.change_types set ${sql.join(assignments(body, TYPE_COLUMNS), sql`, `)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid
        returning *, (select count(*)::int from public.change_requests c where c.type_id = public.change_types.id) as change_count`);
      if (res.rows.length === 0) throw ApiError.notFound('change_type_not_found', 'Type not found');
      return toListItem(res.rows[0]);
    });
  }

  functions(ctx: RequestContext, q: AllQuery) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`
        select f.* from public.change_functions f where f.organisation_id = ${orgOf(ctx)}::uuid ${q.all === 'true' ? sql`` : sql`and f.active`} order by f.sequence, lower(f.label)`);
      return { data: res.rows.map(toListItem) };
    });
  }

  createFunction(ctx: RequestContext, body: CreateFunctionBody) {
    return this.database.asUser(ctx, async (db) => {
      const org = orgOf(ctx);
      const key = await keyFor(db, 'change_functions', org, body.label);
      const res = await db.execute<Row>(sql`
        insert into public.change_functions (organisation_id, key, label, description, sequence)
        values (${org}::uuid, ${key}, ${body.label}, ${body.description ?? null},
                ${body.sequence ?? sql`(select coalesce(max(sequence), 0) + 1 from public.change_functions where organisation_id = ${org}::uuid)`})
        returning *`);
      return toListItem(res.rows[0]);
    });
  }

  updateFunction(ctx: RequestContext, id: string, body: UpdateFunctionBody) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`
        update public.change_functions set ${sql.join(assignments(body, FUNCTION_COLUMNS), sql`, `)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning *`);
      if (res.rows.length === 0) throw ApiError.notFound('change_function_not_found', 'Function not found');
      return toListItem(res.rows[0]);
    });
  }

  areas(ctx: RequestContext, q: AllQuery) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`
        select a.* from public.change_areas a where a.organisation_id = ${orgOf(ctx)}::uuid ${q.all === 'true' ? sql`` : sql`and a.active`} order by a.sequence, lower(a.label)`);
      return { data: res.rows.map(toListItem) };
    });
  }

  updateArea(ctx: RequestContext, id: string, body: UpdateAreaBody) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`update public.change_areas set active = ${body.active} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning *`);
      if (res.rows.length === 0) throw ApiError.notFound('change_area_not_found', 'Area not found');
      return toListItem(res.rows[0]);
    });
  }

  // ---- changes -------------------------------------------------------------------------------------

  list(ctx: RequestContext, q: ChangeListQuery) {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`c.organisation_id = ${orgOf(ctx)}::uuid`];
      const stages = (q.stage ?? 'open').split(',');
      if (!stages.includes('all')) {
        const named = stages.filter((s) => s !== 'open');
        where.push(
          stages.includes('open')
            ? sql`(c.stage in ('draft', 'assessment', 'approval', 'approved', 'implementing', 'verifying') or c.stage = any(string_to_array(${named.join(',')}, ',')))`
            : sql`c.stage = any(string_to_array(${named.join(',')}, ','))`,
        );
      }
      if (q.typeId) where.push(sql`c.type_id = ${q.typeId}::uuid`);
      if (q.urgency) where.push(sql`c.urgency = ${q.urgency}`);
      if (q.owner === 'me') where.push(sql`c.raised_by = auth.uid()`);
      if (q.signer === 'me') where.push(sql`c.waiting_for_me`);
      if (q.originKind) where.push(sql`c.origin_kind = any(string_to_array(${q.originKind}, ','))`);
      const linked = (column: string, id: string) =>
        where.push(sql`exists (select 1 from public.change_links l where l.change_id = c.id and ${sql.raw(`l.${column}`)} = ${id}::uuid)`);
      if (q.partId) linked('part_id', q.partId);
      if (q.partFamilyId) linked('part_family_id', q.partFamilyId);
      if (q.machineId) linked('machine_id', q.machineId);
      if (q.supplierId) linked('supplier_id', q.supplierId);
      if (q.customerId) linked('customer_id', q.customerId);
      if (q.q) {
        const p = likePattern(q.q);
        where.push(sql`(c.reference ilike ${p} escape '\\' or c.title ilike ${p} escape '\\' or c.description ilike ${p} escape '\\' or c.reason ilike ${p} escape '\\'
                        or c.link_text ilike ${p} escape '\\' or c.raised_by_name ilike ${p} escape '\\' or c.type_label ilike ${p} escape '\\')`);
      }
      const filter = sql.join(where, sql` and `);
      const total = (await db.execute<Row>(sql`select count(*)::int as n from (${CHANGE_SELECT}) c where ${filter}`)).rows[0];
      const rows = (
        await db.execute<Row>(sql`
          select * from (${CHANGE_SELECT}) c where ${filter}
           order by ${sql.raw(SORT[q.sort])} ${sql.raw(q.order === 'desc' ? 'desc nulls last' : 'asc nulls last')}, c.reference
           limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`)
      ).rows;
      return { data: rows.map(toSummary), page: q.page, pageSize: q.pageSize, total: Number(total.n) };
    });
  }

  private async change(db: Db, ctx: RequestContext, id: string) {
    const org = orgOf(ctx);
    const rows = (await db.execute<Row>(sql`select * from (${CHANGE_SELECT}) c where c.id = ${id}::uuid and c.organisation_id = ${org}::uuid`)).rows;
    if (rows.length === 0) throw ApiError.notFound('change_not_found', 'Change not found');
    const r = rows[0];
    const stage = r.stage as string;
    const can = (
      await db.execute<Row>(sql`
        select app.has_permission(${org}::uuid, 'change.manage') as manage, app.has_permission(${org}::uuid, 'change.approve') as approve, auth.uid() as me,
               coalesce((select s.change_allow_self_approval from public.organisation_settings s where s.organisation_id = ${org}::uuid), false) as self_ok,
               exists (select 1 from public.change_signoffs s where s.change_id = ${id}::uuid and s.round = ${Number(r.review_round)} and s.signer_user_id = auth.uid()) as in_round`)
    ).rows[0];
    const links = (await db.execute<Row>(labelledLinks(id, org))).rows
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || KIND_ORDER.indexOf(a.kind as string) - KIND_ORDER.indexOf(b.kind as string))
      .map(toLink);
    let origin: { kind: string; id: string; reference: string | null; name: string | null; readable: boolean } | null = null;
    if (r.origin_kind) {
      const found = (await db.execute<Row>(originLabel(r.origin_kind as string, r.origin_id as string))).rows[0];
      origin = { kind: r.origin_kind as string, id: r.origin_id as string, reference: (found?.ref as string) ?? null, name: (found?.name as string) ?? null, readable: !!found };
    }
    const attachments = (await db.execute<Row>(sql`${ATTACHMENT_SELECT} where a.change_id = ${id}::uuid and a.organisation_id = ${org}::uuid order by a.created_at desc`)).rows.map(toAttachment);
    const impacts = (
      await db.execute<Row>(sql`
        select i.*, a.key, a.label, a.description, ${sql.raw(personName('pa'))} as by_name
          from public.change_impacts i join public.change_areas a on a.id = i.area_id left join public.profiles pa on pa.id = i.assessed_by
         where i.change_id = ${id}::uuid and i.organisation_id = ${org}::uuid order by a.sequence, lower(a.label)`)
    ).rows.map((i) => ({
      id: i.id as string,
      areaId: i.area_id as string,
      key: i.key as string,
      label: i.label as string,
      description: (i.description as string) ?? null,
      status: i.status as 'not_assessed' | 'affected' | 'not_affected',
      note: (i.note as string) ?? null,
      assessedAt: i.assessed_at ? (iso(i.assessed_at) as string) : null,
      assessedBy: (i.by_name as string) ?? null,
    }));
    const board = (
      await db.execute<Row>(sql`
        select b.*, f.label, f.key, ${sql.raw(personName('ps'))} as signer_name
          from public.change_board b join public.change_functions f on f.id = b.function_id left join public.profiles ps on ps.id = b.signer_user_id
         where b.change_id = ${id}::uuid and b.organisation_id = ${org}::uuid order by f.sequence, lower(f.label)`)
    ).rows.map((b) => ({
      id: b.id as string,
      function: { id: b.function_id as string, label: b.label as string },
      signer: person(b.signer_user_id, b.signer_name),
    }));
    const signoffs = (
      await db.execute<Row>(sql`
        select s.*, f.label, ${sql.raw(personName('ps'))} as signer_name
          from public.change_signoffs s join public.change_functions f on f.id = s.function_id left join public.profiles ps on ps.id = s.signer_user_id
         where s.change_id = ${id}::uuid and s.organisation_id = ${org}::uuid order by s.round desc, f.sequence, lower(f.label)`)
    ).rows.map((x) => {
      const mine = x.signer_user_id === can.me;
      return {
        id: x.id as string,
        round: Number(x.round),
        function: { id: x.function_id as string, label: x.label as string },
        signer: person(x.signer_user_id, x.signer_name),
        status: x.status as 'pending' | 'approved' | 'rejected' | 'superseded',
        comment: (x.comment as string) ?? null,
        decidedAt: x.decided_at ? (iso(x.decided_at) as string) : null,
        /** The caller is the signer, it is waiting, and nothing (the approve right, the raiser's rule) stands in the way. */
        canDecide: mine && x.status === 'pending' && stage === 'approval' && Number(x.round) === Number(r.review_round) && Boolean(can.approve) && (r.raised_by !== can.me || Boolean(can.self_ok)),
      };
    });
    const stageOpenForTasks = ['approved', 'implementing', 'verifying'].includes(stage);
    const finishedStage = ['closed', 'rejected', 'cancelled'].includes(stage);
    const tasks = (await db.execute<Row>(sql`${TASK_SELECT} where t.change_id = ${id}::uuid and t.organisation_id = ${org}::uuid order by t.created_at, t.id`)).rows.map((t) => {
      const open = t.status === 'open';
      const mineTask = t.owner_user_id === can.me;
      return {
        id: t.id as string,
        description: t.description as string,
        status: t.status as 'open' | 'done' | 'cancelled',
        owner: person(t.owner_user_id, t.owner_name),
        dueOn: t.due_on ? (iso(t.due_on) as string).slice(0, 10) : null,
        overdue: !!t.overdue,
        area: t.area_id ? { id: t.area_id as string, label: (t.area_label as string) ?? '' } : null,
        resultNote: (t.result_note as string) ?? null,
        doneAt: t.done_at ? (iso(t.done_at) as string) : null,
        doneBy: (t.done_by_name as string) ?? null,
        cancelReason: (t.cancel_reason as string) ?? null,
        reopenReason: (t.reopen_reason as string) ?? null,
        createdAt: iso(t.created_at) as string,
        link: toTaskLink(t),
        isMine: mineTask,
        /** A manager, or the person it was given to, can finish an open task (the database also checks the record it changes is in force). */
        canComplete: open && stageOpenForTasks && (Boolean(can.manage) || mineTask),
        canEdit: open && stageOpenForTasks && Boolean(can.manage),
        canCancel: open && stageOpenForTasks && Boolean(can.manage),
        canReopen: t.status === 'done' && stageOpenForTasks && Boolean(can.manage),
      };
    });
    const reviews = (
      await db.execute<Row>(sql`
        select v.*, ${sql.raw(personName('pv'))} as by_name
          from public.change_reviews v left join public.profiles pv on pv.id = v.reviewed_by
         where v.change_id = ${id}::uuid and v.organisation_id = ${org}::uuid order by v.reviewed_at desc, v.id`)
    ).rows.map((v) => ({ id: v.id as string, result: v.result as 'effective' | 'not_effective', note: v.note as string, reviewedAt: iso(v.reviewed_at) as string, reviewedBy: (v.by_name as string) ?? null }));
    const labelOf = async (table: string, column: string, rid: unknown) =>
      rid ? ((await db.execute<Row>(sql`select ${sql.raw(column)} as label from ${sql.raw(`public.${table}`)} where id = ${rid as string}::uuid`)).rows[0]?.label as string | undefined) ?? null : null;
    const cutIn = {
      kind: r.cut_in_kind as 'none' | 'date' | 'order' | 'lot' | 'serial',
      date: (r.cut_in_date as string | Date | null) ? (iso(r.cut_in_date) as string).slice(0, 10) : null,
      order: r.cut_in_order_id ? { id: r.cut_in_order_id as string, label: await labelOf('production_orders', 'order_number', r.cut_in_order_id) } : null,
      lot: r.cut_in_lot_id ? { id: r.cut_in_lot_id as string, label: await labelOf('lots', 'lot_number', r.cut_in_lot_id) } : null,
      serial: r.cut_in_serial_id ? { id: r.cut_in_serial_id as string, label: await labelOf('serial_numbers', 'serial_number', r.cut_in_serial_id) } : null,
      stockAction: (r.stock_action as string) ?? null,
      stockNote: (r.stock_note as string) ?? null,
    };
    const target = stage === 'draft' ? 'submit' : stage === 'assessment' ? 'board' : stage === 'verifying' ? 'close' : null;
    const problems = target ? (await db.execute<{ p: string[] }>(sql`select app.change_problems(${id}::uuid, ${target}) as p`)).rows[0].p : [];
    const manage = Boolean(can.manage);
    const finished = finishedStage;
    const day = (v: unknown) => (v ? (iso(v) as string).slice(0, 10) : null);
    return {
      ...toSummary(r),
      description: (r.description as string) ?? null,
      reason: (r.reason as string) ?? null,
      links,
      /** The record it was raised from, or null (a label is null when the caller may not read it). */
      origin,
      attachments,
      closedAt: r.closed_at ? (iso(r.closed_at) as string) : null,
      closedBy: (r.closed_by_name as string) ?? null,
      tasks,
      reviews,
      cancelReason: (r.cancel_reason as string) ?? null,
      cancelledAt: r.cancelled_at ? (iso(r.cancelled_at) as string) : null,
      cancelledBy: (r.cancelled_by_name as string) ?? null,
      reviewRound: Number(r.review_round),
      submittedAt: r.submitted_at ? (iso(r.submitted_at) as string) : null,
      approvedAt: r.approved_at ? (iso(r.approved_at) as string) : null,
      approvedBy: (r.approved_by_name as string) ?? null,
      /** Why it is back in assessment (a sign-off was rejected, or a manager took it back). */
      returnReason: (r.return_reason as string) ?? null,
      /** Whether this type of change usually needs the customer. */
      typeNeedsCustomerApproval: !!r.needs_customer_approval,
      customerApproval: {
        status: (r.customer_approval as string) ?? null,
        reference: (r.customer_reference as string) ?? null,
        on: day(r.customer_approval_on),
        waivedReason: (r.customer_waived_reason as string) ?? null,
      },
      cutIn,
      impacts,
      board,
      signoffs,
      /** What still stands between this change and its next step (draft: to assessment; assessment: to the board). */
      problems,
      /** The caller may raise and manage changes. */
      canManage: manage,
      /** Its wording and scope can still change (a draft, or in assessment); the type only in draft. */
      canEdit: manage && ['draft', 'assessment'].includes(stage),
      canEditType: manage && stage === 'draft',
      canSubmit: manage && stage === 'draft',
      canAssess: manage && stage === 'assessment',
      canSendToBoard: manage && stage === 'assessment',
      canRecall: manage && stage === 'approval',
      canCancel: manage && !finished,
      canAddFiles: manage && !finished,
      /** The cut-in point and the customer's approval can be recorded until the change is finished. */
      canSetCutIn: !finished && (manage || (Boolean(can.approve) && Boolean(can.in_round))),
      canSetCustomerApproval: manage && !finished,
      /** Tasks can be added once the board has approved the change, until it is closed. */
      canAddTask: manage && stageOpenForTasks,
      /** The effectiveness check: when every task is done (the change is verifying). */
      canReview: manage && stage === 'verifying',
    };
  }

  get(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, (db) => this.change(db, ctx, id));
  }

  create(ctx: RequestContext, body: CreateChangeBody) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ id: string }>(sql`select app.create_change(${orgOf(ctx)}::uuid, ${json(body)}::jsonb) as id`);
      return this.change(db, ctx, res.rows[0].id);
    });
  }

  update(ctx: RequestContext, id: string, body: UpdateChangeBody) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.update_change(${id}::uuid, ${json(body)}::jsonb)`);
      return this.change(db, ctx, id);
    });
  }

  submit(ctx: RequestContext, id: string) {
    return this.command(ctx, id, sql`select app.submit_change(${id}::uuid)`);
  }

  setImpact(ctx: RequestContext, id: string, body: ImpactBody) {
    return this.command(ctx, id, sql`select app.set_change_impact(${id}::uuid, ${body.areaId}::uuid, ${body.status}, ${body.note ?? null})`);
  }

  setBoard(ctx: RequestContext, id: string, body: BoardBody) {
    return this.command(ctx, id, sql`select app.set_change_board(${id}::uuid, ${json(body.board)}::jsonb)`);
  }

  sendToBoard(ctx: RequestContext, id: string) {
    return this.command(ctx, id, sql`select app.send_change_to_board(${id}::uuid)`);
  }

  recall(ctx: RequestContext, id: string, reason: string) {
    return this.command(ctx, id, sql`select app.recall_change(${id}::uuid, ${reason})`);
  }

  /** The sign-off belongs to a change; the answer is that whole change. */
  decide(ctx: RequestContext, signoffId: string, body: DecideBody) {
    return this.database.asUser(ctx, async (db) => {
      const found = (await db.execute<Row>(sql`select change_id from public.change_signoffs where id = ${signoffId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`)).rows[0];
      if (!found) throw ApiError.notFound('change_signoff_not_found', 'Sign-off not found');
      await db.execute(sql`select app.decide_change_signoff(${signoffId}::uuid, ${body.approve}, ${body.comment ?? null})`);
      return this.change(db, ctx, found.change_id as string);
    });
  }

  setCutIn(ctx: RequestContext, id: string, body: CutInBody) {
    return this.command(ctx, id, sql`select app.set_change_cut_in(${id}::uuid, ${json(body)}::jsonb)`);
  }

  setCustomerApproval(ctx: RequestContext, id: string, body: CustomerApprovalBody) {
    return this.command(
      ctx,
      id,
      sql`select app.set_change_customer_approval(${id}::uuid, ${body.status}, ${body.reference ?? null}, ${body.on ?? null}::date, ${body.waivedReason ?? null})`,
    );
  }

  /** The people who could be put on the board, and whether each can sign. */
  signers(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`select * from app.change_signer_candidates(${orgOf(ctx)}::uuid)`);
      return { data: res.rows.map((r) => ({ id: r.user_id as string, name: r.name as string, canApprove: !!r.can_approve })) };
    });
  }

  /** Runs one database command, then answers with the whole change. */
  private command(ctx: RequestContext, id: string, statement: SQL) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(statement);
      return this.change(db, ctx, id);
    });
  }

  // ---- tasks, the effectiveness check, My changes (CH3) --------------------------------------------------

  /** Runs a command on a task, then answers with the whole change it belongs to. */
  private taskCommand(ctx: RequestContext, taskId: string, run: (db: Db) => Promise<unknown>) {
    return this.database.asUser(ctx, async (db) => {
      const found = (await db.execute<Row>(sql`select change_id from public.change_tasks where id = ${taskId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`)).rows[0];
      if (!found) throw ApiError.notFound('change_task_not_found', 'Task not found');
      await run(db);
      return this.change(db, ctx, found.change_id as string);
    });
  }

  addTask(ctx: RequestContext, id: string, body: CreateTaskBody) {
    return this.command(ctx, id, sql`select app.add_change_task(${id}::uuid, ${json(body)}::jsonb)`);
  }

  updateTask(ctx: RequestContext, taskId: string, body: UpdateTaskBody) {
    return this.taskCommand(ctx, taskId, (db) => db.execute(sql`select app.update_change_task(${taskId}::uuid, ${json(body)}::jsonb)`));
  }

  linkTask(ctx: RequestContext, taskId: string, body: LinkTaskBody) {
    return this.taskCommand(ctx, taskId, (db) =>
      db.execute(sql`select app.link_change_task(${taskId}::uuid, ${body.link?.kind ?? null}, ${body.link?.id ?? null}::uuid)`));
  }

  completeTask(ctx: RequestContext, taskId: string, body: CompleteTaskBody) {
    return this.taskCommand(ctx, taskId, (db) => db.execute(sql`select app.complete_change_task(${taskId}::uuid, ${body.note ?? null})`));
  }

  cancelTask(ctx: RequestContext, taskId: string, reason: string) {
    return this.taskCommand(ctx, taskId, (db) => db.execute(sql`select app.cancel_change_task(${taskId}::uuid, ${reason})`));
  }

  reopenTask(ctx: RequestContext, taskId: string, reason: string) {
    return this.taskCommand(ctx, taskId, (db) => db.execute(sql`select app.reopen_change_task(${taskId}::uuid, ${reason})`));
  }

  /**
   * Starts the next revision of a part, a control plan or a document and points the task at it, in one transaction: the revision is made as the caller,
   * so what they may do to parts, plans and documents is decided by those modules' own rules; the answer is the whole change and what was started.
   */
  startRevision(ctx: RequestContext, taskId: string, body: StartRevisionBody) {
    return this.database.asUser(ctx, async (db) => {
      const org = orgOf(ctx);
      const found = (await db.execute<Row>(sql`select change_id, status, link_kind from public.change_tasks where id = ${taskId}::uuid and organisation_id = ${org}::uuid`)).rows[0];
      if (!found) throw ApiError.notFound('change_task_not_found', 'Task not found');
      if (found.status !== 'open') throw new ApiError(409, 'change_rule', 'Only an open task can start a revision');
      let linkKind: string;
      let revisionId: string;
      if (body.kind === 'part') {
        const part = (await db.execute<Row>(sql`select id from public.parts where id = ${body.partId}::uuid and organisation_id = ${org}::uuid`)).rows[0];
        if (!part) throw ApiError.notFound('part_not_found', 'Part not found');
        linkKind = 'part_revision';
        revisionId = (
          await db.execute<{ id: string }>(sql`insert into public.part_revisions (organisation_id, part_id, revision, drawing_ref, change_summary)
            values (${org}::uuid, ${body.partId}::uuid, ${body.revision}, ${body.drawingRef ?? null}, ${body.changeSummary ?? null}) returning id`)
        ).rows[0].id;
      } else if (body.kind === 'control_plan') {
        const plan = (await db.execute<Row>(sql`select id from public.control_plans where id = ${body.planId}::uuid and organisation_id = ${org}::uuid`)).rows[0];
        if (!plan) throw ApiError.notFound('control_plan_not_found', 'Control plan not found');
        linkKind = 'control_plan_revision';
        revisionId = (
          await db.execute<{ id: string }>(sql`insert into public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason)
            values (${org}::uuid, ${body.planId}::uuid, ${body.revisionCode}, ${body.changeReason ?? null}) returning id`)
        ).rows[0].id;
      } else {
        const doc = (await db.execute<Row>(sql`select id from public.documents where id = ${body.documentId}::uuid and organisation_id = ${org}::uuid`)).rows[0];
        if (!doc) throw ApiError.notFound('document_not_found', 'Document not found');
        linkKind = 'document_revision';
        revisionId = (await db.execute<{ id: string }>(sql`select app.start_document_revision(${body.documentId}::uuid) as id`)).rows[0].id;
      }
      await db.execute(sql`select app.link_change_task(${taskId}::uuid, ${linkKind}, ${revisionId}::uuid)`);
      const change = await this.change(db, ctx, found.change_id as string);
      return { ...change, started: { kind: linkKind, revisionId } };
    });
  }

  /** The effectiveness check: effective closes the change, not effective sends it back to implementing. */
  review(ctx: RequestContext, id: string, body: ReviewBody) {
    return this.command(ctx, id, sql`select app.record_change_review(${id}::uuid, ${body.effective}, ${body.note})`);
  }

  /** What is waiting for the caller: sign-offs, open tasks, and the changes they raised that are still going. */
  mine(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const org = orgOf(ctx);
      const signoffs = (
        await db.execute<Row>(sql`
          select s.id, s.round, f.label as function_label, c.id as change_id, c.reference, c.title, c.urgency
            from public.change_signoffs s
            join public.change_requests c on c.id = s.change_id join public.change_functions f on f.id = s.function_id
           where s.organisation_id = ${org}::uuid and s.signer_user_id = auth.uid() and s.status = 'pending' and c.stage = 'approval' and s.round = c.review_round
           order by c.urgency desc, s.created_at`)
      ).rows.map((r) => ({ id: r.id as string, changeId: r.change_id as string, reference: r.reference as string, title: r.title as string, urgency: r.urgency as string, functionLabel: r.function_label as string }));
      const tasks = (
        await db.execute<Row>(sql`
          select t.id, t.description, t.due_on, (t.due_on is not null and t.due_on < current_date) as overdue, c.id as change_id, c.reference, c.title, c.stage,
                 app.change_task_link_state(t.id) as link_state, t.link_kind
            from public.change_tasks t join public.change_requests c on c.id = t.change_id
           where t.organisation_id = ${org}::uuid and t.owner_user_id = auth.uid() and t.status = 'open'
           order by t.due_on nulls last, t.created_at`)
      ).rows.map((r) => ({
        id: r.id as string,
        description: r.description as string,
        dueOn: r.due_on ? (iso(r.due_on) as string).slice(0, 10) : null,
        overdue: !!r.overdue,
        changeId: r.change_id as string,
        reference: r.reference as string,
        title: r.title as string,
        linkKind: (r.link_kind as string) ?? null,
        linkState: (r.link_state as string) ?? 'none',
      }));
      const raised = (
        await db.execute<Row>(sql`
          select c.id, c.reference, c.title, c.stage, c.urgency from public.change_requests c
           where c.organisation_id = ${org}::uuid and c.raised_by = auth.uid() and c.stage not in ('closed', 'rejected', 'cancelled')
           order by c.updated_at desc limit 50`)
      ).rows.map((r) => ({ id: r.id as string, reference: r.reference as string, title: r.title as string, stage: r.stage as string, urgency: r.urgency as string }));
      return { signoffs, tasks, raised, counts: { signoffs: signoffs.length, tasks: tasks.length, overdue: tasks.filter((t) => t.overdue).length, total: signoffs.length + tasks.length } };
    });
  }

  /** The menu badge: sign-offs waiting plus open tasks. */
  async mineCount(ctx: RequestContext) {
    const mine = await this.mine(ctx);
    return mine.counts;
  }

  setLinks(ctx: RequestContext, id: string, links: LinkItem[]) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.set_change_links(${id}::uuid, ${json(links)}::jsonb)`);
      return this.change(db, ctx, id);
    });
  }

  cancel(ctx: RequestContext, id: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.cancel_change(${id}::uuid, ${reason})`);
      return this.change(db, ctx, id);
    });
  }

  // ---- files ---------------------------------------------------------------------------------------

  listAttachments(ctx: RequestContext, id: string, q: z.infer<typeof DeletedQuery>) {
    return this.database.asUser(ctx, async (db) => {
      await this.change(db, ctx, id);
      const filter = q.deleted === 'exclude' ? sql`a.deleted_at is null` : q.deleted === 'only' ? sql`a.deleted_at is not null` : sql`true`;
      const rows = await db.execute<Row>(sql`${ATTACHMENT_SELECT} where a.change_id = ${id}::uuid and ${filter} order by a.created_at desc`);
      return rows.rows.map(toAttachment);
    });
  }

  /** Records a file the client has already uploaded to storage at <org>/change/<id>/<name>. */
  createAttachment(ctx: RequestContext, id: string, body: z.infer<typeof CreateAttachmentBody>) {
    return this.database.asUser(ctx, async (db) => {
      await this.change(db, ctx, id);
      const folder = `${orgOf(ctx)}/change/${id}/`;
      if (!body.storagePath.startsWith(folder) || body.storagePath.includes('..') || body.storagePath.length === folder.length) {
        throw ApiError.badRequest('invalid_path', `Files for this change must be uploaded to ${folder}`);
      }
      const stored = await db.execute(sql`select 1 from storage.objects where bucket_id = 'change-files' and name = ${body.storagePath}`);
      if (!stored.rows.length) throw ApiError.badRequest('file_not_uploaded', 'Upload the file before attaching it');
      const res = await db.execute<{ id: string }>(
        sql`select app.add_change_attachment(${id}::uuid, ${body.storagePath}, ${body.fileName}, ${body.contentType ?? null}, ${body.sizeBytes}::bigint, ${body.description ?? null}) as id`,
      );
      return this.loadAttachment(db, ctx, res.rows[0].id);
    });
  }

  private async loadAttachment(db: Db, ctx: RequestContext, id: string) {
    const res = await db.execute<Row>(sql`${ATTACHMENT_SELECT} where a.id = ${id}::uuid and a.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!res.rows.length) throw ApiError.notFound('attachment_not_found', 'File not found');
    return toAttachment(res.rows[0]);
  }

  removeAttachment(ctx: RequestContext, attachmentId: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.loadAttachment(db, ctx, attachmentId);
      await db.execute(sql`select app.remove_change_attachment(${attachmentId}::uuid, ${reason})`);
      return this.loadAttachment(db, ctx, attachmentId);
    });
  }

  restoreAttachment(ctx: RequestContext, attachmentId: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.loadAttachment(db, ctx, attachmentId);
      await db.execute(sql`select app.restore_change_attachment(${attachmentId}::uuid)`);
      return this.loadAttachment(db, ctx, attachmentId);
    });
  }
}
