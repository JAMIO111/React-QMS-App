import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { SpcService } from '../spc/spc.service';
import { grrPercentOf, judgeCapability, judgeGrr, LinkKind, minimumsFor, StudyJudgement } from './ppap-links';
import {
  AddFileBody, AddLinkBody, CandidatesQuery, CreatePpapBody, CustomerRulesBody, DecisionBody, ELEMENT_LABEL, ELEMENT_ORDINAL, PpapListQuery, PswBody, ResubmitBody, ReviewBody,
  SaveRequirementsBody, SignPswBody, SubmitBody, UpdateElementBody, UpdatePpapBody,
} from './ppap.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown' } : null);
const json = (v: unknown) => JSON.stringify(v);
const num = (v: unknown) => (v == null ? null : Number(v));

/**
 * The register's row: a submission with its part revision, customer, owner and how far the required elements have got. Names are read as the caller, so a part
 * or customer they may not read has no name (the screen says so) rather than hiding the submission.
 */
const PPAP_SELECT = sql`
  select s.*, p.part_number, p.name as part_name, pr.revision as rev_letter, pr.version as rev_version, pr.status as rev_status,
         c.name as customer_name, c.code as customer_code, st.name as site_name, ${sql.raw(personName('po'))} as owner_name,
         (select count(*)::int from public.ppap_elements e where e.submission_id = s.id and e.requirement = 'required') as required_count,
         (select count(*)::int from public.ppap_elements e where e.submission_id = s.id and e.requirement = 'required' and e.status in ('ready', 'waived')) as done_count,
         s.next_review_on::text as next_review,
         (s.status = 'approved' and s.next_review_on < current_date) as review_overdue,
         (select d.expires_on::text from public.ppap_decisions d where d.submission_id = s.id and d.kind = 'interim_approved' order by d.seq desc limit 1) as interim_expires_on,
         coalesce((select d.expires_on < current_date from public.ppap_decisions d where d.submission_id = s.id and d.kind = 'interim_approved' order by d.seq desc limit 1), false) as interim_expired
    from public.ppap_submissions s
    left join public.parts p on p.id = s.part_id
    left join public.part_revisions pr on pr.id = s.part_revision_id
    left join public.customers c on c.id = s.customer_id
    left join public.sites st on st.id = s.site_id
    left join public.profiles po on po.id = s.owner_user_id`;

const SORT: Record<PpapListQuery['sort'], string> = {
  reference: 'x.reference',
  part: 'lower(x.part_number)',
  customer: 'lower(x.customer_name)',
  level: 'x.level',
  status: 'x.status',
  owner: 'lower(x.owner_name)',
  progress: '(case when x.required_count = 0 then 1 else x.done_count::numeric / x.required_count end)',
  updatedAt: 'x.updated_at',
  createdAt: 'x.created_at',
};

const revisionLabel = (letter: unknown, version: unknown) => (letter ? `${letter as string}${Number(version) > 1 ? ` v${Number(version)}` : ''}` : null);

const toSummary = (r: Row) => ({
  id: r.id as string,
  reference: r.reference as string,
  direction: r.direction as 'submitted' | 'received',
  status: r.status as string,
  level: Number(r.level),
  reason: r.reason as string,
  notes: (r.notes as string) ?? null,
  part: { id: r.part_id as string, partNumber: (r.part_number as string) ?? null, name: (r.part_name as string) ?? null },
  partRevision: { id: r.part_revision_id as string, label: revisionLabel(r.rev_letter, r.rev_version), status: (r.rev_status as string) ?? null },
  customer: r.customer_id ? { id: r.customer_id as string, name: (r.customer_name as string) ?? null, code: (r.customer_code as string) ?? null } : null,
  site: r.site_id ? { id: r.site_id as string, name: (r.site_name as string) ?? null } : null,
  owner: person(r.owner_user_id, r.owner_name),
  requirementSetId: r.requirement_set_id as string,
  replacesId: (r.replaces_id as string) ?? null,
  /** How many elements are required, and how many of those are ready or waived. */
  progress: { required: Number(r.required_count ?? 0), done: Number(r.done_count ?? 0) },
  readyAt: r.ready_at ? iso(r.ready_at) : null,
  submittedAt: r.submitted_at ? iso(r.submitted_at) : null,
  withdrawReason: (r.withdraw_reason as string) ?? null,
  /** When an approved submission is next reviewed, and whether that date has passed. */
  nextReviewOn: (r.next_review as string) ?? null,
  reviewOverdue: Boolean(r.review_overdue),
  /** For an interim approval: the day it runs to, and whether that day has passed (worked out now, never stored). */
  interimExpiresOn: r.status === 'interim_approved' ? ((r.interim_expires_on as string) ?? null) : null,
  interimExpired: r.status === 'interim_approved' && Boolean(r.interim_expired),
  createdAt: iso(r.created_at) as string,
  updatedAt: iso(r.updated_at) as string,
});

