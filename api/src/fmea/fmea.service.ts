import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { linkState } from './fmea-coverage';
import { ApproveBody, CreateFmeaBody, FmeaListQuery, LinkItem, ReviewBody, TeamItem, UpdateFmeaBody, UpdateRevisionBody } from './fmea.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown' } : null);
const json = (v: unknown) => JSON.stringify(v);

const LINK_COLUMN: Record<string, string> = {
  part: 'part_id', part_family: 'part_family_id', control_plan: 'control_plan_id', machine: 'machine_id', supplier: 'supplier_id', customer: 'customer_id',
};
const KIND_ORDER = ['part', 'part_family', 'control_plan', 'machine', 'supplier', 'customer', 'operation_code'];
const TARGET = sql.raw(`coalesce(${Object.values(LINK_COLUMN).map((c) => `l.${c}`).join(', ')})`);

/** The records an FMEA covers, each read under the caller's own rules, so a record they may not read has no label. */
const labelledLinks = (revisionId: string, org: string) => sql`
  select l.kind, ${TARGET} as target_id, l.operation_code, l.created_at,
         coalesce(p.part_number, pf.code, cp.plan_code, m.code, s.code, c.code) as t_reference,
         coalesce(p.name, pf.name, cp.title, m.name, s.name, c.name) as t_name
    from public.fmea_links l
    left join public.parts p on l.kind = 'part' and p.id = l.part_id
    left join public.part_families pf on l.kind = 'part_family' and pf.id = l.part_family_id
    left join public.control_plans cp on l.kind = 'control_plan' and cp.id = l.control_plan_id
    left join public.machines m on l.kind = 'machine' and m.id = l.machine_id
    left join public.suppliers s on l.kind = 'supplier' and s.id = l.supplier_id
    left join public.customers c on l.kind = 'customer' and c.id = l.customer_id
   where l.revision_id = ${revisionId}::uuid and l.organisation_id = ${org}::uuid`;

const toLink = (r: Row) => ({
  kind: r.kind as string,
  id: (r.target_id as string) ?? null,
  code: (r.operation_code as string) ?? null,
  reference: r.kind === 'operation_code' ? (r.operation_code as string) : ((r.t_reference as string) ?? null),
  name: (r.t_name as string) ?? null,
  readable: r.kind === 'operation_code' || r.t_reference != null,
});

/** The register's row: an FMEA with who owns it, the revision in force, the one in progress, and what it covers. */
const FMEA_SELECT = sql`
  select f.*, ${sql.raw(personName('po'))} as owner_name, cu.name as customer_name, cu.code as customer_code,
         cr.letter as current_letter, cr.effective_from as current_effective_from, cr.status as current_status,
         ip.id as open_revision_id, ip.status as open_status, ip.letter as open_letter, ip.approver_id as open_approver_id,
         (ip.status = 'pending_approval' and ip.approver_id = auth.uid()) as waiting_for_me,
         (f.status = 'active' and f.next_review_on is not null and f.next_review_on < current_date) as review_overdue,
         (select count(*)::int from public.fmea_team_members t where t.revision_id = coalesce(ip.id, f.current_revision_id)) as team_count,
         (select string_agg(coalesce(p.part_number, pf.code, cp.plan_code, m.code, s.code, c.code, l.operation_code), ' ')
            from public.fmea_links l
            left join public.parts p on p.id = l.part_id left join public.part_families pf on pf.id = l.part_family_id left join public.control_plans cp on cp.id = l.control_plan_id
            left join public.machines m on m.id = l.machine_id left join public.suppliers s on s.id = l.supplier_id left join public.customers c on c.id = l.customer_id
           where l.revision_id = coalesce(ip.id, f.current_revision_id)) as link_text
    from public.fmeas f
    left join public.profiles po on po.id = f.owner_user_id
    left join public.customers cu on cu.id = f.customer_id
    left join public.fmea_revisions cr on cr.id = f.current_revision_id
    left join lateral (select r.* from public.fmea_revisions r where r.fmea_id = f.id and r.status in ('draft', 'pending_approval', 'approved') limit 1) ip on true`;

const SORT: Record<FmeaListQuery['sort'], string> = {
  number: 'f.number',
  title: 'lower(f.title)',
  kind: 'f.kind',
  status: 'f.status',
  owner: 'lower(f.owner_name)',
  customer: 'lower(f.customer_name)',
  effective: 'f.current_effective_from',
  nextReview: 'f.next_review_on',
  updatedAt: 'f.updated_at',
};

