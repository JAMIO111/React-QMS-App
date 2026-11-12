import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { ActionBody, AttendeesBody, PlanReviewBody, REVIEW_STATUSES, UpdateActionBody, UpdateReviewBody } from './management-reviews.schemas';
import { QualityObjectivesService } from './quality-objectives.service';
import { DATA_SECTIONS, DataSection, ReviewInputsService } from './review-inputs';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const json = (v: unknown) => JSON.stringify(v);

const SECTION_SQL = sql`select key, ord, title, commentary_only from app.management_review_sections()`;

const REVIEW_SELECT = sql`
  select m.*, m.period_from::text as pf, m.period_to::text as pt, m.planned_on::text as po, m.held_on::text as ho,
         ${sql.raw(personName('pc'))} as chair_name, ${sql.raw(personName('pd'))} as completed_by_name, ${sql.raw(personName('px'))} as cancelled_by_name,
         (select count(*)::int from public.management_review_inputs i where i.review_id = m.id and i.reviewed) as reviewed_sections,
         (select count(*)::int from public.management_review_inputs i where i.review_id = m.id) as sections,
         (select count(*)::int from public.management_review_decisions d where d.review_id = m.id) as decision_count,
         (select count(*)::int from public.management_review_actions a where a.review_id = m.id and a.status = 'open') as open_actions,
         (select count(*)::int from public.management_review_actions a where a.review_id = m.id) as action_count
    from public.management_reviews m
    left join public.profiles pc on pc.id = m.chair_user_id
    left join public.profiles pd on pd.id = m.completed_by
    left join public.profiles px on px.id = m.cancelled_by`;

const toSummary = (r: Row) => ({
  id: r.id as string,
  reference: r.reference as string,
  title: r.title as string,
  periodFrom: r.pf as string,
  periodTo: r.pt as string,
  plannedOn: (r.po as string) ?? null,
  heldOn: (r.ho as string) ?? null,
  chair: { id: r.chair_user_id as string, name: (r.chair_name as string) ?? 'Unknown' },
  status: r.status as (typeof REVIEW_STATUSES)[number],
  sectionsReviewed: Number(r.reviewed_sections),
  sections: Number(r.sections),
  decisionCount: Number(r.decision_count),
  actionCount: Number(r.action_count),
  openActions: Number(r.open_actions),
  completedAt: r.completed_at ? (iso(r.completed_at) as string) : null,
  completedBy: (r.completed_by_name as string) ?? null,
  cancelReason: (r.cancel_reason as string) ?? null,
  cancelledAt: r.cancelled_at ? (iso(r.cancelled_at) as string) : null,
  cancelledBy: (r.cancelled_by_name as string) ?? null,
  createdAt: iso(r.created_at) as string,
});

