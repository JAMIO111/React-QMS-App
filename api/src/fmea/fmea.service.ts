import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { ApproveBody, CreateFmeaBody, FmeaListQuery, LinkItem, TeamItem, UpdateFmeaBody, UpdateRevisionBody } from './fmea.schemas';

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
    return {
      ...toSummary(r),
      revisions,
      inProgress: open ? { id: open.id, status: open.status, letter: open.letter, sequence: open.sequence } : null,
      nextLetter: (can.next_letter as string) ?? 'A',
      canManage: Boolean(can.manage) && status !== 'discarded',
      canApprove: Boolean(can.approve),
      canStartRevision: Boolean(can.manage) && ['active', 'withdrawn'].includes(status) && !open,
      canWithdraw: Boolean(can.approve) && status === 'active',
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

  startRevision(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.start_fmea_revision(${id}::uuid)`);
      return this.fmea(db, ctx, id);
    });
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

  private async revision(db: Db, ctx: RequestContext, id: string) {
    const org = orgOf(ctx);
    const found = (
      await db.execute<Row>(sql`
        select v.*, f.number, f.kind, f.title, f.status as fmea_status, f.owner_user_id, f.review_months,
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
      await db.execute<Row>(sql`select app.has_permission(${org}::uuid, 'fmea.manage') as manage, app.has_permission(${org}::uuid, 'fmea.approve') as approve, auth.uid() as me`)
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
      canEdit: Boolean(can.manage) && status === 'draft',
      /** The caller is the named approver, it is waiting, and nothing (the approve right, the preparer rule) stands in the way. */
      canDecide: mine && status === 'pending_approval' && Boolean(can.approve) && r.author_id !== can.me,
      canRecall: Boolean(can.manage) && status === 'pending_approval',
      createdAt: iso(r.created_at) as string,
      updatedAt: iso(r.updated_at) as string,
    };
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