const toSummary = (r: Row) => ({
  id: r.id as string,
  number: r.number as string,
  kind: r.kind as 'design' | 'process',
  title: r.title as string,
  scopeText: (r.scope_text as string) ?? null,
  status: r.status as 'draft' | 'active' | 'withdrawn' | 'discarded',
  owner: person(r.owner_user_id, r.owner_name),
  customer: r.customer_id ? { id: r.customer_id as string, name: (r.customer_name as string) ?? '', code: (r.customer_code as string) ?? null } : null,
  currentRevisionId: (r.current_revision_id as string) ?? null,
  currentLetter: (r.current_letter as string) ?? null,
  currentEffectiveFrom: (r.current_effective_from as string) ?? null,
  openRevisionId: (r.open_revision_id as string) ?? null,
  openStatus: (r.open_status as string) ?? null,
  openLetter: (r.open_letter as string) ?? null,
  waitingForMe: !!r.waiting_for_me,
  reviewMonths: r.review_months == null ? null : Number(r.review_months),
  nextReviewOn: (r.next_review_on as string) ?? null,
  reviewOverdue: !!r.review_overdue,
  teamCount: Number(r.team_count ?? 0),
  withdrawReason: (r.withdraw_reason as string) ?? null,
  createdAt: iso(r.created_at) as string,
  updatedAt: iso(r.updated_at) as string,
});

/** An action with the person it is given to, whether that is the caller, and whether it is late (as the caller's own day). */
export const ACTION_SELECT = sql`
  select a.*, (a.status = 'open' and a.due_on < current_date) as overdue,
         (a.owner_user_id = auth.uid() or e.auth_id = auth.uid()) as is_mine,
         coalesce(${sql.raw(personName('e'))}, ${sql.raw(personName('op'))}, 'Unnamed') as owner_name,
         ${sql.raw(personName('dp'))} as done_by_name
    from public.fmea_actions a
    left join public."Employees" e on e.id = a.owner_employee_id and e.organisation_id = a.organisation_id
    left join public.profiles op on op.id = a.owner_user_id
    left join public.profiles dp on dp.id = a.done_by`;

/** The plan characteristic a carried control names, as the caller can read it: its name and criticality, looked for on the revision in force first, then on any live revision. */
const planChar = (select: string, statuses: string) => `(select ${select} from public.control_plan_revisions cr
    join public.control_plan_operations o on o.control_plan_revision_id = cr.id and upper(o.operation_code) = upper(l.operation_code)
    join public.control_plan_characteristics ch on ch.control_plan_revision_id = cr.id and ch.operation_id = o.id and ch.characteristic_key = l.characteristic_key
   where cr.control_plan_id = l.control_plan_id and cr.organisation_id = l.organisation_id and cr.status in (${statuses})
   order by (cr.status = 'effective') desc, cr.created_at desc limit 1)`;
const LIVE_PLAN = "'effective', 'approved', 'pending_approval', 'draft'";
/** Controls carried to a control plan (FM5a): with the plan, the characteristic as it is now, and whether the plan in force has it. Read under the caller's own rights. */
export const LINK_SELECT = sql`
  select l.*, p.plan_code, p.title as plan_title,
         ${sql.raw(planChar('ch.name', LIVE_PLAN))} as char_name,
         ${sql.raw(planChar('ch.criticality', LIVE_PLAN))} as char_criticality,
         (${sql.raw(planChar('true', "'effective'"))}) is not null as in_force
    from public.fmea_control_links l
    left join public.control_plans p on p.id = l.control_plan_id and p.organisation_id = l.organisation_id`;

/** One carried control as the screens see it. `canReadPlans`: the caller may read control plans; `canEnd`: the caller may end it. */
export const toControlLink = (l: Row, canReadPlans: boolean, canEnd: boolean) => ({
  id: l.id as string,
  causeId: l.cause_id as string,
  revisionId: l.revision_id as string,
  kind: l.control_kind as 'prevention' | 'detection',
  plan: l.plan_code ? { id: l.control_plan_id as string, code: l.plan_code as string, title: (l.plan_title as string) ?? '' } : null,
  operationCode: l.operation_code as string,
  characteristicKey: l.characteristic_key as string,
  characteristicName: (l.char_name as string) ?? null,
  criticality: (l.char_criticality as 'critical' | 'major' | 'minor' | null) ?? null,
  note: (l.note as string) ?? null,
  createdAt: iso(l.created_at) as string,
  state: linkState(canReadPlans, Boolean(l.in_force), l.char_name != null),
  carried: l.prev_row_id != null,
  canEnd,
});

const num = (v: unknown) => (v == null ? null : Number(v));