/** What a linked record is now, as the database works it out for the caller (app.ppap_link_state). `available` is false when the caller may not read the record: never a blank pass. */
export interface LinkState {
  available: boolean;
  label?: string;
  status?: string;
  ok?: boolean;
  problem?: string | null;
  version?: string | null;
  frozen: boolean;
  frozenLabel?: string | null;
  frozenStatus?: string | null;
  frozenAt?: string | null;
  changedSince?: boolean;
}

const toEvidence = (r: Row, state: LinkState | null = null) => ({
  id: r.id as string,
  kind: r.kind as 'file' | 'link',
  fileName: (r.file_name as string) ?? null,
  storagePath: (r.storage_path as string) ?? null,
  contentType: (r.content_type as string) ?? null,
  sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
  description: (r.description as string) ?? null,
  /** For a link: the record, what it was when frozen, what it is now, and (for a study) whether it meets the agreed minimum. */
  link:
    r.kind === 'link'
      ? {
          targetKind: r.target_kind as LinkKind,
          targetId: r.target_id as string,
          frozenAt: r.frozen_at ? iso(r.frozen_at) : null,
          frozenLabel: (r.frozen_label as string) ?? null,
          frozenStatus: (r.frozen_status as string) ?? null,
          state,
          study: null as StudyJudgement | null,
        }
      : null,
  addedBy: person(r.created_by, r.added_by_name),
  addedAt: iso(r.created_at) as string,
  removedAt: r.removed_at ? iso(r.removed_at) : null,
  removeReason: (r.remove_reason as string) ?? null,
});

const toRules = (r: Row) => ({
  customerId: r.customer_id as string,
  customerName: (r.customer_name as string) ?? null,
  customerCode: (r.customer_code as string) ?? null,
  defaultLevel: num(r.default_level),
  extraElements: (r.extra_elements as string[]) ?? [],
  minCpkInitial: num(r.min_cpk_initial),
  minCpkOngoing: num(r.min_cpk_ongoing),
  minReadings: num(r.min_readings),
  maxGrrPercent: num(r.max_grr_percent),
  note: (r.note as string) ?? null,
  updatedAt: iso(r.updated_at) as string,
});

/** PPAP (PP1): submissions with their 18 elements and file evidence, and the organisation's requirements. Every write is a database function; reading is by RLS. */
@Injectable()
export class PpapService {
  constructor(
    private readonly database: DatabaseService,
    private readonly spc: SpcService,
  ) {}

  // ---- the register ---------------------------------------------------------------------------------

