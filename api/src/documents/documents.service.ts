import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { blocksOf, diffFiles, diffLines, summarise } from './document-compare';
import { copyState, DocumentFileStore, isPdf, stampLines, stampPdf } from './controlled-copy';
import {
  ChangeRequestBody, ChangeRequestListQuery, InForceQuery, LinksBody, PeriodicReviewBody,
  AcknowledgeBody, ApproveBody, CreateDocumentBody, IssueExternalBody, ReadersBody, CreateTypeBody, DocumentFileBody, DocumentListQuery, ReviewBody, SignersBody, TypeListQuery, UpdateDocumentBody, UpdateRevisionBody,
  UpdateTypeBody,
} from './documents.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown' } : null);
const json = (v: unknown) => JSON.stringify(v);

const toType = (r: Row) => ({
  id: r.id as string,
  name: r.name as string,
  prefix: r.prefix as string,
  description: (r.description as string) ?? null,
  reviewMonths: Number(r.review_months),
  contentHint: r.content_hint as 'file' | 'text',
  sequence: Number(r.sequence),
  active: r.active as boolean,
  documents: Number(r.document_count ?? 0),
});

/** Every document the caller may read (RLS), with its type, owner and the revision in progress, if any. */
const DOCUMENT_SELECT = sql`
  select d.*, t.name as type_name, t.prefix as type_prefix, d.next_review_on::text as next_review_day, coalesce(d.review_months, t.review_months) as review_months_effective,
         (d.status = 'active' and d.next_review_on < current_date) as review_overdue,
         ${sql.raw(personName('po'))} as owner_name,
         ip.id as ip_id, ip.status as ip_status, ip.sequence as ip_sequence, ip.letter as ip_letter, ip.effective_from::text as ip_effective_from,
         cr.letter as current_letter, cr.effective_from::text as current_effective_from, cr.issuer_revision as current_issuer_revision,
         (select count(*)::int from public.document_recipients x where x.revision_id = d.current_revision_id) as readers_total,
         (select count(*)::int from public.document_recipients x where x.revision_id = d.current_revision_id and x.acknowledged_at is not null) as readers_done,
         (select count(*)::int from public.document_recipients x where x.revision_id = d.current_revision_id and x.acknowledged_at is null and x.due_on < current_date) as readers_overdue,
         (select x.due_on::text from public.document_recipients x where x.revision_id = d.current_revision_id and x.user_id = auth.uid() and x.acknowledged_at is null) as my_due,
         (select true from public.document_recipients x where x.revision_id = d.current_revision_id and x.user_id = auth.uid() and x.acknowledged_at is null) as my_pending,
         (select count(*)::int from public.document_revisions x where x.document_id = d.id and x.status <> 'discarded') as revision_count
    from public.documents d
    join public.document_types t on t.id = d.type_id
    left join public.profiles po on po.id = d.owner_user_id
    left join public.document_revisions ip on ip.document_id = d.id and ip.status in ('draft', 'in_review', 'awaiting_approval', 'approved')
    left join public.document_revisions cr on cr.id = d.current_revision_id`;

const SORT: Record<DocumentListQuery['sort'], string> = {
  number: 'upper(d.number)',
  title: 'lower(d.title)',
  type: 'lower(d.type_name)',
  status: 'd.status',
  owner: 'lower(d.owner_name)',
  updatedAt: 'd.updated_at',
  nextReview: 'd.next_review_on',
};

const toDocument = (r: Row) => ({
  id: r.id as string,
  number: r.number as string,
  title: r.title as string,
  type: { id: r.type_id as string, name: r.type_name as string, prefix: r.type_prefix as string },
  contentKind: r.content_kind as 'file' | 'text',
  description: (r.description as string) ?? null,
  owner: person(r.owner_user_id, r.owner_name),
  status: r.status as string,
  startLetter: r.start_letter as string,
  lastLetter: (r.last_letter as string) ?? null,
  numberTyped: r.number_typed as boolean,
  /** External (DC5): issued by someone else; revisions are recorded as issued, not reviewed here. */
  origin: (r.origin as 'internal' | 'external') ?? 'internal',
  issuer: (r.issuer as string) ?? null,
  externalReference: (r.external_reference as string) ?? null,
  /** The revision being written or reviewed (null when none, or when the caller may not see it). */
  inProgress: r.ip_id
    ? { id: r.ip_id as string, status: r.ip_status as string, sequence: Number(r.ip_sequence), letter: (r.ip_letter as string) ?? null, effectiveFrom: (r.ip_effective_from as string) ?? null }
    : null,
  /** The revision in force (or, once withdrawn, the one that was). */
  currentRevision: r.current_revision_id
    ? {
        id: r.current_revision_id as string,
        letter: r.current_letter as string,
        effectiveFrom: (r.current_effective_from as string) ?? null,
        issuerRevision: (r.current_issuer_revision as string) ?? null,
      }
    : null,
  withdrawReason: (r.withdraw_reason as string) ?? null,
  withdrawnAt: r.withdrawn_at ? (iso(r.withdrawn_at) as string) : null,
  restricted: Boolean(r.restricted),
  /** The document's own review interval (null = its type's), the one that applies, the next review date and whether it is past. */
  reviewMonths: r.review_months === null || r.review_months === undefined ? null : Number(r.review_months),
  reviewMonthsEffective: Number(r.review_months_effective),
  nextReviewOn: (r.next_review_day as string) ?? null,
  reviewOverdue: Boolean(r.review_overdue),
  /** Readers of the revision in force (as the caller may see them: managers see everyone, others only themselves). */
  readers: { total: Number(r.readers_total ?? 0), acknowledged: Number(r.readers_done ?? 0), overdue: Number(r.readers_overdue ?? 0) },
  /** The caller has the revision in force still to acknowledge. */
  toAcknowledge: r.my_pending ? { dueOn: (r.my_due as string) ?? null } : null,
  revisionCount: Number(r.revision_count ?? 0),
  createdAt: iso(r.created_at) as string,
  updatedAt: iso(r.updated_at) as string,
});