/** One action as the screens see it. `live` = its revision is a draft or in force; `canManage` = the caller manages FMEAs. */
export const toAction = (a: Row, live: boolean, canManage: boolean) => {
  const open = a.status === 'open';
  return {
    id: a.id as string,
    causeId: a.cause_id as string,
    revisionId: a.revision_id as string,
    kind: a.kind as 'prevention' | 'detection',
    description: a.description as string,
    owner: { kind: (a.owner_employee_id ? 'employee' : 'member') as 'employee' | 'member', id: (a.owner_employee_id ?? a.owner_user_id) as string, name: a.owner_name as string },
    dueOn: a.due_on as string,
    status: a.status as 'open' | 'done' | 'cancelled',
    overdue: Boolean(a.overdue),
    evidenceNote: (a.evidence_note as string) ?? null,
    doneAt: a.done_at ? iso(a.done_at) : null,
    doneBy: person(a.done_by, a.done_by_name),
    revisedOccurrence: num(a.revised_occurrence),
    revisedDetection: num(a.revised_detection),
    revisedRpn: num(a.revised_rpn),
    revisedPriority: (a.revised_priority as 'high' | 'medium' | 'low' | null) ?? null,
    revisedNeedsAttention: a.revised_needs_attention == null ? null : Boolean(a.revised_needs_attention),
    cancelReason: (a.cancel_reason as string) ?? null,
    adopted: a.adopted_in_revision_id != null,
    carried: a.prev_row_id != null,
    isMine: Boolean(a.is_mine),
    /** The caller may finish it: a manager, or the person it is given to; while it is open on a draft or the revision in force. */
    canComplete: live && open && (canManage || Boolean(a.is_mine)),
    canReopen: live && a.status === 'done' && a.adopted_in_revision_id == null && (canManage || Boolean(a.is_mine)),
    canEdit: live && open && canManage,
    createdAt: iso(a.created_at) as string,
  };
};

/** FMEA (FM1): the analysis record, its revisions, team and scope. Every write is a database function; reading is by RLS. */
@Injectable()
export class FmeaService {
  constructor(private readonly database: DatabaseService) {}

  /** Approved revisions whose date has come take effect (no worker needed): run before every read. */
  private settle(db: Db, ctx: RequestContext) {
    return db.execute(sql`select app.settle_fmeas(${orgOf(ctx)}::uuid)`);
  }

  // ---- the register ---------------------------------------------------------------------------------

  list(ctx: RequestContext, q: FmeaListQuery) {
    return this.database.asUser(ctx, async (db) => {
      await this.settle(db, ctx);
      const where: SQL[] = [sql`f.organisation_id = ${orgOf(ctx)}::uuid`];
      const statuses = (q.status ?? 'live').split(',');
      if (!statuses.includes('all')) {
        const named = statuses.filter((s) => s !== 'live');
        where.push(
          statuses.includes('live')
            ? sql`(f.status in ('draft', 'active') or f.status = any(string_to_array(${named.join(',')}, ',')))`
            : sql`f.status = any(string_to_array(${named.join(',')}, ','))`,
        );
      }
      if (q.kind) where.push(sql`f.kind = any(string_to_array(${q.kind}, ','))`);
      if (q.owner === 'me') where.push(sql`f.owner_user_id = auth.uid()`);
      if (q.waiting === 'me') where.push(sql`f.waiting_for_me`);
      if (q.reviewOverdue) where.push(sql`f.review_overdue`);
      if (q.customerId) where.push(sql`f.customer_id = ${q.customerId}::uuid`);
      const linked = (column: string, id: string) =>
        where.push(sql`exists (select 1 from public.fmea_links l join public.fmea_revisions r on r.id = l.revision_id
                                where r.fmea_id = f.id and r.status in ('draft', 'pending_approval', 'approved', 'effective') and ${sql.raw(`l.${column}`)} = ${id}::uuid)`);
      if (q.partId) linked('part_id', q.partId);
      if (q.partFamilyId) linked('part_family_id', q.partFamilyId);
      if (q.controlPlanId) linked('control_plan_id', q.controlPlanId);
      if (q.machineId) linked('machine_id', q.machineId);
      if (q.q) {
        const p = likePattern(q.q);
        where.push(sql`(f.number ilike ${p} escape '\\' or f.title ilike ${p} escape '\\' or f.scope_text ilike ${p} escape '\\'
                        or f.link_text ilike ${p} escape '\\' or f.owner_name ilike ${p} escape '\\' or f.customer_name ilike ${p} escape '\\')`);
      }
      const filter = sql.join(where, sql` and `);
      const total = (await db.execute<Row>(sql`select count(*)::int as n from (${FMEA_SELECT}) f where ${filter}`)).rows[0];
      const rows = (
        await db.execute<Row>(sql`
          select * from (${FMEA_SELECT}) f where ${filter}
           order by ${sql.raw(SORT[q.sort])} ${sql.raw(q.order === 'desc' ? 'desc nulls last' : 'asc nulls last')}, f.number
           limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`)
      ).rows;
      return { data: rows.map(toSummary), page: q.page, pageSize: q.pageSize, total: Number(total.n) };
    });
  }