  list(ctx: RequestContext, q: PpapListQuery) {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`x.organisation_id = ${orgOf(ctx)}::uuid`];
      const statuses = (q.status ?? 'live').split(',');
      if (!statuses.includes('all')) {
        const named = statuses.filter((s) => s !== 'live');
        where.push(
          statuses.includes('live')
            ? sql`(x.status not in ('withdrawn', 'rejected') or x.status = any(string_to_array(${named.join(',')}, ',')))`
            : sql`x.status = any(string_to_array(${named.join(',')}, ','))`,
        );
      }
      if (q.direction) where.push(sql`x.direction = any(string_to_array(${q.direction}, ','))`);
      if (q.level) where.push(sql`x.level::text = any(string_to_array(${q.level}, ','))`);
      if (q.reason) where.push(sql`x.reason = any(string_to_array(${q.reason}, ','))`);
      if (q.owner === 'me') where.push(sql`x.owner_user_id = auth.uid()`);
      if (q.customerId) where.push(sql`x.customer_id = ${q.customerId}::uuid`);
      if (q.partId) where.push(sql`x.part_id = ${q.partId}::uuid`);
      if (q.q) {
        const p = likePattern(q.q);
        where.push(sql`(x.reference ilike ${p} escape '\\' or x.part_number ilike ${p} escape '\\' or x.part_name ilike ${p} escape '\\'
                        or x.customer_name ilike ${p} escape '\\' or x.owner_name ilike ${p} escape '\\')`);
      }
      const filter = sql.join(where, sql` and `);
      const total = (await db.execute<Row>(sql`select count(*)::int as n from (${PPAP_SELECT}) x where ${filter}`)).rows[0];
      const rows = (
        await db.execute<Row>(sql`
          select * from (${PPAP_SELECT}) x where ${filter}
           order by ${sql.raw(SORT[q.sort])} ${sql.raw(q.order === 'desc' ? 'desc nulls last' : 'asc nulls last')}, x.reference
           limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`)
      ).rows;
      return { data: rows.map(toSummary), page: q.page, pageSize: q.pageSize, total: Number(total.n) };
    });
  }

  // ---- one submission --------------------------------------------------------------------------------

  async ppap(db: Db, ctx: RequestContext, id: string) {
    const org = orgOf(ctx);
    const found = (await db.execute<Row>(sql`select * from (${PPAP_SELECT}) x where x.id = ${id}::uuid and x.organisation_id = ${org}::uuid`)).rows[0];
    if (!found) throw ApiError.notFound('ppap_not_found', 'PPAP submission not found');
    const can = (
      await db.execute<Row>(sql`select app.has_permission(${org}::uuid, 'ppap.manage') as manage, app.has_permission(${org}::uuid, 'ppap.approve') as approve`)
    ).rows[0];
    const elementRows = (
      await db.execute<Row>(sql`
        select e.*, ${sql.raw(personName('pw'))} as waived_by_name from public.ppap_elements e left join public.profiles pw on pw.id = e.waived_by
         where e.submission_id = ${id}::uuid and e.organisation_id = ${org}::uuid`)
    ).rows;
    const evidenceRows = (
      await db.execute<Row>(sql`
        select v.*, ${sql.raw(personName('pc'))} as added_by_name from public.ppap_evidence v left join public.profiles pc on pc.id = v.created_by
         where v.submission_id = ${id}::uuid and v.organisation_id = ${org}::uuid order by v.created_at`)
    ).rows;
    const states = new Map<string, LinkState>(
      (
        await db.execute<Row>(sql`
          select v.id, app.ppap_link_state(v.id) as s from public.ppap_evidence v
           where v.submission_id = ${id}::uuid and v.organisation_id = ${org}::uuid and v.kind = 'link' and v.removed_at is null`)
      ).rows.map((x) => [x.id as string, x.s as LinkState]),
    );
    const byElement = new Map<string, ReturnType<typeof toEvidence>[]>();
    for (const v of evidenceRows) {
      const list = byElement.get(v.element_id as string) ?? [];
      list.push(toEvidence(v, states.get(v.id as string) ?? null));
      byElement.set(v.element_id as string, list);
    }
    const elements = elementRows
      .map((e) => {
        const evidence = byElement.get(e.id as string) ?? [];
        return {
          id: e.id as string,
          key: e.element_key as string,
          ordinal: ELEMENT_ORDINAL[e.element_key as string] ?? 99,
          label: ELEMENT_LABEL[e.element_key as string] ?? (e.element_key as string),
          requirement: e.requirement as 'required' | 'retain' | 'not_required' | 'n_a',
          requirementEdited: !!e.requirement_edited,
          status: e.status as 'not_started' | 'in_progress' | 'ready' | 'waived',
          note: (e.note as string) ?? null,
          waiver: e.waiver_reason ? { reason: e.waiver_reason as string, by: person(e.waived_by, e.waived_by_name), at: iso(e.waived_at) as string } : null,
          evidence,
          liveEvidence: evidence.filter((v) => !v.removedAt).length,
        };
      })
      .sort((a, b) => a.ordinal - b.ordinal);
    const problems = (await db.execute<Row>(sql`select app.ppap_problems(${id}::uuid) as p`)).rows[0].p as string[];
    const set = (
      await db.execute<Row>(sql`select id, version, config from public.ppap_requirement_sets where id = ${found.requirement_set_id as string}::uuid and organisation_id = ${org}::uuid`)
    ).rows[0];
    const status = found.status as string;
    const editing = ['draft', 'in_preparation'].includes(status);
    const sent = ['submitted', 'interim_approved'].includes(status);
    const me = (await db.execute<Row>(sql`select auth.uid() as id`)).rows[0].id as string | null;
    const pswRow = (await db.execute<Row>(sql`select w.*, w.signed_on::text as signed_day from public.ppap_psw w where w.submission_id = ${id}::uuid and w.organisation_id = ${org}::uuid`)).rows[0];
    const decisionRows = (
      await db.execute<Row>(sql`
        select d.*, d.decided_on::text as decided_day, d.expires_on::text as expires_day, ${sql.raw(personName('pc'))} as by_name
          from public.ppap_decisions d left join public.profiles pc on pc.id = d.created_by
         where d.submission_id = ${id}::uuid and d.organisation_id = ${org}::uuid order by d.seq`)
    ).rows;
    const reviewRows = (
      await db.execute<Row>(sql`
        select r.*, r.next_review_on::text as next_day, n.reference as new_reference, ${sql.raw(personName('pc'))} as by_name
          from public.ppap_reviews r left join public.profiles pc on pc.id = r.created_by left join public.ppap_submissions n on n.id = r.new_submission_id
         where r.submission_id = ${id}::uuid and r.organisation_id = ${org}::uuid order by r.created_at`)
    ).rows;
    const replaces = found.replaces_id
      ? (await db.execute<Row>(sql`select id, reference, status from public.ppap_submissions where id = ${found.replaces_id as string}::uuid and organisation_id = ${org}::uuid`)).rows[0]
      : undefined;
    const replacedBy = (await db.execute<Row>(sql`select id, reference, status from public.ppap_submissions where replaces_id = ${id}::uuid and organisation_id = ${org}::uuid order by created_at`)).rows;
    const wasSent = decisionRows.some((d) => d.kind === 'submitted');
    const pswMissing: string[] = [];
    if (!pswRow || pswRow.part_weight == null) pswMissing.push('the part weight');
    if (!pswRow || pswRow.results_meet_requirements == null) pswMissing.push('whether the results meet the requirements');
    if (pswRow && pswRow.results_meet_requirements === false && !pswRow.declaration) pswMissing.push('what does not meet them');
    const preparedByMe = Boolean(me) && (me === found.owner_user_id || me === found.created_by || (pswRow && me === pswRow.prepared_by));
    const signed = Boolean(pswRow?.signed_at);
    const canSign = Boolean(can.approve) && editing && Boolean(pswRow) && !signed && pswMissing.length === 0 && !preparedByMe;
    return {
      ...toSummary(found),
      elements,
      problems,
      /** The lines in `problems` that come from judging a study (capability, gauge R&R) against the agreed minimums; the database does not know these. */
      studyProblems: [] as string[],
      requirementSet: set ? { id: set.id as string, version: Number(set.version), config: set.config } : null,
      /** The Part Submission Warrant: the typed fields, who prepared it, and the signature. The rest of the form is the submission itself (see GET /ppaps/{id}/psw). */
      psw: pswRow
        ? {
            partWeight: pswRow.part_weight == null ? null : Number(pswRow.part_weight),
            weightUnit: (pswRow.weight_unit as string) ?? null,
            purchaseOrder: (pswRow.purchase_order as string) ?? null,
            engineeringChangeLevel: (pswRow.engineering_change_level as string) ?? null,
            resultsMeetRequirements: pswRow.results_meet_requirements == null ? null : Boolean(pswRow.results_meet_requirements),
            declaration: (pswRow.declaration as string) ?? null,
            signature: signed
              ? { name: pswRow.signer_name as string, title: (pswRow.signer_title as string) ?? null, phone: (pswRow.signer_phone as string) ?? null, on: pswRow.signed_day as string, at: iso(pswRow.signed_at) as string }
              : null,
            unsigned: pswRow.unsigned_at ? { at: iso(pswRow.unsigned_at) as string, reason: (pswRow.unsign_reason as string) ?? null } : null,
            frozen: Boolean(pswRow.frozen_at),
            missing: pswMissing,
          }
        : null,
      /** What happened and when, oldest first: sent, the customer's decisions, withdrawn. Never edited. */
      decisions: decisionRows.map((d) => ({
        id: d.id as string,
        seq: Number(d.seq),
        kind: d.kind as 'submitted' | 'approved' | 'interim_approved' | 'rejected' | 'withdrawn',
        decidedOn: d.decided_day as string,
        how: (d.how as string) ?? null,
        theirReference: (d.their_reference as string) ?? null,
        expiresOn: (d.expires_day as string) ?? null,
        note: (d.note as string) ?? null,
        file: d.storage_path ? { storagePath: d.storage_path as string, fileName: d.file_name as string, contentType: (d.content_type as string) ?? null, sizeBytes: Number(d.size_bytes) } : null,
        recordedBy: person(d.created_by, d.by_name),
        recordedAt: iso(d.created_at) as string,
      })),
      reviews: reviewRows.map((r) => ({
        id: r.id as string,
        outcome: r.outcome as 'no_change' | 'resubmission_started',
        note: (r.note as string) ?? null,
        nextReviewOn: (r.next_day as string) ?? null,
        newSubmission: r.new_submission_id ? { id: r.new_submission_id as string, reference: (r.new_reference as string) ?? null } : null,
        by: person(r.created_by, r.by_name),
        at: iso(r.created_at) as string,
      })),
      replaces: replaces ? { id: replaces.id as string, reference: replaces.reference as string, status: replaces.status as string } : null,
      replacedBy: replacedBy.map((x) => ({ id: x.id as string, reference: x.reference as string, status: x.status as string })),
      /** Whether the elements and the wording can still change (draft or in preparation). */
      editable: Boolean(can.manage) && editing,
      canManage: Boolean(can.manage),
      canApprove: Boolean(can.approve),
      canMarkReady: Boolean(can.manage) && editing && problems.length === 0,
      canReopen: Boolean(can.manage) && status === 'ready',
      canSavePsw: Boolean(can.manage) && editing && !signed,
      canSign,
      /** Why an approver who could otherwise sign cannot: they prepared it. */
      signBlocked: Boolean(can.approve) && editing && Boolean(pswRow) && !signed && pswMissing.length === 0 && preparedByMe ? 'You prepared this submission, so someone else with approval rights must sign the warrant.' : null,
      canUnsign: Boolean(can.approve) && editing && signed,
      canSubmit: Boolean(can.manage) && status === 'ready',
      canRecordDecision: Boolean(can.approve) && sent,
      canWithdraw: (Boolean(can.manage) && ['draft', 'in_preparation', 'ready'].includes(status)) || (Boolean(can.approve) && sent),
      canResubmit: Boolean(can.manage) && (['rejected', 'approved'].includes(status) || (status === 'withdrawn' && wasSent)),
      canReview: Boolean(can.manage) && status === 'approved',
    };
  }

  /** Runs the work (which answers the submission's id), reads the whole submission, then judges its studies against the agreed minimums. */
  private async answer(ctx: RequestContext, work: (db: Db) => Promise<string>) {
    const d = await this.database.asUser(ctx, async (db) => this.ppap(db, ctx, await work(db)));
    return this.withStudies(ctx, d);
  }

  get(ctx: RequestContext, id: string) {
    return this.answer(ctx, async () => id);
  }

  async create(ctx: RequestContext, body: CreatePpapBody) {
    let created = false;
    const d = await this.answer(ctx, async (db) => {
      const made = (await db.execute<Row>(sql`select app.create_ppap(${orgOf(ctx)}::uuid, ${json(body)}::jsonb) as r`)).rows[0].r as { id: string; created: boolean };
      created = made.created;
      return made.id;
    });
    return { ...d, created };
  }

  update(ctx: RequestContext, id: string, body: UpdatePpapBody) {
    return this.command(ctx, id, sql`select app.update_ppap(${id}::uuid, ${json(body)}::jsonb)`);
  }

  setLevel(ctx: RequestContext, id: string, level: number) {
    return this.command(ctx, id, sql`select app.set_ppap_level(${id}::uuid, ${level})`);
  }

  async markReady(ctx: RequestContext, id: string) {
    const before = await this.get(ctx, id);
    // The database answers first when it has something to say; a study that does not meet its minimum is the API's to refuse.
    if (before.studyProblems.length > 0 && before.problems.length === before.studyProblems.length) {
      throw new ApiError(409, 'ppap_rule', `Not ready yet: ${before.studyProblems[0]}`);
    }
    return this.command(ctx, id, sql`select app.mark_ppap_ready(${id}::uuid)`);
  }

  reopen(ctx: RequestContext, id: string) {
    return this.command(ctx, id, sql`select app.reopen_ppap(${id}::uuid)`);
  }

  withdraw(ctx: RequestContext, id: string, reason: string) {
    return this.command(ctx, id, sql`select app.withdraw_ppap(${id}::uuid, ${reason})`);
  }

  // ---- the warrant, submitting, the customer's decision ---------------------------------------------------

  savePsw(ctx: RequestContext, id: string, body: PswBody) {
    return this.command(ctx, id, sql`select app.save_ppap_psw(${id}::uuid, ${json(body)}::jsonb)`);
  }

  signPsw(ctx: RequestContext, id: string, body: SignPswBody) {
    return this.command(ctx, id, sql`select app.sign_ppap_psw(${id}::uuid, ${body.title}, ${body.phone ?? null})`);
  }

  unsignPsw(ctx: RequestContext, id: string, reason: string) {
    return this.command(ctx, id, sql`select app.unsign_ppap_psw(${id}::uuid, ${reason})`);
  }

  /** Sends the submission. A study that no longer meets its minimum (the API judges these, not the database) stops it just as the database stops a record that is no longer in good standing. */
  async submit(ctx: RequestContext, id: string, body: SubmitBody) {
    const before = await this.get(ctx, id);
    if (before.status === 'ready' && before.studyProblems.length > 0) {
      throw new ApiError(409, 'ppap_rule', `Something changed since it was marked ready: ${before.studyProblems[0]}`);
    }
    return this.command(ctx, id, sql`select app.submit_ppap(${id}::uuid, ${body.sentOn ?? null}::date, ${body.how ?? null}, ${body.note ?? null})`);
  }

  decide(ctx: RequestContext, id: string, body: DecisionBody) {
    return this.command(
      ctx,
      id,
      sql`select app.record_ppap_decision(${id}::uuid, ${body.kind}, ${body.decidedOn}::date, ${body.theirReference ?? null}, ${body.expiresOn ?? null}::date, ${body.note ?? null},
                                          ${body.storagePath ?? null}, ${body.fileName ?? null}, ${body.contentType ?? null}, ${body.sizeBytes ?? null}::bigint)`,
    );
  }

  /** Starts a new submission that replaces this one and answers with the new one. */
  async resubmit(ctx: RequestContext, id: string, body: ResubmitBody) {
    let created = false;
    let linksCarried = 0;
    const d = await this.answer(ctx, async (db) => {
      const r = (await db.execute<Row>(sql`select app.start_ppap_resubmission(${id}::uuid, ${json(body)}::jsonb) as r`)).rows[0].r as { id: string; created: boolean; linksCarried?: number };
      created = r.created;
      linksCarried = r.linksCarried ?? 0;
      return r.id;
    });
    return { ...d, created, linksCarried };
  }

  review(ctx: RequestContext, id: string, body: ReviewBody) {
    return this.command(ctx, id, sql`select app.record_ppap_review(${id}::uuid, ${body.note}, ${body.nextReviewOn ?? null}::date)`);
  }

  /**
   * The Part Submission Warrant as a form: the typed fields beside what the submission already knows (part, revision, customer, site, reason, level), the signer, and whether it
   * is frozen. Read as the caller, so a part or customer they may not read has no name on it.
   */
  pswForm(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      const org = orgOf(ctx);
      const r = (
        await db.execute<Row>(sql`
          select s.id, s.reference, s.status, s.level, s.reason, o.name as organisation_name,
                 p.part_number, p.name as part_name, pr.revision as rev_letter, pr.version as rev_version, pr.drawing_ref, pr.released_at::date::text as released_day,
                 c.name as customer_name, c.code as customer_code,
                 concat_ws(', ', nullif(c.address_line1, ''), nullif(c.address_line2, ''), nullif(c.address_line3, ''), nullif(c.city, ''), nullif(c.region, ''), nullif(c.postcode, ''), nullif(c.country, '')) as customer_address,
                 st.name as site_name,
                 w.part_weight, w.weight_unit, w.purchase_order, w.engineering_change_level, w.results_meet_requirements, w.declaration,
                 w.signer_name, w.signer_title, w.signer_phone, w.signed_on::text as signed_day, w.frozen_at,
                 (select d.decided_on::text from public.ppap_decisions d where d.submission_id = s.id and d.kind = 'submitted' order by d.seq limit 1) as sent_day
            from public.ppap_submissions s
            left join public.organisations o on o.id = s.organisation_id
            left join public.parts p on p.id = s.part_id
            left join public.part_revisions pr on pr.id = s.part_revision_id
            left join public.customers c on c.id = s.customer_id
            left join public.sites st on st.id = s.site_id
            left join public.ppap_psw w on w.submission_id = s.id
           where s.id = ${id}::uuid and s.organisation_id = ${org}::uuid`)
      ).rows[0];
      if (!r) throw ApiError.notFound('ppap_not_found', 'PPAP submission not found');
      return {
        submissionId: r.id as string,
        reference: r.reference as string,
        status: r.status as string,
        level: Number(r.level),
        reason: r.reason as string,
        organisation: (r.organisation_name as string) ?? null,
        part: { number: (r.part_number as string) ?? null, name: (r.part_name as string) ?? null },
        revision: { label: revisionLabel(r.rev_letter, r.rev_version), drawingRef: (r.drawing_ref as string) ?? null, releasedOn: (r.released_day as string) ?? null },
        customer: { name: (r.customer_name as string) ?? null, code: (r.customer_code as string) ?? null, address: (r.customer_address as string) || null },
        site: (r.site_name as string) ?? null,
        purchaseOrder: (r.purchase_order as string) ?? null,
        engineeringChangeLevel: (r.engineering_change_level as string) ?? null,
        weight: r.part_weight == null ? null : { value: Number(r.part_weight), unit: r.weight_unit as string },
        resultsMeetRequirements: r.results_meet_requirements == null ? null : Boolean(r.results_meet_requirements),
        declaration: (r.declaration as string) ?? null,
        signer: r.signer_name ? { name: r.signer_name as string, title: (r.signer_title as string) ?? null, phone: (r.signer_phone as string) ?? null, signedOn: r.signed_day as string } : null,
        sentOn: (r.sent_day as string) ?? null,
        /** True once the submission has been sent: until then the form is a draft and prints as one. */
        frozen: Boolean(r.frozen_at),
      };
    });
  }

  private command(ctx: RequestContext, id: string, statement: SQL) {
    return this.answer(ctx, async (db) => {
      await db.execute(statement);
      return id;
    });
  }

  // ---- elements and evidence -------------------------------------------------------------------------

  /** Runs a command on an element and answers with the whole submission it belongs to. */
  private elementCommand(ctx: RequestContext, elementId: string, statement: SQL) {
    return this.answer(ctx, async (db) => {
      await db.execute(statement);
      const e = (await db.execute<Row>(sql`select submission_id from public.ppap_elements where id = ${elementId}::uuid`)).rows[0];
      if (!e) throw ApiError.notFound('ppap_not_found', 'PPAP element not found');
      return e.submission_id as string;
    });
  }

  updateElement(ctx: RequestContext, id: string, body: UpdateElementBody) {
    return this.elementCommand(ctx, id, sql`select app.set_ppap_element(${id}::uuid, ${json(body)}::jsonb)`);
  }

  addFile(ctx: RequestContext, id: string, body: AddFileBody) {
    return this.elementCommand(
      ctx,
      id,
      sql`select app.add_ppap_file(${id}::uuid, ${body.storagePath}, ${body.fileName}, ${body.contentType ?? null}, ${body.sizeBytes}, ${body.description ?? null})`,
    );
  }

  waive(ctx: RequestContext, id: string, reason: string) {
    return this.elementCommand(ctx, id, sql`select app.waive_ppap_element(${id}::uuid, ${reason})`);
  }

  unwaive(ctx: RequestContext, id: string) {
    return this.elementCommand(ctx, id, sql`select app.unwaive_ppap_element(${id}::uuid)`);
  }

  addLink(ctx: RequestContext, id: string, body: AddLinkBody) {
    return this.elementCommand(ctx, id, sql`select app.add_ppap_link(${id}::uuid, ${body.kind}, ${body.targetId}::uuid, ${body.description ?? null})`);
  }

  removeEvidence(ctx: RequestContext, id: string, reason: string) {
    return this.answer(ctx, async (db) => {
      const v = (await db.execute<Row>(sql`select submission_id from public.ppap_evidence where id = ${id}::uuid`)).rows[0];
      await db.execute(sql`select app.remove_ppap_evidence(${id}::uuid, ${reason})`);
      if (!v) throw ApiError.notFound('ppap_not_found', 'Evidence not found');
      return v.submission_id as string;
    });
  }

  /** Records of one kind that can be linked to an element (read as the caller), each with its own state so the screen can show it beside the name. */
  candidates(ctx: RequestContext, q: CandidatesQuery) {
    return this.database.asUser(ctx, async (db) => {
      const rows = (await db.execute<Row>(sql`select * from app.ppap_candidates(${q.elementId}::uuid, ${q.kind}, ${q.q ?? null}, ${q.limit})`)).rows;
      return {
        kind: q.kind,
        data: rows.map((r) => ({
          id: r.target_id as string,
          label: r.label as string,
          status: r.status as string,
          ok: Boolean(r.ok),
          problem: (r.problem as string) ?? null,
          linked: Boolean(r.linked),
        })),
      };
    });
  }

  // ---- studies: statistics the database does not do -----------------------------------------------------

  /**
   * Judges the capability studies and gauge R&R studies a submission links to against the agreed minimums (the customer's own where they set one). The caller needs spc.read
   * to see capability at all; without it the link says so and is not judged. Done after the database transaction because the control chart opens its own.
   */
  private async withStudies(ctx: RequestContext, d: Awaited<ReturnType<PpapService['ppap']>>) {
    const live = d.elements.flatMap((e) =>
      e.evidence.filter((v) => v.link && !v.removedAt && v.link.state?.available && ['plan_characteristic', 'msa_study'].includes(v.link.targetKind)).map((v) => ({ e, v })),
    );
    if (live.length === 0) return d;
    const config = d.requirementSet?.config as { minCpkInitial: number; minCpkOngoing: number; minReadings: number; maxGrrPercent: number } | undefined;
    if (!config) return d;
    const plan = live.filter((x) => x.v.link!.targetKind === 'plan_characteristic').map((x) => x.v.link!.targetId);
    const msa = live.filter((x) => x.v.link!.targetKind === 'msa_study').map((x) => x.v.link!.targetId);
    const org = orgOf(ctx);
    const facts = await this.database.asUser(ctx, async (db) => {
      const rules = d.customer
        ? (await db.execute<Row>(sql`select * from public.ppap_customer_rules where organisation_id = ${org}::uuid and customer_id = ${d.customer.id}::uuid`)).rows[0]
        : undefined;
      const can = (await db.execute<Row>(sql`select app.has_permission(${org}::uuid, 'spc.read') as spc`)).rows[0];
      const chars = plan.length
        ? (
            await db.execute<Row>(sql`
              select c.id, c.characteristic_key, c.data_type, o.operation_code,
                     (select count(*)::int from public.inspection_measurements m
                        join public.resolved_inspection_requirements q on q.id = m.requirement_id
                        join public.inspection_records ir on ir.id = q.inspection_record_id
                       where ir.part_id = ${d.part.id}::uuid and q.characteristic_key = c.characteristic_key and m.value_numeric is not null) as readings
                from public.control_plan_characteristics c join public.control_plan_operations o on o.id = c.operation_id
               where c.organisation_id = ${org}::uuid and c.id = any(string_to_array(${plan.join(',')}, ',')::uuid[])`)
          ).rows
        : [];
      const studies = msa.length
        ? (
            await db.execute<Row>(sql`
              select distinct on (s.id) s.id, s.study_type, r.result
                from public.msa_studies s left join public.msa_study_results r on r.study_id = s.id
               where s.organisation_id = ${org}::uuid and s.id = any(string_to_array(${msa.join(',')}, ',')::uuid[])
               order by s.id, r.created_at desc nulls last`)
          ).rows
        : [];
      return { rules, spc: Boolean(can.spc), chars: new Map(chars.map((c) => [c.id as string, c])), studies: new Map(studies.map((c) => [c.id as string, c])) };
    });
    const m = minimumsFor(config, facts.rules);
    const extra: string[] = [];
    for (const { e, v } of live) {
      const link = v.link!;
      let judged: StudyJudgement | null = null;
      if (link.targetKind === 'plan_characteristic') {
        const c = facts.chars.get(link.targetId);
        if (c && facts.spc) {
          const measured = c.data_type === 'variable';
          let ppk: number | null = null;
          let cpk: number | null = null;
          let readings = Number(c.readings ?? 0);
          if (measured) {
            try {
              const chart = (await this.spc.chart(ctx, { partId: d.part.id, characteristicKey: c.characteristic_key as string, operationCode: c.operation_code as string })) as {
                capability?: { n: number; within: { k: number | null }; overall: { k: number | null } } | null;
              };
              if (chart.capability) {
                ppk = chart.capability.overall.k;
                cpk = chart.capability.within.k;
                readings = chart.capability.n;
              }
            } catch {
              // a chart that cannot be drawn (no readings yet) is judged with what the count says
            }
          }
          judged = judgeCapability({ measured, readings, ppk, cpk }, m);
        } else if (c) {
          judged = { ok: true, text: 'Capability is not shown to you (it needs the right to see control charts)', problem: null };
        }
      } else {
        const s = facts.studies.get(link.targetId);
        if (s && s.study_type === 'grr_crossed') judged = judgeGrr(grrPercentOf(s.result), m);
      }
      link.study = judged;
      if (judged && !judged.ok && judged.problem && e.requirement === 'required' && e.status !== 'waived') {
        extra.push(`${e.label}: ${link.state?.label ?? 'a linked record'} ${judged.problem}`);
      }
    }
    d.problems.push(...extra);
    d.studyProblems.push(...extra);
    d.canMarkReady = d.canMarkReady && extra.length === 0;
    return d;
  }

  // ---- the requirements ------------------------------------------------------------------------------

  async requirements(ctx: RequestContext) {
    return this.database.asUser(ctx, (db) => this.requirementsOf(db, ctx));
  }

  private async requirementsOf(db: Db, ctx: RequestContext) {
    const org = orgOf(ctx);
    const rows = (
      await db.execute<Row>(sql`
        select r.*, ${sql.raw(personName('pc'))} as by_name from public.ppap_requirement_sets r left join public.profiles pc on pc.id = r.created_by
         where r.organisation_id = ${org}::uuid order by r.version desc`)
    ).rows;
    const can = (await db.execute<Row>(sql`select app.has_permission(${org}::uuid, 'ppap.approve') as approve`)).rows[0];
    const current = rows.find((r) => r.current);
    return {
      current: current ? { id: current.id as string, version: Number(current.version), config: current.config, reason: (current.reason as string) ?? null } : null,
      versions: rows.map((r) => ({
        id: r.id as string,
        version: Number(r.version),
        current: !!r.current,
        reason: (r.reason as string) ?? null,
        by: person(r.created_by, r.by_name),
        at: iso(r.created_at) as string,
      })),
      canChange: Boolean(can.approve),
    };
  }

  saveRequirements(ctx: RequestContext, body: SaveRequirementsBody) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.save_ppap_requirement_set(${orgOf(ctx)}::uuid, ${json(body.config)}::jsonb, ${body.reason})`);
      return this.requirementsOf(db, ctx);
    });
  }

  // ---- customer rules --------------------------------------------------------------------------------

  private async rulesOf(db: Db, ctx: RequestContext) {
    const org = orgOf(ctx);
    const rows = (
      await db.execute<Row>(sql`
        select r.*, c.name as customer_name, c.code as customer_code from public.ppap_customer_rules r left join public.customers c on c.id = r.customer_id
         where r.organisation_id = ${org}::uuid order by lower(c.name)`)
    ).rows;
    const can = (await db.execute<Row>(sql`select app.has_permission(${org}::uuid, 'ppap.approve') as approve`)).rows[0];
    return { data: rows.map(toRules), canChange: Boolean(can.approve) };
  }

  customerRules(ctx: RequestContext) {
    return this.database.asUser(ctx, (db) => this.rulesOf(db, ctx));
  }

  setCustomerRules(ctx: RequestContext, customerId: string, body: CustomerRulesBody) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.set_ppap_customer_rules(${customerId}::uuid, ${json(body)}::jsonb)`);
      return this.rulesOf(db, ctx);
    });
  }
}