const toFile = (f: Row) => ({
  id: f.id as string,
  role: f.role as 'main' | 'attachment',
  storagePath: f.storage_path as string,
  fileName: f.file_name as string,
  contentType: (f.content_type as string) ?? null,
  sizeBytes: Number(f.size_bytes),
  createdBy: f.created_by_name ? { name: f.created_by_name as string } : null,
  deletedAt: f.deleted_at ? (iso(f.deleted_at) as string) : null,
  deleteReason: (f.delete_reason as string) ?? null,
  createdAt: iso(f.created_at) as string,
});

const toLink = (l: Row) => {
  const kind = l.part_id ? 'part' : l.part_family_id ? 'part_family' : l.machine_id ? 'machine' : 'operation';
  const label =
    kind === 'part'
      ? [l.part_number, l.part_name].filter(Boolean).join(' · ')
      : kind === 'part_family'
        ? [l.family_code, l.family_name].filter(Boolean).join(' · ')
        : kind === 'machine'
          ? [l.machine_code, l.machine_name].filter(Boolean).join(' · ')
          : (l.operation_code as string);
  return { id: l.id as string, kind, refId: ((l.part_id ?? l.part_family_id ?? l.machine_id ?? l.operation_code) as string) ?? null, label: label || 'Unknown' };
};

const CHANGE_REQUEST_SELECT = sql`
  select c.*, d.number, d.title, r.letter as revision_letter, r.status as revision_status, ${sql.raw(personName('pq'))} as requester_name, ${sql.raw(personName('pd'))} as decider_name
    from public.document_change_requests c
    join public.documents d on d.id = c.document_id
    left join public.document_revisions r on r.id = c.revision_id
    left join public.profiles pq on pq.id = c.requested_by
    left join public.profiles pd on pd.id = c.decided_by`;

const toChangeRequest = (c: Row) => ({
  id: c.id as string,
  reference: c.reference as string,
  document: { id: c.document_id as string, number: c.number as string, title: c.title as string },
  what: c.what as string,
  why: c.why as string,
  status: c.status as 'open' | 'accepted' | 'declined' | 'withdrawn',
  requestedBy: person(c.requested_by, c.requester_name),
  decidedBy: (c.decider_name as string) ?? null,
  decidedAt: c.decided_at ? (iso(c.decided_at) as string) : null,
  decisionReason: (c.decision_reason as string) ?? null,
  revision: c.revision_id ? { id: c.revision_id as string, letter: (c.revision_letter as string) ?? null, status: c.revision_status as string } : null,
  createdAt: iso(c.created_at) as string,
});

/** Document control (DC1): types, documents and their draft revisions. Every write is a database function; reading is by RLS. */
@Injectable()
export class DocumentsService {
  constructor(private readonly database: DatabaseService) {}

  // ---- types ---------------------------------------------------------------------------------------

  private async type(db: Db, ctx: RequestContext, id: string) {
    const rows = (
      await db.execute<Row>(sql`
        select t.*, (select count(*)::int from public.documents d where d.type_id = t.id) as document_count
          from public.document_types t where t.id = ${id}::uuid and t.organisation_id = ${orgOf(ctx)}::uuid`)
    ).rows;
    if (rows.length === 0) throw ApiError.notFound('document_type_not_found', 'Document type not found');
    return toType(rows[0]);
  }

  types(ctx: RequestContext, q: TypeListQuery) {
    return this.database.asUser(ctx, async (db) => {
      const rows = (
        await db.execute<Row>(sql`
          select t.*, (select count(*)::int from public.documents d where d.type_id = t.id) as document_count
            from public.document_types t
           where t.organisation_id = ${orgOf(ctx)}::uuid and (${q.all === 'true'} or t.active)
           order by t.active desc, t.sequence, lower(t.name)`)
      ).rows;
      return { data: rows.map(toType) };
    });
  }