/** Management reviews (MR2): plan, hold (inputs gathered as the person, commentary, attendees, minutes, decisions, actions), complete (frozen), cancel. */
@Injectable()
export class ManagementReviewsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly inputs: ReviewInputsService,
    private readonly objectives: QualityObjectivesService,
  ) {}

  /** Actions given to me, from any review (I may hold no management review permission: RLS shows me my own). */
  mine(ctx: RequestContext, status: 'open' | 'done' | 'all') {
    return this.database.asUser(ctx, async (db) => {
      const org = orgOf(ctx);
      const rows = (
        await db.execute<Row>(sql`
          select a.id, a.description, a.status, a.due_date::text as due, a.done_note, a.done_at, (a.status = 'open' and a.due_date < current_date) as overdue,
                 a.review_id, m.reference, m.title, m.status as review_status
            from public.management_review_actions a
            join app.my_review_action_reviews(${org}::uuid) m on m.id = a.review_id
           where a.organisation_id = ${org}::uuid and a.owner_user_id = auth.uid()
             ${status === 'open' ? sql`and a.status = 'open'` : status === 'done' ? sql`and a.status = 'done'` : sql``}
           order by (a.status = 'open') desc, a.due_date nulls last, a.created_at limit 200`)
      ).rows;
      const counts = (
        await db.execute<Row>(sql`
          select count(*) filter (where status = 'open')::int as open, count(*) filter (where status = 'open' and due_date < current_date)::int as overdue
            from public.management_review_actions where organisation_id = ${org}::uuid and owner_user_id = auth.uid()`)
      ).rows[0];
      return {
        data: rows.map((a) => ({
          id: a.id as string,
          description: a.description as string,
          status: a.status as 'open' | 'done' | 'cancelled',
          dueDate: (a.due as string) ?? null,
          overdue: Boolean(a.overdue),
          doneNote: (a.done_note as string) ?? null,
          doneAt: a.done_at ? (iso(a.done_at) as string) : null,
          review: { id: a.review_id as string, reference: a.reference as string, title: a.title as string, status: a.review_status as string },
        })),
        openCount: Number(counts.open),
        overdueCount: Number(counts.overdue),
      };
    });
  }

  /** For the home page card: the next review to hold, the last completed one, open and overdue actions, and how the quality objectives stand. */
  async overview(ctx: RequestContext) {
    const objectives = await this.objectives.list(ctx, false);
    return this.database.asUser(ctx, async (db) => {
      const org = orgOf(ctx);
      const next = (
        await db.execute<Row>(sql`
          select id, reference, title, status, planned_on::text as planned, held_on::text as held from public.management_reviews
           where organisation_id = ${org}::uuid and status in ('planned', 'in_progress')
           order by (status = 'in_progress') desc, planned_on nulls last, created_at limit 1`)
      ).rows[0];
      const last = (
        await db.execute<Row>(sql`
          select id, reference, title, held_on::text as held, completed_at, (current_date - held_on)::int as days_ago from public.management_reviews
           where organisation_id = ${org}::uuid and status = 'completed' order by held_on desc nulls last, completed_at desc limit 1`)
      ).rows[0];
      const actions = (
        await db.execute<Row>(sql`
          select count(*) filter (where a.status = 'open')::int as open, count(*) filter (where a.status = 'open' and a.due_date < current_date)::int as overdue
            from public.management_review_actions a join public.management_reviews m on m.id = a.review_id
           where a.organisation_id = ${org}::uuid and m.status <> 'cancelled'`)
      ).rows[0];
      const by = (s: string) => objectives.data.filter((o) => o.standing === s).length;
      return {
        next: next ? { id: next.id as string, reference: next.reference as string, title: next.title as string, status: next.status as string, plannedOn: (next.planned as string) ?? null, heldOn: (next.held as string) ?? null } : null,
        lastCompleted: last
          ? { id: last.id as string, reference: last.reference as string, title: last.title as string, heldOn: (last.held as string) ?? null, daysAgo: last.days_ago == null ? null : Number(last.days_ago) }
          : null,
        actions: { open: Number(actions.open), overdue: Number(actions.overdue) },
        objectives: { total: objectives.data.length, onTarget: by('on_target'), offTarget: by('off_target'), noValue: by('no_value') },
      };
    });
  }

  list(ctx: RequestContext, status?: string) {
    return this.database.asUser(ctx, async (db) => {
      const chosen = (status ?? '').split(',').filter((s) => (REVIEW_STATUSES as readonly string[]).includes(s));
      const rows = (
        await db.execute<Row>(sql`
          select * from (${REVIEW_SELECT}) m where m.organisation_id = ${orgOf(ctx)}::uuid
            ${chosen.length ? sql`and m.status = any(string_to_array(${chosen.join(',')}, ','))` : sql``}
           order by (m.status in ('planned', 'in_progress')) desc, m.period_to desc, m.reference desc limit 200`)
      ).rows;
      const manage = await this.can(db, orgOf(ctx));
      return { data: rows.map(toSummary), canManage: manage };
    });
  }

  private async can(db: Db, org: string) {
    return Boolean((await db.execute<Row>(sql`select app.has_permission(${org}::uuid, 'management_review.manage') as ok`)).rows[0].ok);
  }

  private async detailIn(db: Db, ctx: RequestContext, id: string) {
    const org = orgOf(ctx);
    const rows = (await db.execute<Row>(sql`select * from (${REVIEW_SELECT}) m where m.id = ${id}::uuid and m.organisation_id = ${org}::uuid`)).rows;
    if (rows.length === 0) throw ApiError.notFound('management_review_not_found', 'Management review not found');
    const r = rows[0];
    const sections = (await db.execute<Row>(SECTION_SQL)).rows;
    const inputs = (
      await db.execute<Row>(sql`
        select i.*, ${sql.raw(personName('pg'))} as gathered_by_name, ${sql.raw(personName('pr'))} as reviewed_by_name
          from public.management_review_inputs i left join public.profiles pg on pg.id = i.gathered_by left join public.profiles pr on pr.id = i.reviewed_by
         where i.review_id = ${id}::uuid order by i.position`)
    ).rows;
    const attendees = (
      await db.execute<Row>(sql`
        select a.*, ${sql.raw(personName('p'))} as person_name from public.management_review_attendees a left join public.profiles p on p.id = a.user_id
         where a.review_id = ${id}::uuid order by a.position`)
    ).rows;
    const decisions = (await db.execute<Row>(sql`select * from public.management_review_decisions where review_id = ${id}::uuid order by created_at, id`)).rows;
    const actions = (
      await db.execute<Row>(sql`
        select a.*, a.due_date::text as due, ${sql.raw(personName('p'))} as owner_name, ${sql.raw(personName('pd'))} as done_by_name
          from public.management_review_actions a left join public.profiles p on p.id = a.owner_user_id left join public.profiles pd on pd.id = a.done_by
         where a.review_id = ${id}::uuid order by a.created_at, a.id`)
    ).rows;
    const problems = (await db.execute<{ p: string[] }>(sql`select app.management_review_problems(${id}::uuid) as p`)).rows[0].p ?? [];
    const manage = await this.can(db, org);
    const status = r.status as string;
    const byKey = new Map(sections.map((s) => [s.key as string, s]));
    return {
      ...toSummary(r),
      minutes: (r.minutes as object) ?? null,
      noDecisionNote: (r.no_decision_note as string) ?? null,
      problems,
      canManage: manage,
      /** What may be done now (the database decides again). */
      canEdit: manage && (status === 'planned' || status === 'in_progress'),
      canHold: manage && status === 'in_progress',
      inputs: inputs.map((i) => {
        const s = byKey.get(i.section as string);
        return {
          id: i.id as string,
          section: i.section as string,
          title: (s?.title as string) ?? (i.section as string),
          commentaryOnly: Boolean(s?.commentary_only),
          available: i.available == null ? null : Boolean(i.available),
          snapshot: (i.snapshot as object) ?? null,
          gatheredAt: i.gathered_at ? (iso(i.gathered_at) as string) : null,
          gatheredBy: (i.gathered_by_name as string) ?? null,
          commentary: (i.commentary as string) ?? null,
          reviewed: Boolean(i.reviewed),
          reviewedAt: i.reviewed_at ? (iso(i.reviewed_at) as string) : null,
          reviewedBy: (i.reviewed_by_name as string) ?? null,
        };
      }),
      attendees: attendees.map((a) => ({
        id: a.id as string,
        userId: (a.user_id as string) ?? null,
        name: (a.user_id ? (a.person_name as string) : (a.name as string)) ?? 'Unknown',
        outsider: !a.user_id,
        role: (a.role as string) ?? null,
        attendance: a.attendance as 'invited' | 'present' | 'apologies',
      })),
      decisions: decisions.map((d) => ({ id: d.id as string, description: d.description as string, category: d.category as string, createdAt: iso(d.created_at) as string })),
      actions: actions.map((a) => ({
        id: a.id as string,
        decisionId: (a.decision_id as string) ?? null,
        description: a.description as string,
        owner: { id: a.owner_user_id as string, name: (a.owner_name as string) ?? 'Unknown' },
        dueDate: (a.due as string) ?? null,
        status: a.status as 'open' | 'done' | 'cancelled',
        doneNote: (a.done_note as string) ?? null,
        doneAt: a.done_at ? (iso(a.done_at) as string) : null,
        doneBy: (a.done_by_name as string) ?? null,
        cancelReason: (a.cancel_reason as string) ?? null,
        mine: a.owner_user_id === ctx.user.id,
      })),
    };
  }

  get(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, (db) => this.detailIn(db, ctx, id));
  }

  plan(ctx: RequestContext, body: PlanReviewBody) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ id: string }>(sql`select app.plan_management_review(${orgOf(ctx)}::uuid, ${json(body)}::jsonb) as id`);
      return this.detailIn(db, ctx, res.rows[0].id);
    });
  }

  /** Runs a command on a review of this organisation (404 for another's), then answers with the whole review. */
  private on(ctx: RequestContext, id: string, run: (db: Db) => Promise<unknown>) {
    return this.database.asUser(ctx, async (db) => {
      const found = await db.execute(sql`select 1 from public.management_reviews where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (found.rows.length === 0) throw ApiError.notFound('management_review_not_found', 'Management review not found');
      await run(db);
      return this.detailIn(db, ctx, id);
    });
  }

  /** The review a child row belongs to (404 when it is not this organisation's or cannot be read). */
  private async parentOf(ctx: RequestContext, table: 'management_review_inputs' | 'management_review_decisions' | 'management_review_actions', id: string) {
    const rows = await this.database.asUser(ctx, (db) =>
      db.execute<Row>(sql`select review_id from ${sql.identifier('public')}.${sql.identifier(table)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`),
    );
    if (rows.rows.length === 0) throw ApiError.notFound('not_found', 'Not found');
    return rows.rows[0].review_id as string;
  }

  update(ctx: RequestContext, id: string, body: UpdateReviewBody) {
    return this.on(ctx, id, (db) => db.execute(sql`select app.update_management_review(${id}::uuid, ${json(body)}::jsonb)`));
  }

  /** Starts the review and gathers every data section for its period, as the person. */
  async start(ctx: RequestContext, id: string) {
    await this.on(ctx, id, (db) => db.execute(sql`select app.start_management_review(${id}::uuid)`));
    return this.gather(ctx, id);
  }

  /** (Re)gathers data sections (all by default) for the review's period, as the person; each replaces the earlier snapshot and asks for a fresh review. */
  async gather(ctx: RequestContext, id: string, sections: DataSection[] = [...DATA_SECTIONS]) {
    const review = await this.get(ctx, id);
    if (review.status !== 'in_progress') throw new ApiError(409, 'management_review_rule', 'Inputs are gathered while the review is being held');
    const gathered = await this.inputs.gather(ctx, id, review.periodFrom, review.periodTo, sections);
    return this.on(ctx, id, async (db) => {
      for (const [section, g] of gathered) {
        await db.execute(sql`select app.set_management_review_snapshot(${id}::uuid, ${section}, ${g.available}, ${g.snapshot ? json(g.snapshot) : null}::jsonb)`);
      }
    });
  }

  async setInput(ctx: RequestContext, inputId: string, commentary: string | null | undefined, reviewed: boolean) {
    const review = await this.parentOf(ctx, 'management_review_inputs', inputId);
    return this.on(ctx, review, (db) => db.execute(sql`select app.set_management_review_input(${inputId}::uuid, ${commentary ?? null}, ${reviewed})`));
  }

  setAttendees(ctx: RequestContext, id: string, body: z.infer<typeof AttendeesBody>) {
    return this.on(ctx, id, (db) => db.execute(sql`select app.set_management_review_attendees(${id}::uuid, ${json(body.attendees)}::jsonb)`));
  }

  setMinutes(ctx: RequestContext, id: string, minutes: object | null) {
    return this.on(ctx, id, (db) => db.execute(sql`select app.set_management_review_minutes(${id}::uuid, ${minutes ? json(minutes) : null}::jsonb)`));
  }

  addDecision(ctx: RequestContext, id: string, description: string, category: string) {
    return this.on(ctx, id, (db) => db.execute(sql`select app.add_management_review_decision(${id}::uuid, ${description}, ${category})`));
  }

  async updateDecision(ctx: RequestContext, decisionId: string, description: string, category: string) {
    const review = await this.parentOf(ctx, 'management_review_decisions', decisionId);
    return this.on(ctx, review, (db) => db.execute(sql`select app.update_management_review_decision(${decisionId}::uuid, ${description}, ${category})`));
  }

  async removeDecision(ctx: RequestContext, decisionId: string) {
    const review = await this.parentOf(ctx, 'management_review_decisions', decisionId);
    return this.on(ctx, review, (db) => db.execute(sql`select app.remove_management_review_decision(${decisionId}::uuid)`));
  }

  addAction(ctx: RequestContext, id: string, body: z.infer<typeof ActionBody>) {
    return this.on(ctx, id, (db) => db.execute(sql`select app.add_management_review_action(${id}::uuid, ${json(body)}::jsonb)`));
  }

  async updateAction(ctx: RequestContext, actionId: string, body: z.infer<typeof UpdateActionBody>) {
    const review = await this.parentOf(ctx, 'management_review_actions', actionId);
    return this.on(ctx, review, (db) => db.execute(sql`select app.update_management_review_action(${actionId}::uuid, ${json(body)}::jsonb)`));
  }

  /** Closing an action: its owner may hold no management review permission, so this answers with the action only for them. */
  async completeAction(ctx: RequestContext, actionId: string, note: string) {
    const review = await this.parentOf(ctx, 'management_review_actions', actionId);
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.complete_management_review_action(${actionId}::uuid, ${note})`);
      const readable = (await db.execute(sql`select 1 from public.management_reviews where id = ${review}::uuid`)).rows.length > 0;
      return readable ? this.detailIn(db, ctx, review) : { id: actionId, status: 'done' };
    });
  }

  async cancelAction(ctx: RequestContext, actionId: string, reason: string) {
    const review = await this.parentOf(ctx, 'management_review_actions', actionId);
    return this.on(ctx, review, (db) => db.execute(sql`select app.cancel_management_review_action(${actionId}::uuid, ${reason})`));
  }

  async reopenAction(ctx: RequestContext, actionId: string) {
    const review = await this.parentOf(ctx, 'management_review_actions', actionId);
    return this.on(ctx, review, (db) => db.execute(sql`select app.reopen_management_review_action(${actionId}::uuid)`));
  }

  complete(ctx: RequestContext, id: string, note: string | null | undefined) {
    return this.on(ctx, id, (db) => db.execute(sql`select app.complete_management_review(${id}::uuid, ${note ?? null})`));
  }

  cancel(ctx: RequestContext, id: string, reason: string) {
    return this.on(ctx, id, (db) => db.execute(sql`select app.cancel_management_review(${id}::uuid, ${reason})`));
  }
}
