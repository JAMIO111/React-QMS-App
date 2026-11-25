import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { personName } from '../calibration/calibration.service';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { DatabaseService } from '../database/database.service';
import { OrganisationScoped } from '../tenancy/organisation.guard';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Id = z.string().uuid();
const n = (v: unknown) => Number(v ?? 0);
type Row = Record<string, unknown>;

/**
 * The SQL fragments the home page shares with this dashboard, so the two cannot disagree (`home-dashboard.e2e-spec.ts` compares them).
 * All are read under the caller's RLS (`fmea.read`); a draft, withdrawn or discarded FMEA is never "in force".
 */
/** FMEAs in force: active, with a revision in effect. */
export const FMEA_IN_FORCE = (org: string) => sql`
  select f.* from public.fmeas f where f.organisation_id = ${org}::uuid and f.status = 'active'`;
/** Revisions waiting for their approver. */
export const FMEA_AWAITING = (org: string) => sql`
  select r.* from public.fmea_revisions r where r.organisation_id = ${org}::uuid and r.status = 'pending_approval'`;
/** In-force FMEAs whose periodic review date has passed. */
export const FMEA_REVIEWS_OVERDUE = (org: string) => sql`
  select f.* from (${FMEA_IN_FORCE(org)}) f where f.next_review_on < current_date`;
/** Actions still open and past their due date, on an FMEA that is not withdrawn or discarded. */
export const FMEA_ACTIONS_OVERDUE = (org: string) => sql`
  select a.* from public.fmea_actions a join public.fmea_revisions rv on rv.id = a.revision_id join public.fmeas f on f.id = rv.fmea_id
   where a.organisation_id = ${org}::uuid and a.status = 'open' and a.due_on < current_date and f.status in ('draft', 'active')`;
/** Causes of revisions in effect that need attention (priority high, or severity at or above the model's floor). */
export const FMEA_CAUSES_IN_FORCE = (org: string) => sql`
  select c.* from public.fmea_causes c join public.fmea_revisions r on r.id = c.revision_id and r.status = 'effective'
   where c.organisation_id = ${org}::uuid`;