  createType(ctx: RequestContext, body: CreateTypeBody) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ id: string }>(sql`select app.save_document_type(${orgOf(ctx)}::uuid, ${json(body)}::jsonb) as id`);
      return this.type(db, ctx, res.rows[0].id);
    });
  }

  updateType(ctx: RequestContext, id: string, body: UpdateTypeBody) {
    return this.database.asUser(ctx, async (db) => {
      await this.type(db, ctx, id);
      await db.execute(sql`select app.save_document_type(${orgOf(ctx)}::uuid, ${json(body)}::jsonb, ${id}::uuid)`);
      return this.type(db, ctx, id);
    });
  }

  // ---- documents -----------------------------------------------------------------------------------

  /** Approved revisions whose date has come take effect (no worker; idempotent). */
  private async settle(db: Db, ctx: RequestContext) {
    await db.execute(sql`select app.settle_documents(${orgOf(ctx)}::uuid)`);
  }

  list(ctx: RequestContext, q: DocumentListQuery) {
    return this.database.asUser(ctx, async (db) => {
      await this.settle(db, ctx);
      const where: SQL[] = [sql`d.organisation_id = ${orgOf(ctx)}::uuid`];
      if (q.type) where.push(sql`d.type_id = any(string_to_array(${q.type}, ',')::uuid[])`);
      // Discarded documents only when asked for.
      where.push(q.status ? sql`d.status = any(string_to_array(${q.status}, ','))` : sql`d.status <> 'discarded'`);
      if (q.kind) where.push(sql`d.content_kind = ${q.kind}`);
      if (q.owner === 'me') where.push(sql`d.owner_user_id = auth.uid()`);
      if (q.reviewOverdue) where.push(sql`d.review_overdue`);
      if (q.q) {
        const p = likePattern(q.q);
        where.push(sql`(d.number ilike ${p} escape '\\' or d.title ilike ${p} escape '\\' or d.description ilike ${p} escape '\\'
          or exists (select 1 from public.document_revisions r where r.document_id = d.id and r.status <> 'discarded' and r.body_text ilike ${p} escape '\\')
          or exists (select 1 from public.document_revision_files f join public.document_revisions r on r.id = f.revision_id
                      where r.document_id = d.id and f.deleted_at is null and f.file_name ilike ${p} escape '\\'))`);
      }
      const cond = sql.join(where, sql` and `);
      const total = Number((await db.execute<Row>(sql`select count(*)::int as n from (${DOCUMENT_SELECT}) d where ${cond}`)).rows[0].n);
      const rows = (
        await db.execute<Row>(sql`
          select * from (${DOCUMENT_SELECT}) d where ${cond}
           order by ${sql.raw(SORT[q.sort])} ${sql.raw(q.order === 'desc' ? 'desc nulls last' : 'asc nulls last')}, upper(d.number)
           limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`)
      ).rows;
      return { data: rows.map(toDocument), page: q.page, pageSize: q.pageSize, total };
    });
  }

  private async document(db: Db, ctx: RequestContext, id: string) {
    const org = orgOf(ctx);
    const found = (await db.execute<Row>(sql`select * from (${DOCUMENT_SELECT}) d where d.id = ${id}::uuid and d.organisation_id = ${org}::uuid`)).rows;
    if (found.length === 0) throw ApiError.notFound('document_not_found', 'Document not found');
    const revisions = (
      await db.execute<Row>(sql`
        select r.id, r.sequence, r.letter, r.status, r.change_summary, r.discard_reason, r.discarded_at, r.created_at, r.updated_at,
               r.effective_from::text as effective_from, r.approved_at, r.withdraw_reason, r.issuer_revision,
               r.author_id, ${sql.raw(personName('pa'))} as author_name
          from public.document_revisions r left join public.profiles pa on pa.id = r.author_id
         where r.document_id = ${id}::uuid and r.organisation_id = ${org}::uuid
         order by r.sequence desc`)
    ).rows;
    const can = (
      await db.execute<Row>(sql`
        select app.has_permission(${org}::uuid, 'documentation.manage') as manage, app.has_permission(${org}::uuid, 'documentation.issue') as issue,
               app.document_letter_after(${found[0].last_letter ?? null}::text) as after`)
    ).rows[0];
    const doc = toDocument(found[0]);
    const targets = (
      await db.execute<Row>(sql`
        select t.id, t.department_id, t.role_id, t.membership_id, dp.name as department_name, ro.name as role_name, ${sql.raw(personName('pt'))} as person_name
          from public.document_targets t
          left join public.departments dp on dp.id = t.department_id
          left join public.roles ro on ro.id = t.role_id
          left join public.organisation_users om on om.id = t.membership_id
          left join public.profiles pt on pt.id = om.user_id
         where t.document_id = ${id}::uuid order by t.created_at`)
    ).rows.map((t) => ({
      id: t.id as string,
      kind: t.department_id ? 'department' : t.role_id ? 'role' : 'person',
      refId: (t.department_id ?? t.role_id ?? t.membership_id) as string,
      label: ((t.department_name ?? t.role_name ?? t.person_name) as string) ?? 'Unknown',
    }));
    const reviews = (
      await db.execute<Row>(sql`
        select p.id, p.outcome, p.note, p.was_due_on::text as was_due_on, p.next_review_on::text as next_review_on, p.created_at, p.started_revision_id,
               r.letter, ${sql.raw(personName('pr'))} as by_name
          from public.document_periodic_reviews p join public.document_revisions r on r.id = p.revision_id left join public.profiles pr on pr.id = p.created_by
         where p.document_id = ${id}::uuid order by p.created_at desc`)
    ).rows.map((p) => ({
      id: p.id as string,
      outcome: p.outcome as 'no_change' | 'revision_started',
      note: (p.note as string) ?? null,
      revisionLetter: (p.letter as string) ?? null,
      wasDueOn: (p.was_due_on as string) ?? null,
      nextReviewOn: (p.next_review_on as string) ?? null,
      startedRevisionId: (p.started_revision_id as string) ?? null,
      by: (p.by_name as string) ?? null,
      at: iso(p.created_at) as string,
    }));
    const links = (
      await db.execute<Row>(sql`
        select l.id, l.part_id, l.part_family_id, l.machine_id, l.operation_code, pa.part_number, pa.name as part_name, pf.code as family_code, pf.name as family_name,
               m.code as machine_code, m.name as machine_name
          from public.document_links l
          left join public.parts pa on pa.id = l.part_id
          left join public.part_families pf on pf.id = l.part_family_id
          left join public.machines m on m.id = l.machine_id
         where l.document_id = ${id}::uuid order by l.created_at`)
    ).rows.map(toLink);
    const changeRequests = (await this.changeRequestRows(db, ctx, { documentId: id, status: 'all' })).map(toChangeRequest);
    const skills = (
      await db.execute<Row>(sql`
        select k.id, k.code, k.name from public.document_skills ds join public.competence_skills k on k.id = ds.skill_id
         where ds.document_id = ${id}::uuid order by lower(k.name)`)
    ).rows.map((k) => ({ id: k.id as string, code: k.code as string, name: k.name as string }));
    return {
      ...doc,
      /** The letter the next submitted revision will get. */
      nextLetter: doc.lastLetter ? (can.after as string) : doc.startLetter,
      revisions: revisions.map((r) => ({
        id: r.id as string,
        sequence: Number(r.sequence),
        letter: (r.letter as string) ?? null,
        status: r.status as string,
        author: person(r.author_id, r.author_name),
        changeSummary: (r.change_summary as string) ?? null,
        discardReason: (r.discard_reason as string) ?? null,
        discardedAt: r.discarded_at ? (iso(r.discarded_at) as string) : null,
        effectiveFrom: (r.effective_from as string) ?? null,
        approvedAt: r.approved_at ? (iso(r.approved_at) as string) : null,
        withdrawReason: (r.withdraw_reason as string) ?? null,
        issuerRevision: (r.issuer_revision as string) ?? null,
        createdAt: iso(r.created_at) as string,
        updatedAt: iso(r.updated_at) as string,
      })),
      canManage: Boolean(can.manage) && doc.status !== 'discarded',
      /** documentation.issue: withdraw it (and approve, when named as approver). */
      canIssue: Boolean(can.issue),
      canStartRevision: Boolean(can.manage) && ['active', 'withdrawn'].includes(doc.status) && !doc.inProgress,
      targets,
      skills,
      reviews,
      links,
      changeRequests,
    };
  }

  get(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.settle(db, ctx);
      return this.document(db, ctx, id);
    });
  }

  create(ctx: RequestContext, body: CreateDocumentBody) {
    return this.database.asUser(ctx, async (db) => {
      const { origin, ...data } = body;
      const res =
        origin === 'external'
          ? await db.execute<{ id: string }>(sql`select app.create_external_document(${orgOf(ctx)}::uuid, ${json(data)}::jsonb) as id`)
          : await db.execute<{ id: string }>(sql`select app.create_document(${orgOf(ctx)}::uuid, ${json(data)}::jsonb) as id`);
      return this.document(db, ctx, res.rows[0].id);
    });
  }

  update(ctx: RequestContext, id: string, body: UpdateDocumentBody) {
    return this.database.asUser(ctx, async (db) => {
      await this.document(db, ctx, id);
      const { issuer, externalReference, ...rest } = body;
      const external: Record<string, unknown> = {};
      if (issuer !== undefined) external.issuer = issuer;
      if (externalReference !== undefined) external.externalReference = externalReference;
      if (Object.keys(external).length > 0) await db.execute(sql`select app.update_external_details(${id}::uuid, ${json(external)}::jsonb)`);
      if (Object.keys(rest).length > 0) await db.execute(sql`select app.update_document(${id}::uuid, ${json(rest)}::jsonb)`);
      return this.document(db, ctx, id);
    });
  }

  // ---- revisions -----------------------------------------------------------------------------------

  private async revision(db: Db, ctx: RequestContext, id: string) {
    const org = orgOf(ctx);
    const rows = (
      await db.execute<Row>(sql`
        select r.*, r.effective_from::text as effective_from_day, ${sql.raw(personName('pa'))} as author_name, ${sql.raw(personName('pd'))} as discarded_by_name,
               ${sql.raw(personName('pp'))} as approver_name, ${sql.raw(personName('pb'))} as approved_by_name, ${sql.raw(personName('pw'))} as withdrawn_by_name,
               app.document_revision_problems(r.id) as problems
          from public.document_revisions r
          left join public.profiles pa on pa.id = r.author_id
          left join public.profiles pd on pd.id = r.discarded_by
          left join public.profiles pp on pp.id = r.approver_id
          left join public.profiles pb on pb.id = r.approved_by
          left join public.profiles pw on pw.id = r.withdrawn_by
         where r.id = ${id}::uuid and r.organisation_id = ${org}::uuid`)
    ).rows;
    if (rows.length === 0) throw ApiError.notFound('document_revision_not_found', 'Revision not found');
    const r = rows[0];
    const document = await this.document(db, ctx, r.document_id as string);
    const files = (
      await db.execute<Row>(sql`
        select f.*, ${sql.raw(personName('pc'))} as created_by_name
          from public.document_revision_files f left join public.profiles pc on pc.id = f.created_by
         where f.revision_id = ${id}::uuid and f.organisation_id = ${org}::uuid
         order by (f.role = 'main') desc, f.created_at`)
    ).rows.map(toFile);
    const reviewers = (
      await db.execute<Row>(sql`
        select v.user_id, ${sql.raw(personName('pv'))} as name from public.document_revision_reviewers v left join public.profiles pv on pv.id = v.user_id
         where v.revision_id = ${id}::uuid order by 2`)
    ).rows.map((v) => ({ id: v.user_id as string, name: (v.name as string) ?? 'Unknown' }));
    const signoffs = (
      await db.execute<Row>(sql`
        select s.id, s.round, s.role, s.user_id, s.decision, s.comment, s.decided_at, s.created_at, ${sql.raw(personName('ps'))} as name
          from public.document_signoffs s left join public.profiles ps on ps.id = s.user_id
         where s.revision_id = ${id}::uuid order by s.round desc, (s.role = 'approver'), s.created_at`)
    ).rows.map((x) => ({
      id: x.id as string,
      round: Number(x.round),
      role: x.role as 'reviewer' | 'approver',
      person: { id: x.user_id as string, name: (x.name as string) ?? 'Unknown' },
      decision: x.decision as string,
      comment: (x.comment as string) ?? null,
      decidedAt: x.decided_at ? (iso(x.decided_at) as string) : null,
      createdAt: iso(x.created_at) as string,
    }));
    const me = (await db.execute<Row>(sql`select auth.uid() as id`)).rows[0].id as string;
    const status = r.status as string;
    const round = Number(r.review_round);
    const mine = signoffs.find((x) => x.round === round && x.person.id === me && x.decision === 'pending');
    const myReading = (
      await db.execute<Row>(sql`
        select due_on::text as due_on, first_viewed_at, acknowledged_at, acknowledge_note from public.document_recipients where revision_id = ${id}::uuid and user_id = auth.uid()`)
    ).rows[0];
    const readers = (
      await db.execute<Row>(sql`
        select count(*)::int as total, count(acknowledged_at)::int as acknowledged, count(first_viewed_at)::int as viewed,
               count(*) filter (where acknowledged_at is null and due_on < current_date)::int as overdue
          from public.document_recipients where revision_id = ${id}::uuid`)
    ).rows[0];
    const { revisions: _revisions, ...header } = document;
    void _revisions;
    return {
      id: r.id as string,
      document: header,
      sequence: Number(r.sequence),
      letter: (r.letter as string) ?? null,
      /** The letter it will get when submitted (drafts only). */
      plannedLetter: status === 'draft' ? document.nextLetter : null,
      status,
      author: person(r.author_id, r.author_name),
      changeSummary: (r.change_summary as string) ?? null,
      body: (r.body as Record<string, unknown>) ?? null,
      files,
      discardReason: (r.discard_reason as string) ?? null,
      discardedAt: r.discarded_at ? (iso(r.discarded_at) as string) : null,
      discardedBy: (r.discarded_by_name as string) ?? null,
      canEdit: status === 'draft' && document.canManage,
      /** The issuer's own revision label (external documents). */
      issuerRevision: (r.issuer_revision as string) ?? null,
      /** An external draft is recorded as issued (documentation.issue) instead of being reviewed. */
      canRecordIssue: status === 'draft' && document.origin === 'external' && document.canIssue && document.status !== 'discarded',
      /** What the draft still needs before it can be submitted (drafts only). */
      problems: status === 'draft' ? ((r.problems as string[]) ?? []) : [],
      reviewers,
      approver: person(r.approver_id, r.approver_name),
      reviewRound: round,
      signoffs,
      /** What is waiting for the caller on this revision. */
      myTurn: mine && status === 'in_review' && mine.role === 'reviewer' ? 'review' : mine && status === 'awaiting_approval' && mine.role === 'approver' ? 'approve' : null,
      submittedAt: r.submitted_at ? (iso(r.submitted_at) as string) : null,
      approvedAt: r.approved_at ? (iso(r.approved_at) as string) : null,
      approvedBy: (r.approved_by_name as string) ?? null,
      effectiveFrom: (r.effective_from_day as string) ?? null,
      effectiveAt: r.effective_at ? (iso(r.effective_at) as string) : null,
      supersededAt: r.superseded_at ? (iso(r.superseded_at) as string) : null,
      withdrawnAt: r.withdrawn_at ? (iso(r.withdrawn_at) as string) : null,
      withdrawnBy: (r.withdrawn_by_name as string) ?? null,
      withdrawReason: (r.withdraw_reason as string) ?? null,
      previousRevisionId: (r.previous_revision_id as string) ?? null,
      acknowledgeWithinDays: r.acknowledge_within_days === null || r.acknowledge_within_days === undefined ? null : Number(r.acknowledge_within_days),
      /** The caller as a reader of this revision, if they were asked. */
      myReading: myReading
        ? {
            dueOn: (myReading.due_on as string) ?? null,
            viewedAt: myReading.first_viewed_at ? (iso(myReading.first_viewed_at) as string) : null,
            acknowledgedAt: myReading.acknowledged_at ? (iso(myReading.acknowledged_at) as string) : null,
            note: (myReading.acknowledge_note as string) ?? null,
          }
        : null,
      /** Readers (managers see everyone; others only themselves). */
      readers: { total: Number(readers.total), acknowledged: Number(readers.acknowledged), viewed: Number(readers.viewed), overdue: Number(readers.overdue) },
      createdAt: iso(r.created_at) as string,
      updatedAt: iso(r.updated_at) as string,
    };
  }

  getRevision(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.settle(db, ctx);
      await this.revision(db, ctx, id);
      // Opening it is the first view for a reader asked to read it (no-op for anyone else).
      await db.execute(sql`select app.mark_document_viewed(${id}::uuid)`);
      return this.revision(db, ctx, id);
    });
  }

  private async onRevision(ctx: RequestContext, id: string, run: (db: Db) => Promise<unknown>) {
    return this.database.asUser(ctx, async (db) => {
      await this.revision(db, ctx, id);
      await run(db);
      return this.revision(db, ctx, id);
    });
  }

  updateRevision(ctx: RequestContext, id: string, body: UpdateRevisionBody) {
    return this.onRevision(ctx, id, (db) => db.execute(sql`select app.update_document_revision(${id}::uuid, ${json(body)}::jsonb)`));
  }

  discardRevision(ctx: RequestContext, id: string, reason: string) {
    return this.onRevision(ctx, id, (db) => db.execute(sql`select app.discard_document_revision(${id}::uuid, ${reason})`));
  }

  files(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => ({ data: (await this.revision(db, ctx, id)).files }));
  }

  addFile(ctx: RequestContext, id: string, body: DocumentFileBody) {
    return this.onRevision(ctx, id, (db) =>
      db.execute(sql`
        select app.add_document_file(${id}::uuid, ${body.role}, ${body.storagePath}, ${body.fileName}, ${body.contentType ?? null}, ${body.sizeBytes}::bigint)`),
    );
  }

  private async onFile(ctx: RequestContext, fileId: string, run: (db: Db) => Promise<unknown>) {
    return this.database.asUser(ctx, async (db) => {
      const row = (await db.execute<Row>(sql`select revision_id from public.document_revision_files where id = ${fileId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`)).rows;
      if (row.length === 0) throw ApiError.notFound('document_file_not_found', 'File not found');
      await run(db);
      return this.revision(db, ctx, row[0].revision_id as string);
    });
  }

  removeFile(ctx: RequestContext, fileId: string, reason: string) {
    return this.onFile(ctx, fileId, (db) => db.execute(sql`select app.remove_document_file(${fileId}::uuid, ${reason})`));
  }

  restoreFile(ctx: RequestContext, fileId: string) {
    return this.onFile(ctx, fileId, (db) => db.execute(sql`select app.restore_document_file(${fileId}::uuid)`));
  }

  // ---- review, approval, effect (DC2) ---------------------------------------------------------------

  setSigners(ctx: RequestContext, id: string, body: SignersBody) {
    return this.onRevision(ctx, id, (db) =>
      db.execute(sql`select app.set_document_signers(${id}::uuid, string_to_array(${body.reviewerIds.join(',')}, ',')::uuid[], ${body.approverId}::uuid)`),
    );
  }

  submit(ctx: RequestContext, id: string) {
    return this.onRevision(ctx, id, (db) => db.execute(sql`select app.submit_document_revision(${id}::uuid)`));
  }

  review(ctx: RequestContext, id: string, body: ReviewBody) {
    return this.onRevision(ctx, id, (db) => db.execute(sql`select app.review_document_revision(${id}::uuid, ${body.accept}, ${body.comment ?? null})`));
  }

  approve(ctx: RequestContext, id: string, body: ApproveBody) {
    return this.onRevision(ctx, id, (db) => db.execute(sql`select app.approve_document_revision(${id}::uuid, ${body.effectiveFrom}::date, ${body.comment ?? null})`));
  }

  /** An external document's revision is recorded as issued: letter, the issuer's revision, effective date (DC5). */
  issueExternal(ctx: RequestContext, id: string, body: IssueExternalBody) {
    return this.database.asUser(ctx, async (db) => {
      await this.revision(db, ctx, id);
      await db.execute(sql`select app.issue_external_revision(${id}::uuid, ${body.issuerRevision}, ${body.effectiveFrom}::date, ${body.changeSummary ?? null})`);
      return this.revision(db, ctx, id);
    });
  }

  /**
   * A stamped copy of a PDF file (DC5): the caller must be able to read the revision (RLS), the bytes come from storage with the service key,
   * and every page says whether it is the controlled copy in force or not for use, who printed it and when.
   */
  async controlledCopy(ctx: RequestContext, fileId: string, store: DocumentFileStore) {
    const meta = await this.database.asUser(ctx, async (db) => {
      const rows = (
        await db.execute<Row>(sql`
          select f.storage_path, f.file_name, f.content_type, f.deleted_at, f.revision_id, r.status, r.letter, r.effective_from::text as effective_from, r.issuer_revision,
                 d.number, d.title, (select ${sql.raw(personName('pm'))} from public.profiles pm where pm.id = auth.uid()) as me,
                 to_char(now(), 'DD Mon YYYY HH24:MI') as printed_at, to_char(r.effective_from, 'DD Mon YYYY') as effective_words
            from public.document_revision_files f
            join public.document_revisions r on r.id = f.revision_id
            join public.documents d on d.id = r.document_id
           where f.id = ${fileId}::uuid and f.organisation_id = ${orgOf(ctx)}::uuid`)
      ).rows;
      if (rows.length === 0) throw ApiError.notFound('document_file_not_found', 'File not found');
      return rows[0];
    });
    if (meta.deleted_at) throw new ApiError(409, 'document_rule', 'This file was removed');
    if (!isPdf(meta.file_name as string, (meta.content_type as string) ?? null)) {
      throw new ApiError(409, 'document_rule', 'Only a PDF can be stamped as a controlled copy. Other files are uncontrolled when printed or saved.');
    }
    if (!store.enabled) throw new ApiError(503, 'file_storage_unavailable', 'Controlled copies are not set up on this server yet');
    const bytes = await store.download(meta.storage_path as string);
    if (!bytes) throw ApiError.notFound('document_file_not_found', 'The stored file is missing');
    const state = copyState(meta.status as string);
    const letter = meta.letter ? `${meta.letter}${meta.issuer_revision ? ` (${meta.issuer_revision})` : ''}` : null;
    const lines = stampLines({
      state,
      number: meta.number as string,
      letter,
      effectiveFrom: (meta.effective_words as string) ?? null,
      printedAt: meta.printed_at as string,
      printedBy: (meta.me as string) || 'Unknown',
    });
    let stamped: Uint8Array;
    try {
      stamped = await stampPdf(bytes, lines, state);
    } catch {
      throw new ApiError(409, 'document_rule', 'This PDF cannot be stamped (it may be protected or damaged). Download the file itself instead.');
    }
    const base = (meta.file_name as string).replace(/\.pdf$/i, '');
    return { bytes: stamped, fileName: `${base} - ${state === 'controlled' ? 'controlled copy' : 'not for use'}.pdf`, state };
  }

  sendBack(ctx: RequestContext, id: string, comment: string) {
    return this.onRevision(ctx, id, (db) => db.execute(sql`select app.send_back_document_revision(${id}::uuid, ${comment})`));
  }

  startRevision(ctx: RequestContext, documentId: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.document(db, ctx, documentId);
      const res = await db.execute<{ id: string }>(sql`select app.start_document_revision(${documentId}::uuid) as id`);
      return this.revision(db, ctx, res.rows[0].id);
    });
  }

  withdraw(ctx: RequestContext, documentId: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.document(db, ctx, documentId);
      await db.execute(sql`select app.withdraw_document(${documentId}::uuid, ${reason})`);
      return this.document(db, ctx, documentId);
    });
  }

  /** Members who may be named as reviewers or approver (`canApprove`: holds documentation.issue). */
  signerCandidates(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const rows = (await db.execute<Row>(sql`select * from app.document_signer_candidates(${orgOf(ctx)}::uuid)`)).rows;
      return { data: rows.map((r) => ({ id: r.user_id as string, name: r.name as string, canApprove: r.can_approve as boolean })) };
    });
  }

  /** Revisions waiting for the caller's review or approval. */
  waiting(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      await this.settle(db, ctx);
      return { data: await this.waitingIn(db, ctx) };
    });
  }

  private async waitingIn(db: Db, ctx: RequestContext) {
    {
      const rows = (
        await db.execute<Row>(sql`
          select s.role, s.created_at, r.id as revision_id, r.letter, r.status, d.id as document_id, d.number, d.title, ${sql.raw(personName('pa'))} as author_name
            from public.document_signoffs s
            join public.document_revisions r on r.id = s.revision_id and s.round = r.review_round
            join public.documents d on d.id = r.document_id
            left join public.profiles pa on pa.id = r.author_id
           where s.organisation_id = ${orgOf(ctx)}::uuid and s.user_id = auth.uid() and s.decision = 'pending'
             and r.status = case s.role when 'reviewer' then 'in_review' else 'awaiting_approval' end
           order by s.created_at`)
      ).rows;
      return rows.map((r) => ({
        role: r.role as 'reviewer' | 'approver',
        since: iso(r.created_at) as string,
        revision: { id: r.revision_id as string, letter: (r.letter as string) ?? null, status: r.status as string },
        document: { id: r.document_id as string, number: r.number as string, title: r.title as string },
        author: (r.author_name as string) ?? null,
      }));
    }
  }

  /** A revision against another (default: the one it was started from, else the revision in force). Text: blocks; files: which changed. */
  compare(ctx: RequestContext, id: string, withId?: string) {
    return this.database.asUser(ctx, async (db) => {
      const target = await this.revision(db, ctx, id);
      let otherId = withId ?? target.previousRevisionId ?? null;
      if (!otherId && target.document.currentRevision && target.document.currentRevision.id !== target.id) otherId = target.document.currentRevision.id;
      const other = otherId ? await this.revision(db, ctx, otherId) : null;
      if (other && other.document.id !== target.document.id) throw ApiError.badRequest('compare_other_document', 'Both revisions must belong to the same document');
      const label = (r: { letter: string | null; sequence: number }) => (r.letter ? `Rev ${r.letter}` : `Draft ${r.sequence}`);
      const live = (r: { files: { deletedAt: string | null; storagePath: string; fileName: string; role: string }[] }) => r.files.filter((f) => !f.deletedAt);
      const text = target.document.contentKind === 'text' ? diffLines(blocksOf(other?.body ?? null), blocksOf(target.body)) : [];
      const files = diffFiles(other ? live(other) : [], live(target));
      return {
        revision: { id: target.id, label: label(target) },
        against: other ? { id: other.id, label: label(other) } : null,
        text,
        textSummary: summarise(text),
        files,
        filesSummary: summarise(files),
      };
    });
  }

  // ---- readers (DC3) -----------------------------------------------------------------------------------

  setReaders(ctx: RequestContext, documentId: string, body: ReadersBody) {
    return this.database.asUser(ctx, async (db) => {
      await this.document(db, ctx, documentId);
      await db.execute(sql`select app.set_document_targets(${documentId}::uuid, ${json(body.targets)}::jsonb)`);
      return this.document(db, ctx, documentId);
    });
  }

  setSkills(ctx: RequestContext, documentId: string, skillIds: string[]) {
    return this.database.asUser(ctx, async (db) => {
      await this.document(db, ctx, documentId);
      await db.execute(sql`select app.set_document_skills(${documentId}::uuid, string_to_array(${skillIds.join(',')}, ',')::uuid[])`);
      return this.document(db, ctx, documentId);
    });
  }

  acknowledge(ctx: RequestContext, id: string, body: AcknowledgeBody) {
    return this.onRevision(ctx, id, (db) => db.execute(sql`select app.acknowledge_document(${id}::uuid, ${body.note ?? null})`));
  }

  /** Who was asked to read a revision and where each stands (document managers see everyone; others only themselves). */
  recipients(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, (db) => this.recipientsIn(db, ctx, id));
  }

  private async recipientsIn(db: Db, ctx: RequestContext, id: string) {
    {
      await this.revision(db, ctx, id);
      const rows = (
        await db.execute<Row>(sql`
          select x.id, x.user_id, x.reached_via, x.due_on::text as due_on, x.first_viewed_at, x.acknowledged_at, x.acknowledge_note, ${sql.raw(personName('px'))} as name
            from public.document_recipients x left join public.profiles px on px.id = x.user_id
           where x.revision_id = ${id}::uuid
           order by (x.acknowledged_at is not null), x.due_on nulls last, 8`)
      ).rows;
      const today = (await db.execute<Row>(sql`select current_date::text as d`)).rows[0].d as string;
      return {
        data: rows.map((x) => ({
          id: x.id as string,
          person: { id: x.user_id as string, name: (x.name as string) ?? 'Unknown' },
          reachedVia: x.reached_via as string[],
          dueOn: (x.due_on as string) ?? null,
          viewedAt: x.first_viewed_at ? (iso(x.first_viewed_at) as string) : null,
          acknowledgedAt: x.acknowledged_at ? (iso(x.acknowledged_at) as string) : null,
          note: (x.acknowledge_note as string) ?? null,
          overdue: !x.acknowledged_at && Boolean(x.due_on) && (x.due_on as string) < today,
        })),
      };
    }
  }

  addRecipient(ctx: RequestContext, id: string, userId: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.revision(db, ctx, id);
      await db.execute(sql`select app.add_document_recipient(${id}::uuid, ${userId}::uuid)`);
      return this.recipientsIn(db, ctx, id);
    });
  }

  /** The caller's reading: revisions in force still to acknowledge (overdue first), recent acknowledgements, and reviews waiting for them. */
  mine(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      await this.settle(db, ctx);
      const rows = (
        await db.execute<Row>(sql`
          select x.due_on::text as due_on, x.acknowledged_at, x.first_viewed_at, x.created_at, r.id as revision_id, r.letter, r.effective_from::text as effective_from,
                 d.id as document_id, d.number, d.title, (x.acknowledged_at is null and x.due_on < current_date) as overdue
            from public.document_recipients x
            join public.document_revisions r on r.id = x.revision_id
            join public.documents d on d.id = r.document_id
           where x.organisation_id = ${orgOf(ctx)}::uuid and x.user_id = auth.uid() and r.status = 'effective'
             and (x.acknowledged_at is null or x.acknowledged_at > now() - interval '90 days')
           order by (x.acknowledged_at is not null), (x.acknowledged_at is null and x.due_on < current_date) desc, x.due_on nulls last, x.acknowledged_at desc, d.number`)
      ).rows.map((x) => ({
        document: { id: x.document_id as string, number: x.number as string, title: x.title as string },
        revision: { id: x.revision_id as string, letter: x.letter as string, effectiveFrom: (x.effective_from as string) ?? null },
        dueOn: (x.due_on as string) ?? null,
        overdue: Boolean(x.overdue),
        viewedAt: x.first_viewed_at ? (iso(x.first_viewed_at) as string) : null,
        acknowledgedAt: x.acknowledged_at ? (iso(x.acknowledged_at) as string) : null,
        askedAt: iso(x.created_at) as string,
      }));
      const reviews = (await this.waitingIn(db, ctx)).length;
      return { toRead: rows.filter((x) => !x.acknowledgedAt), acknowledged: rows.filter((x) => x.acknowledgedAt), reviews };
    });
  }

  /** For the menu badge: documents to acknowledge, how many overdue, and reviews or approvals waiting. */
  mineCount(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      await this.settle(db, ctx);
      const c = (
        await db.execute<Row>(sql`
          select count(*)::int as to_read, count(*) filter (where x.due_on < current_date)::int as overdue
            from public.document_recipients x join public.document_revisions r on r.id = x.revision_id
           where x.organisation_id = ${orgOf(ctx)}::uuid and x.user_id = auth.uid() and x.acknowledged_at is null and r.status = 'effective'`)
      ).rows[0];
      const reviews = (await this.waitingIn(db, ctx)).length;
      return { toRead: Number(c.to_read), overdue: Number(c.overdue), reviews, total: Number(c.to_read) + reviews };
    });
  }

  // ---- periodic review, change requests, links (DC4) ------------------------------------------------

  recordReview(ctx: RequestContext, documentId: string, body: PeriodicReviewBody) {
    return this.database.asUser(ctx, async (db) => {
      await this.document(db, ctx, documentId);
      const res = await db.execute<Row>(sql`select app.record_document_review(${documentId}::uuid, ${body.outcome}, ${body.note ?? null}) as revision_id`);
      return { ...(await this.document(db, ctx, documentId)), startedRevisionId: (res.rows[0].revision_id as string) ?? null };
    });
  }

  setLinks(ctx: RequestContext, documentId: string, body: LinksBody) {
    return this.database.asUser(ctx, async (db) => {
      await this.document(db, ctx, documentId);
      await db.execute(sql`select app.set_document_links(${documentId}::uuid, ${json(body.links)}::jsonb)`);
      return this.document(db, ctx, documentId);
    });
  }

  private async changeRequestRows(db: Db, ctx: RequestContext, q: Partial<ChangeRequestListQuery>) {
    const where: SQL[] = [sql`c.organisation_id = ${orgOf(ctx)}::uuid`];
    if (q.status && q.status !== 'all') where.push(sql`c.status = ${q.status}`);
    if (q.documentId) where.push(sql`c.document_id = ${q.documentId}::uuid`);
    if (q.mine) where.push(sql`c.requested_by = auth.uid()`);
    return (
      await db.execute<Row>(sql`select * from (${CHANGE_REQUEST_SELECT}) c where ${sql.join(where, sql` and `)} order by (c.status = 'open') desc, c.created_at desc limit 500`)
    ).rows;
  }

  /** Change requests the caller may read: their own, or all of them for document managers. */
  changeRequests(ctx: RequestContext, q: ChangeRequestListQuery) {
    return this.database.asUser(ctx, async (db) => ({ data: (await this.changeRequestRows(db, ctx, q)).map(toChangeRequest) }));
  }

  private async changeRequest(db: Db, ctx: RequestContext, id: string) {
    const rows = (await db.execute<Row>(sql`select * from (${CHANGE_REQUEST_SELECT}) c where c.id = ${id}::uuid and c.organisation_id = ${orgOf(ctx)}::uuid`)).rows;
    if (rows.length === 0) throw ApiError.notFound('document_change_request_not_found', 'Change request not found');
    return toChangeRequest(rows[0]);
  }

  raiseChangeRequest(ctx: RequestContext, documentId: string, body: ChangeRequestBody) {
    return this.database.asUser(ctx, async (db) => {
      await this.document(db, ctx, documentId);
      const res = await db.execute<{ id: string }>(sql`select app.raise_document_change_request(${documentId}::uuid, ${body.what}, ${body.why}) as id`);
      return this.changeRequest(db, ctx, res.rows[0].id);
    });
  }

  private async onChangeRequest(ctx: RequestContext, id: string, run: (db: Db) => Promise<unknown>) {
    return this.database.asUser(ctx, async (db) => {
      await this.changeRequest(db, ctx, id);
      await run(db);
      return this.changeRequest(db, ctx, id);
    });
  }

  acceptChangeRequest(ctx: RequestContext, id: string) {
    return this.onChangeRequest(ctx, id, (db) => db.execute(sql`select app.accept_document_change_request(${id}::uuid)`));
  }
  declineChangeRequest(ctx: RequestContext, id: string, reason: string) {
    return this.onChangeRequest(ctx, id, (db) => db.execute(sql`select app.decline_document_change_request(${id}::uuid, ${reason})`));
  }
  withdrawChangeRequest(ctx: RequestContext, id: string) {
    return this.onChangeRequest(ctx, id, (db) => db.execute(sql`select app.withdraw_document_change_request(${id}::uuid)`));
  }

  /**
   * Documents in force where work happens: linked to the part (or its family), the family, the machine or the operation. Information only; the caller
   * sees only what they may read (restricted documents included only for their readers). Each says what it matched and whether the caller still has to read it.
   */
  inForce(ctx: RequestContext, q: InForceQuery) {
    return this.database.asUser(ctx, async (db) => {
      await this.settle(db, ctx);
      const org = orgOf(ctx);
      const family = q.partId
        ? ((await db.execute<Row>(sql`select part_family_id from public.parts where id = ${q.partId}::uuid and organisation_id = ${org}::uuid`)).rows[0]?.part_family_id as string | undefined)
        : undefined;
      const families = [q.partFamilyId, family].filter(Boolean) as string[];
      const rows = (
        await db.execute<Row>(sql`
          select d.id, d.number, d.title, t.name as type_name, cr.id as revision_id, cr.letter, cr.effective_from::text as effective_from,
                 array_agg(distinct case when l.part_id is not null then 'part' when l.part_family_id is not null then 'part family'
                                         when l.machine_id is not null then 'machine' else 'operation ' || l.operation_code end) as matched,
                 bool_or(x.id is not null and x.acknowledged_at is null) as to_acknowledge
            from public.document_links l
            join public.documents d on d.id = l.document_id and d.status = 'active'
            join public.document_types t on t.id = d.type_id
            join public.document_revisions cr on cr.id = d.current_revision_id
            left join public.document_recipients x on x.revision_id = cr.id and x.user_id = auth.uid()
           where l.organisation_id = ${org}::uuid and (
                 (${q.partId ?? null}::uuid is not null and l.part_id = ${q.partId ?? null}::uuid)
              or (l.part_family_id = any(string_to_array(${families.join(',')}, ',')::uuid[]))
              or (${q.machineId ?? null}::uuid is not null and l.machine_id = ${q.machineId ?? null}::uuid)
              or (${q.operationCode ?? null}::text is not null and upper(l.operation_code) = upper(${q.operationCode ?? null}::text)))
           group by d.id, d.number, d.title, t.name, cr.id, cr.letter, cr.effective_from
           order by bool_or(x.id is not null and x.acknowledged_at is null) desc, d.number
           limit 100`)
      ).rows;
      return {
        data: rows.map((r) => ({
          id: r.id as string,
          number: r.number as string,
          title: r.title as string,
          type: r.type_name as string,
          revision: { id: r.revision_id as string, letter: r.letter as string, effectiveFrom: (r.effective_from as string) ?? null },
          matched: r.matched as string[],
          toAcknowledge: Boolean(r.to_acknowledge),
        })),
      };
    });
  }
}