  /** Members who may be named on a team or as approver. */
  people(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const rows = (await db.execute<Row>(sql`select * from app.fmea_people(${orgOf(ctx)}::uuid)`)).rows;
      return { data: rows.map((r) => ({ id: r.user_id as string, name: r.name as string, canApprove: !!r.can_approve })) };
    });
  }

  // ---- one FMEA --------------------------------------------------------------------------------------

  private async fmea(db: Db, ctx: RequestContext, id: string) {
    const org = orgOf(ctx);
    const rows = (await db.execute<Row>(sql`select * from (${FMEA_SELECT}) f where f.id = ${id}::uuid and f.organisation_id = ${org}::uuid`)).rows;
    if (rows.length === 0) throw ApiError.notFound('fmea_not_found', 'FMEA not found');
    const r = rows[0];
    const can = (
      await db.execute<Row>(sql`
        select app.has_permission(${org}::uuid, 'fmea.manage') as manage, app.has_permission(${org}::uuid, 'fmea.approve') as approve,
               app.document_letter_after(${(r.last_letter as string) ?? null}::text) as next_letter`)
    ).rows[0];
    const revisions = (
      await db.execute<Row>(sql`
        select v.*, ${sql.raw(personName('pa'))} as author_name, ${sql.raw(personName('pp'))} as approver_name
          from public.fmea_revisions v left join public.profiles pa on pa.id = v.author_id left join public.profiles pp on pp.id = v.approver_id
         where v.fmea_id = ${id}::uuid and v.organisation_id = ${org}::uuid order by v.sequence desc`)
    ).rows.map((v) => ({
      id: v.id as string,
      sequence: Number(v.sequence),
      letter: (v.letter as string) ?? null,
      status: v.status as string,
      changeSummary: (v.change_summary as string) ?? null,
      author: person(v.author_id, v.author_name),
      approver: person(v.approver_id, v.approver_name),
      submittedAt: v.submitted_at ? iso(v.submitted_at) : null,
      approvedAt: v.approved_at ? iso(v.approved_at) : null,
      effectiveFrom: (v.effective_from as string) ?? null,
      discardReason: (v.discard_reason as string) ?? null,
      withdrawReason: (v.withdraw_reason as string) ?? null,
    }));
    const open = revisions.find((v) => ['draft', 'pending_approval', 'approved'].includes(v.status)) ?? null;
    const status = r.status as string;
    const adoptable = r.current_revision_id
      ? Number(
          (
            await db.execute<Row>(sql`select count(*)::int as n from public.fmea_actions
                                       where revision_id = ${r.current_revision_id as string}::uuid and organisation_id = ${org}::uuid and status = 'done' and adopted_in_revision_id is null`)
          ).rows[0].n,
        )
      : 0;
    const reviews = (
      await db.execute<Row>(sql`
        select v.*, ${sql.raw(personName('pc'))} as by_name, rv.letter as revision_letter, sv.letter as started_letter
          from public.fmea_reviews v join public.fmea_revisions rv on rv.id = v.revision_id left join public.fmea_revisions sv on sv.id = v.started_revision_id
          left join public.profiles pc on pc.id = v.created_by
         where v.fmea_id = ${id}::uuid and v.organisation_id = ${org}::uuid order by v.created_at desc limit 50`)
    ).rows.map((v) => ({
      id: v.id as string,
      outcome: v.outcome as 'no_change' | 'revision_started',
      note: (v.note as string) ?? null,
      revisionLetter: (v.revision_letter as string) ?? null,
      startedLetter: (v.started_letter as string) ?? null,
      wasDueOn: (v.was_due_on as string) ?? null,
      nextReviewOn: (v.next_review_on as string) ?? null,
      by: person(v.created_by, v.by_name),
      at: iso(v.created_at) as string,
    }));
    return {
      ...toSummary(r),
      revisions,
      inProgress: open ? { id: open.id, status: open.status, letter: open.letter, sequence: open.sequence } : null,
      nextLetter: (can.next_letter as string) ?? 'A',
      canManage: Boolean(can.manage) && status !== 'discarded',
      canApprove: Boolean(can.approve),
      baseFmeaId: (r.base_fmea_id as string) ?? null,
      canStartRevision: Boolean(can.manage) && ['active', 'withdrawn'].includes(status) && !open,
      canWithdraw: Boolean(can.approve) && status === 'active',
      /** Finished actions on the revision in force that a new revision can take in (their words into the controls, their revised ratings into the causes). */
      adoptableActions: adoptable,
      reviews,
      canReview: Boolean(can.manage) && status === 'active',
    };
  }

  async get(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.settle(db, ctx);
      return this.fmea(db, ctx, id);
    });
  }

  create(ctx: RequestContext, body: CreateFmeaBody) {
    return this.database.asUser(ctx, async (db) => {
      const created = (await db.execute<Row>(sql`select app.create_fmea(${orgOf(ctx)}::uuid, ${json(body)}::jsonb) as id`)).rows[0];
      return this.fmea(db, ctx, created.id as string);
    });
  }

  update(ctx: RequestContext, id: string, body: UpdateFmeaBody) {
    return this.fmeaCommand(ctx, id, sql`select app.update_fmea(${id}::uuid, ${json(body)}::jsonb)`);
  }

  startRevision(ctx: RequestContext, id: string, adopt = false) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.start_fmea_revision(${id}::uuid, ${adopt})`);
      return this.fmea(db, ctx, id);
    });
  }

  /** The periodic review of an FMEA in force: "no change needed" (with a note) or "a revision is started". */
  review(ctx: RequestContext, id: string, body: ReviewBody) {
    return this.fmeaCommand(ctx, id, sql`select app.record_fmea_review(${id}::uuid, ${body.outcome}, ${body.note ?? null})`);
  }

  withdraw(ctx: RequestContext, id: string, reason: string) {
    return this.fmeaCommand(ctx, id, sql`select app.withdraw_fmea(${id}::uuid, ${reason})`);
  }

  private fmeaCommand(ctx: RequestContext, id: string, statement: SQL) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(statement);
      return this.fmea(db, ctx, id);
    });
  }

  // ---- one revision ----------------------------------------------------------------------------------

  async revision(db: Db, ctx: RequestContext, id: string) {
    const org = orgOf(ctx);
    const found = (
      await db.execute<Row>(sql`
        select v.*, app.row_version(v.updated_at) as row_version, f.number, f.kind, f.title, f.status as fmea_status, f.owner_user_id, f.review_months,
               ${sql.raw(personName('pa'))} as author_name, ${sql.raw(personName('pp'))} as approver_name, ${sql.raw(personName('pr'))} as returned_by_name,
               ${sql.raw(personName('pb'))} as approved_by_name, ${sql.raw(personName('ps'))} as submitted_by_name
          from public.fmea_revisions v join public.fmeas f on f.id = v.fmea_id
          left join public.profiles pa on pa.id = v.author_id left join public.profiles pp on pp.id = v.approver_id left join public.profiles pr on pr.id = v.returned_by
          left join public.profiles pb on pb.id = v.approved_by left join public.profiles ps on ps.id = v.submitted_by
         where v.id = ${id}::uuid and v.organisation_id = ${org}::uuid`)
    ).rows;
    if (found.length === 0) throw ApiError.notFound('fmea_revision_not_found', 'Revision not found');
    const r = found[0];
    const can = (
      await db.execute<Row>(sql`select app.has_permission(${org}::uuid, 'fmea.manage') as manage, app.has_permission(${org}::uuid, 'fmea.approve') as approve, app.has_permission(${org}::uuid, 'process_control.read') as plans, auth.uid() as me`)
    ).rows[0];
    const team = (
      await db.execute<Row>(sql`
        select t.id, t.role, t.employee_id, t.user_id, e.job_title,
               coalesce(${sql.raw(personName('e'))}, ${sql.raw(personName('p'))}, 'Unnamed') as name
          from public.fmea_team_members t left join public."Employees" e on e.id = t.employee_id left join public.profiles p on p.id = t.user_id
         where t.revision_id = ${id}::uuid and t.organisation_id = ${org}::uuid
         order by (t.role = 'lead') desc, name`)
    ).rows.map((t) => ({
      id: t.id as string,
      kind: (t.employee_id ? 'employee' : 'member') as 'employee' | 'member',
      personId: (t.employee_id ?? t.user_id) as string,
      name: t.name as string,
      jobTitle: (t.job_title as string) ?? null,
      role: t.role as string,
    }));
    const links = (await db.execute<Row>(labelledLinks(id, org))).rows
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || KIND_ORDER.indexOf(a.kind as string) - KIND_ORDER.indexOf(b.kind as string))
      .map(toLink);
    const problems = ((await db.execute<Row>(sql`select app.fmea_revision_problems(${id}::uuid) as p`)).rows[0].p as string[] | null) ?? [];
    const status = r.status as string;
    const [net, model, base] = await Promise.all([this.net(db, id, org, { status, canManage: Boolean(can.manage), canReadPlans: Boolean(can.plans), me: (can.me as string) ?? null }), this.model(db, r.model_id as string, r.kind as string, org), this.base(db, r, org)]);
    const mine = r.approver_id != null && r.approver_id === can.me;
    return {
      id: r.id as string,
      fmeaId: r.fmea_id as string,
      fmea: { id: r.fmea_id as string, number: r.number as string, kind: r.kind as 'design' | 'process', title: r.title as string, status: r.fmea_status as string },
      sequence: Number(r.sequence),
      letter: (r.letter as string) ?? null,
      status,
      author: person(r.author_id, r.author_name),
      approver: person(r.approver_id, r.approver_name),
      changeSummary: (r.change_summary as string) ?? null,
      previousRevisionId: (r.previous_revision_id as string) ?? null,
      submittedAt: r.submitted_at ? iso(r.submitted_at) : null,
      submittedBy: person(r.submitted_by, r.submitted_by_name),
      returnedComment: (r.returned_comment as string) ?? null,
      returnedAt: r.returned_at ? iso(r.returned_at) : null,
      returnedBy: person(r.returned_by, r.returned_by_name),
      approvalComment: (r.approval_comment as string) ?? null,
      approvedAt: r.approved_at ? iso(r.approved_at) : null,
      approvedBy: person(r.approved_by, r.approved_by_name),
      effectiveFrom: (r.effective_from as string) ?? null,
      supersededAt: r.superseded_at ? iso(r.superseded_at) : null,
      withdrawReason: (r.withdraw_reason as string) ?? null,
      discardReason: (r.discard_reason as string) ?? null,
      team,
      links,
      problems,
      net,
      model,
      base,
      canEdit: Boolean(can.manage) && status === 'draft',
      /** The caller may give actions to causes: a manager, on a draft or on the revision in force. */
      canAct: Boolean(can.manage) && (status === 'draft' || status === 'effective'),
      /** The caller is the named approver, it is waiting, and nothing (the approve right, the preparer rule) stands in the way. */
      canDecide: mine && status === 'pending_approval' && Boolean(can.approve) && r.author_id !== can.me,
      canRecall: Boolean(can.manage) && status === 'pending_approval',
      /** The version a save of this revision's own fields (the wording of what changed) is based on; node commands answer with the new one. */
      rowVersion: r.row_version as string,
      createdAt: iso(r.created_at) as string,
      updatedAt: iso(r.updated_at) as string,
    };
  }

  /** The analysis of a revision as a tree: items (nested), each with its functions, failure modes, effects and causes. Read as the caller; five queries for any size. */
  private async net(db: Db, revisionId: string, org: string, who: { status: string; canManage: boolean; canReadPlans: boolean; me: string | null }) {
    const where = sql`revision_id = ${revisionId}::uuid and organisation_id = ${org}::uuid`;
    const [items, functions, modes, effects, causes, actions, links] = await Promise.all([
      db.execute<Row>(sql`select i.*, m.code as machine_code, m.name as machine_name, p.part_number, p.name as part_name from public.fmea_items i
                           left join public.machines m on m.id = i.machine_id left join public.parts p on p.id = i.part_id
                          where i.revision_id = ${revisionId}::uuid and i.organisation_id = ${org}::uuid order by i.position, i.created_at`),
      db.execute<Row>(sql`select * from public.fmea_functions where ${where} order by position, created_at`),
      db.execute<Row>(sql`select * from public.fmea_failure_modes where ${where} order by position, created_at`),
      db.execute<Row>(sql`select * from public.fmea_effects where ${where} order by position, created_at`),
      db.execute<Row>(sql`select * from public.fmea_causes where ${where} order by position, created_at`),
      db.execute<Row>(sql`${ACTION_SELECT} where a.revision_id = ${revisionId}::uuid and a.organisation_id = ${org}::uuid order by a.due_on, a.created_at`),
      db.execute<Row>(sql`${LINK_SELECT} where l.revision_id = ${revisionId}::uuid and l.organisation_id = ${org}::uuid and l.ended_at is null order by l.created_at`),
    ]);
    const n = (v: unknown) => (v == null ? null : Number(v));
    const group = <T extends Row>(rows: T[], key: string) => {
      const m = new Map<string, T[]>();
      for (const r of rows) m.set(r[key] as string, [...(m.get(r[key] as string) ?? []), r]);
      return m;
    };
    const fByItem = group(functions.rows, 'item_id');
    const mByFn = group(modes.rows, 'function_id');
    const eByMode = group(effects.rows, 'failure_mode_id');
    const cByMode = group(causes.rows, 'failure_mode_id');
    const aByCause = group(actions.rows, 'cause_id');
    const lByCause = group(links.rows, 'cause_id');
    const live = who.status === 'draft' || who.status === 'effective';
    const cause = (c: Row) => ({
      id: c.id as string, text: c.text as string, preventionControls: (c.prevention_controls as string) ?? null, detectionControls: (c.detection_controls as string) ?? null,
      occurrence: n(c.occurrence), detection: n(c.detection), severityUsed: n(c.severity_used), rpn: n(c.rpn),
      priority: (c.priority as 'high' | 'medium' | 'low' | null) ?? null, needsAttention: c.needs_attention == null ? null : Boolean(c.needs_attention),
      noActionReason: (c.no_action_reason as string) ?? null, position: Number(c.position), fromBase: c.base_row_id != null,
      actions: (aByCause.get(c.id as string) ?? []).map((a) => toAction(a, live, who.canManage)),
      /** The controls carried to a control plan (live ones only): where each stands against the plan now. */
      controlLinks: (lByCause.get(c.id as string) ?? []).map((l) => toControlLink(l, who.canReadPlans, who.canManage && live)),
    });
    const mode = (m: Row) => ({
      id: m.id as string, text: m.text as string, specialClass: (m.special_class as 'critical' | 'significant' | null) ?? null, position: Number(m.position), fromBase: m.base_row_id != null,
      effects: (eByMode.get(m.id as string) ?? []).map((e) => ({
        id: e.id as string, level: e.level as 'own_plant' | 'next_plant' | 'end_user', text: e.text as string, severity: n(e.severity), position: Number(e.position), fromBase: e.base_row_id != null,
      })),
      causes: (cByMode.get(m.id as string) ?? []).map(cause),
    });
    const fn = (f: Row) => ({
      id: f.id as string, text: f.text as string, requirement: (f.requirement as string) ?? null, characteristicKey: (f.characteristic_key as string) ?? null,
      position: Number(f.position), fromBase: f.base_row_id != null, failureModes: (mByFn.get(f.id as string) ?? []).map(mode),
    });
    type Node = {
      id: string; kind: string; elementType: string | null; name: string; description: string | null; operationCode: string | null;
      machine: { id: string; code: string; name: string } | null; part: { id: string; partNumber: string; name: string } | null;
      position: number; fromBase: boolean; functions: ReturnType<typeof fn>[]; children: Node[];
    };
    const nodes = new Map<string, Node>(
      items.rows.map((i) => [
        i.id as string,
        {
          id: i.id as string, kind: i.kind as string, elementType: (i.element_type as string) ?? null, name: i.name as string, description: (i.description as string) ?? null,
          operationCode: (i.operation_code as string) ?? null,
          machine: i.machine_id ? { id: i.machine_id as string, code: (i.machine_code as string) ?? '', name: (i.machine_name as string) ?? '' } : null,
          part: i.part_id ? { id: i.part_id as string, partNumber: (i.part_number as string) ?? '', name: (i.part_name as string) ?? '' } : null,
          position: Number(i.position), fromBase: i.base_row_id != null, functions: (fByItem.get(i.id as string) ?? []).map(fn), children: [],
        },
      ]),
    );
    const roots: Node[] = [];
    for (const i of items.rows) {
      const node = nodes.get(i.id as string)!;
      const parent = i.parent_id ? nodes.get(i.parent_id as string) : undefined;
      (parent ? parent.children : roots).push(node);
    }
    const counts = { items: items.rows.length, functions: functions.rows.length, failureModes: modes.rows.length, effects: effects.rows.length, causes: causes.rows.length,
      needAttention: causes.rows.filter((c) => c.needs_attention).length, unrated: causes.rows.filter((c) => c.rpn == null).length,
      openActions: actions.rows.filter((a) => a.status === 'open').length, doneActions: actions.rows.filter((a) => a.status === 'done').length,
      overdueActions: actions.rows.filter((a) => a.overdue).length, controlLinks: links.rows.length };
    return { items: roots, counts };
  }

  /** The rating model this revision is scored with (frozen on it), what S, O and D mean on it for this kind of FMEA, and whether a newer version exists. */
  private async model(db: Db, modelId: string, kind: string, org: string) {
    const m = (await db.execute<Row>(sql`select id, version, config from public.fmea_models where id = ${modelId}::uuid and organisation_id = ${org}::uuid`)).rows[0];
    const latest = (await db.execute<Row>(sql`select id, version from public.fmea_models where organisation_id = ${org}::uuid and current`)).rows[0];
    if (!m) return null;
    const cfg = m.config as { method: 'rpn' | 'ap'; rpnHighFrom: number; rpnMediumFrom: number; severityFloor: number; scales: Record<string, unknown> };
    return {
      id: m.id as string, version: Number(m.version), method: cfg.method, rpnHighFrom: Number(cfg.rpnHighFrom), rpnMediumFrom: Number(cfg.rpnMediumFrom), severityFloor: Number(cfg.severityFloor),
      scale: cfg.scales[kind] as { severity: { label: string; criteria?: string }[]; occurrence: { label: string; criteria?: string }[]; detection: { label: string; criteria?: string }[] },
      latestVersion: latest ? Number(latest.version) : Number(m.version), isLatest: !latest || latest.id === m.id,
    };
  }

  /** The FMEA this one started from, and the revision of it that was copied. A base the caller may not read has no name. */
  private async base(db: Db, r: Row, org: string) {
    if (!r.based_on_revision_id) return null;
    const b = (
      await db.execute<Row>(sql`
        select f.id, f.number, f.title, v.letter, v.id as revision_id from public.fmea_revisions v join public.fmeas f on f.id = v.fmea_id
         where v.id = ${r.based_on_revision_id as string}::uuid and v.organisation_id = ${org}::uuid`)
    ).rows[0];
    return b ? { fmeaId: b.id as string, number: b.number as string, title: b.title as string, revisionId: b.revision_id as string, letter: (b.letter as string) ?? null } : { fmeaId: null, number: null, title: null, revisionId: r.based_on_revision_id as string, letter: null };
  }

  async getRevision(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.settle(db, ctx);
      return this.revision(db, ctx, id);
    });
  }

  /** Runs one database command on a revision, then answers with the whole revision. */
  private command(ctx: RequestContext, id: string, statement: SQL) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(statement);
      return this.revision(db, ctx, id);
    });
  }

  updateRevision(ctx: RequestContext, id: string, body: UpdateRevisionBody) {
    return this.command(ctx, id, sql`select app.update_fmea_revision(${id}::uuid, ${json(body)}::jsonb)`);
  }

  setTeam(ctx: RequestContext, id: string, team: TeamItem[]) {
    return this.command(ctx, id, sql`select app.set_fmea_team(${id}::uuid, ${json(team)}::jsonb)`);
  }

  setLinks(ctx: RequestContext, id: string, links: LinkItem[]) {
    return this.command(ctx, id, sql`select app.set_fmea_links(${id}::uuid, ${json(links)}::jsonb)`);
  }

  setApprover(ctx: RequestContext, id: string, approverId: string | null) {
    return this.command(ctx, id, sql`select app.set_fmea_approver(${id}::uuid, ${approverId}::uuid)`);
  }

  submit(ctx: RequestContext, id: string) {
    return this.command(ctx, id, sql`select app.submit_fmea_revision(${id}::uuid)`);
  }

  approve(ctx: RequestContext, id: string, body: ApproveBody) {
    return this.command(ctx, id, sql`select app.approve_fmea_revision(${id}::uuid, ${body.effectiveFrom}::date, ${body.comment ?? null})`);
  }

  sendBack(ctx: RequestContext, id: string, comment: string) {
    return this.command(ctx, id, sql`select app.send_back_fmea_revision(${id}::uuid, ${comment})`);
  }

  recall(ctx: RequestContext, id: string, reason: string) {
    return this.command(ctx, id, sql`select app.recall_fmea_revision(${id}::uuid, ${reason})`);
  }

  discard(ctx: RequestContext, id: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      const found = (await db.execute<Row>(sql`select fmea_id from public.fmea_revisions where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`)).rows[0];
      if (!found) throw ApiError.notFound('fmea_revision_not_found', 'Revision not found');
      await db.execute(sql`select app.discard_fmea_revision(${id}::uuid, ${reason})`);
      return this.fmea(db, ctx, found.fmea_id as string);
    });
  }
}