export const FmeaDashboardQuery = z
  .object({ from: isoDate, to: isoDate })
  .refine((q) => q.from <= q.to, { message: '"from" must be on or before "to"', path: ['from'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 3 * 366, { message: 'At most three years', path: ['from'] });

const ListFmea = z.object({
  id: Id, number: z.string(), title: z.string(), kind: z.string(), letter: z.string().nullable(), owner: z.string().nullable(), nextReviewOn: isoDate.nullable(), days: z.number().nullable(),
});

export const FmeaDashboard = z.object({
  period: z.object({ from: isoDate, to: isoDate, bucket: z.enum(['week', 'month']) }),
  kpis: z.object({
    /** As of today. */
    inForce: z.number(),
    /** Revisions being prepared (a first draft or a new revision of an FMEA in force). */
    drafts: z.number(),
    awaitingApproval: z.number(),
    reviewsOverdue: z.number(),
    /** Causes in the revisions in force that need attention, those of high priority, and those with no live control carried to a control plan. */
    needAttention: z.number(),
    highPriority: z.number(),
    notInPlan: z.number(),
    openActions: z.number(),
    overdueActions: z.number(),
    /** In the period. */
    actionsDone: z.number(),
    revisionsApproved: z.number(),
    started: z.number(),
    reviewsRecorded: z.number(),
  }),
  byPriority: z.array(z.object({ priority: z.string(), count: z.number() })),
  byKind: z.array(z.object({ kind: z.string(), count: z.number() })),
  trend: z.array(z.object({ start: isoDate, approved: z.number(), actionsDone: z.number() })),
  topCauses: z.array(z.object({
    causeId: Id, fmeaId: Id, revisionId: Id, number: z.string(), title: z.string(), failureMode: z.string(), cause: z.string(),
    severity: z.number().nullable(), occurrence: z.number().nullable(), detection: z.number().nullable(), rpn: z.number().nullable(), priority: z.string().nullable(), hasAction: z.boolean(),
  })),
  reviewsOverdue: z.array(ListFmea),
  awaitingApproval: z.array(z.object({ revisionId: Id, fmeaId: Id, number: z.string(), title: z.string(), letter: z.string().nullable(), submittedAt: z.string().nullable(), approver: z.string().nullable() })),
  overdueActions: z.array(z.object({ id: Id, fmeaId: Id, revisionId: Id, number: z.string(), title: z.string(), description: z.string(), owner: z.string().nullable(), dueOn: isoDate, days: z.number() })),
});
export type FmeaDashboard = z.infer<typeof FmeaDashboard>;

const PRIORITY_ORDER = ['high', 'medium', 'low'];

/** The FMEA dashboard: figures as of today and what happened in a period. Read as the caller (fmea.read); nothing is written. */
@Injectable()
export class FmeaDashboardService {
  constructor(private readonly database: DatabaseService) {}

  get(ctx: RequestContext, q: z.infer<typeof FmeaDashboardQuery>): Promise<FmeaDashboard> {
    const org = ctx.organisationId!;
    const bucket: 'week' | 'month' = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 92 ? 'week' : 'month';
    return this.database.asUser(ctx, async (db) => {
      const one = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows[0] ?? {};
      const many = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows;
      // Revisions take effect when someone looks (no worker), as on every read of an FMEA.
      await db.execute(sql`select app.settle_fmeas(${org}::uuid)`);

      const k = await one(sql`
        select (select count(*) from (${FMEA_IN_FORCE(org)}) f)::int as in_force,
               (select count(*) from public.fmea_revisions r where r.organisation_id = ${org}::uuid and r.status = 'draft')::int as drafts,
               (select count(*) from (${FMEA_AWAITING(org)}) r)::int as awaiting,
               (select count(*) from (${FMEA_REVIEWS_OVERDUE(org)}) f)::int as reviews_overdue,
               (select count(*) from public.fmea_actions a where a.organisation_id = ${org}::uuid and a.status = 'open')::int as open_actions,
               (select count(*) from (${FMEA_ACTIONS_OVERDUE(org)}) a)::int as overdue_actions,
               (select count(*) from public.fmea_actions a where a.organisation_id = ${org}::uuid and a.status = 'done' and a.done_at::date between ${q.from}::date and ${q.to}::date)::int as actions_done,
               (select count(*) from public.fmea_revisions r where r.organisation_id = ${org}::uuid and r.approved_at::date between ${q.from}::date and ${q.to}::date)::int as approved,
               (select count(*) from public.fmeas f where f.organisation_id = ${org}::uuid and f.status <> 'discarded' and f.created_at::date between ${q.from}::date and ${q.to}::date)::int as started,
               (select count(*) from public.fmea_reviews v where v.organisation_id = ${org}::uuid and v.created_at::date between ${q.from}::date and ${q.to}::date)::int as reviews`);
      const causes = await one(sql`
        select count(*) filter (where c.needs_attention)::int as need,
               count(*) filter (where c.priority = 'high')::int as high,
               count(*) filter (where c.needs_attention and not exists (
                 select 1 from public.fmea_control_links l where l.cause_id = c.id and l.ended_at is null))::int as not_in_plan
          from (${FMEA_CAUSES_IN_FORCE(org)}) c`);

      const byPriority = await many(sql`select coalesce(c.priority, 'unrated') as priority, count(*)::int as n from (${FMEA_CAUSES_IN_FORCE(org)}) c group by 1`);
      const byKind = await many(sql`select f.kind, count(*)::int as n from (${FMEA_IN_FORCE(org)}) f group by 1 order by 1`);
      const trend = await many(sql`
        select to_char(s, 'YYYY-MM-DD') as start,
               (select count(*)::int from public.fmea_revisions r where r.organisation_id = ${org}::uuid and r.approved_at::date between greatest(s::date, ${q.from}::date)
                  and least((s + ${sql.raw(`interval '1 ${bucket}'`)})::date - 1, ${q.to}::date)) as approved,
               (select count(*)::int from public.fmea_actions a where a.organisation_id = ${org}::uuid and a.status = 'done' and a.done_at::date between greatest(s::date, ${q.from}::date)
                  and least((s + ${sql.raw(`interval '1 ${bucket}'`)})::date - 1, ${q.to}::date)) as actions_done
          from generate_series(date_trunc(${bucket}, ${q.from}::date), ${q.to}::date, ${sql.raw(`interval '1 ${bucket}'`)}) s`);

      const top = await many(sql`
        select c.id, f.id as fmea_id, c.revision_id, f.number, f.title, m.text as failure_mode, c.text as cause,
               c.severity_used, c.occurrence, c.detection, c.rpn, c.priority,
               exists (select 1 from public.fmea_actions a where a.cause_id = c.id and a.status in ('open', 'done')) as has_action
          from (${FMEA_CAUSES_IN_FORCE(org)}) c
          join public.fmea_revisions r on r.id = c.revision_id join public.fmeas f on f.id = r.fmea_id
          join public.fmea_failure_modes m on m.id = c.failure_mode_id
         where c.needs_attention order by c.rpn desc nulls last, f.number limit 10`);
      const overdueReviews = await many(sql`
        select f.id, f.number, f.title, f.kind, r.letter, ${sql.raw(personName('p'))} as owner_name, f.next_review_on::text as next_review, (current_date - f.next_review_on)::int as days
          from (${FMEA_REVIEWS_OVERDUE(org)}) f left join public.fmea_revisions r on r.id = f.current_revision_id left join public.profiles p on p.id = f.owner_user_id
         order by f.next_review_on, f.number limit 10`);
      const awaiting = await many(sql`
        select r.id, f.id as fmea_id, f.number, f.title, r.letter, r.submitted_at, ${sql.raw(personName('p'))} as approver
          from (${FMEA_AWAITING(org)}) r join public.fmeas f on f.id = r.fmea_id left join public.profiles p on p.id = r.approver_id
         order by r.submitted_at nulls last, f.number limit 10`);
      const overdue = await many(sql`
        select a.id, r.fmea_id, a.revision_id, f.number, f.title, a.description, a.due_on::text as due, (current_date - a.due_on)::int as days,
               coalesce(${sql.raw(personName('e'))}, ${sql.raw(personName('op'))}) as owner_name
          from (${FMEA_ACTIONS_OVERDUE(org)}) a
          join public.fmea_revisions r on r.id = a.revision_id join public.fmeas f on f.id = r.fmea_id
          left join public."Employees" e on e.id = a.owner_employee_id and e.organisation_id = a.organisation_id
          left join public.profiles op on op.id = a.owner_user_id
         order by a.due_on, f.number limit 10`);

      const prio = new Map(byPriority.map((r) => [r.priority as string, n(r.n)]));
      return {
        period: { from: q.from, to: q.to, bucket },
        kpis: {
          inForce: n(k.in_force),
          drafts: n(k.drafts),
          awaitingApproval: n(k.awaiting),
          reviewsOverdue: n(k.reviews_overdue),
          needAttention: n(causes.need),
          highPriority: n(causes.high),
          notInPlan: n(causes.not_in_plan),
          openActions: n(k.open_actions),
          overdueActions: n(k.overdue_actions),
          actionsDone: n(k.actions_done),
          revisionsApproved: n(k.approved),
          started: n(k.started),
          reviewsRecorded: n(k.reviews),
        },
        byPriority: [...PRIORITY_ORDER, 'unrated'].map((priority) => ({ priority, count: prio.get(priority) ?? 0 })),
        byKind: byKind.map((r) => ({ kind: r.kind as string, count: n(r.n) })),
        trend: trend.map((r) => ({ start: r.start as string, approved: n(r.approved), actionsDone: n(r.actions_done) })),
        topCauses: top.map((r) => ({
          causeId: r.id as string, fmeaId: r.fmea_id as string, revisionId: r.revision_id as string, number: r.number as string, title: r.title as string,
          failureMode: r.failure_mode as string, cause: r.cause as string,
          severity: r.severity_used == null ? null : n(r.severity_used), occurrence: r.occurrence == null ? null : n(r.occurrence), detection: r.detection == null ? null : n(r.detection),
          rpn: r.rpn == null ? null : n(r.rpn), priority: (r.priority as string) ?? null, hasAction: Boolean(r.has_action),
        })),
        reviewsOverdue: overdueReviews.map((r) => ({
          id: r.id as string, number: r.number as string, title: r.title as string, kind: r.kind as string, letter: (r.letter as string) ?? null,
          owner: (r.owner_name as string) ?? null, nextReviewOn: (r.next_review as string) ?? null, days: r.days == null ? null : n(r.days),
        })),
        awaitingApproval: awaiting.map((r) => ({
          revisionId: r.id as string, fmeaId: r.fmea_id as string, number: r.number as string, title: r.title as string, letter: (r.letter as string) ?? null,
          submittedAt: r.submitted_at ? new Date(r.submitted_at as string).toISOString() : null, approver: (r.approver as string) ?? null,
        })),
        overdueActions: overdue.map((r) => ({
          id: r.id as string, fmeaId: r.fmea_id as string, revisionId: r.revision_id as string, number: r.number as string, title: r.title as string,
          description: r.description as string, owner: (r.owner_name as string) ?? null, dueOn: r.due as string, days: n(r.days),
        })),
      };
    });
  }
}

@ApiTags('fmea')
@ApiBearerAuth()
@Controller()
export class FmeaDashboardController {
  constructor(private readonly service: FmeaDashboardService) {}

  @Get('fmea-dashboard')
  @OrganisationScoped('fmea.read')
  @ApiQuery({ name: 'from', required: true, schema: { type: 'string', format: 'date' } })
  @ApiQuery({ name: 'to', required: true, schema: { type: 'string', format: 'date' } })
  @ApiOkResponse({ description: 'FMEAs in force, causes that need attention, open and overdue actions and reviews as of today, and what was approved, finished and started in the period', schema: openApiSchema(FmeaDashboard) })
  get(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.get(ctx, parse(FmeaDashboardQuery, query));
  }
}
