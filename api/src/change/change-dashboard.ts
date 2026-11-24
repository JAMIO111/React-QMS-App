import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { personName, Row } from '../calibration/calibration.service';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { DatabaseService } from '../database/database.service';
import { OrganisationScoped } from '../tenancy/organisation.guard';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const n = (v: unknown) => Number(v ?? 0);
const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);
const dec = (v: unknown) => (v == null ? null : Math.round(Number(v) * 10) / 10);

export const ChangeDashboardQuery = z
  .object({ from: isoDate, to: isoDate })
  .refine((q) => q.from <= q.to, { message: '"from" must be on or before "to"', path: ['from'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 3 * 366, { message: 'At most three years', path: ['from'] });

const Id = z.string().uuid();
export const ChangeDashboard = z.object({
  period: z.object({ from: isoDate, to: isoDate, bucket: z.enum(['week', 'month']) }),
  kpis: z.object({
    /** Changes that are being assessed, agreed, carried out or checked (not draft, closed, rejected or cancelled). */
    open: z.number(),
    expedited: z.number(),
    /** Changes with the board and the sign-offs they are waiting for. */
    atBoard: z.number(),
    signoffsWaiting: z.number(),
    /** Open tasks past their due date, on changes that are being carried out. */
    tasksOverdue: z.number(),
    tasksOpen: z.number(),
    /** Open changes whose cut-in is a date that has passed. A cut-in at an order, lot or serial number cannot be compared with a date, so it is not counted. */
    pastCutIn: z.number(),
    /** Open changes still waiting for the customer (approval required or asked for). */
    customerWaiting: z.number(),
    /** Drafts. */
    drafts: z.number(),
    /** In the period: submitted for assessment, approved, closed, and effectiveness checks that found the change not effective. */
    submitted: z.number(),
    approved: z.number(),
    closed: z.number(),
    notEffective: z.number(),
    /** Average days from submitted to approved (changes approved in the period) and from submitted to closed (closed in the period); null with none. */
    daysToApprove: z.number().nullable(),
    daysToClose: z.number().nullable(),
  }),
  byStage: z.array(z.object({ stage: z.string(), count: z.number() })),
  byType: z.array(z.object({ type: z.string(), count: z.number() })),
  trend: z.array(z.object({ start: isoDate, submitted: z.number(), closed: z.number() })),
  waitingSignoffs: z.array(z.object({ changeId: Id, reference: z.string(), title: z.string(), signer: z.string(), function: z.string(), days: z.number() })),
  overdueTasks: z.array(z.object({ taskId: Id, changeId: Id, reference: z.string(), description: z.string(), owner: z.string(), dueOn: isoDate, daysLate: z.number() })),
  pastCutInList: z.array(z.object({ changeId: Id, reference: z.string(), title: z.string(), stage: z.string(), cutInOn: isoDate, daysAgo: z.number() })),
  recentlyClosed: z.array(z.object({ changeId: Id, reference: z.string(), title: z.string(), closedOn: isoDate, result: z.string().nullable() })),
});
export type ChangeDashboard = z.infer<typeof ChangeDashboard>;

/** Stages where a change is under way. The home page uses the same lists, so the two cannot disagree. */
export const OPEN_STAGES = sql`('assessment', 'approval', 'approved', 'implementing', 'verifying')`;
/** Stages where tasks are carried out. */
export const WORKING_STAGES = sql`('approved', 'implementing', 'verifying')`;

/** Pending sign-offs of the round the board is working on (a change at the board). */
export const WAITING_SIGNOFFS = (org: string) => sql`
  select s.id, s.change_id, s.signer_user_id, s.function_id, s.created_at
    from public.change_signoffs s
    join public.change_requests c on c.id = s.change_id and c.organisation_id = s.organisation_id and c.stage = 'approval' and c.review_round = s.round
   where s.organisation_id = ${org}::uuid and s.status = 'pending'`;

/** Open tasks past their due date, on a change being carried out. */
export const LATE_TASKS = (org: string) => sql`
  select t.id, t.change_id, t.owner_user_id, t.description, t.due_on
    from public.change_tasks t
    join public.change_requests c on c.id = t.change_id and c.organisation_id = t.organisation_id and c.stage in ${WORKING_STAGES}
   where t.organisation_id = ${org}::uuid and t.status = 'open' and t.due_on is not null and t.due_on < current_date`;

/** Open changes whose cut-in is a date that has already passed. */
export const PAST_CUT_IN = (org: string) => sql`
  select c.id, c.cut_in_date
    from public.change_requests c
   where c.organisation_id = ${org}::uuid and c.stage in ${OPEN_STAGES} and c.cut_in_kind = 'date' and c.cut_in_date < current_date`;

/** Open changes still waiting for the customer. */
export const CUSTOMER_WAITING = (org: string) => sql`
  select c.id from public.change_requests c
   where c.organisation_id = ${org}::uuid and c.stage in ${OPEN_STAGES} and c.customer_approval in ('required', 'requested')`;

@Injectable()
export class ChangeDashboardService {
  constructor(private readonly database: DatabaseService) {}

  get(ctx: RequestContext, q: z.infer<typeof ChangeDashboardQuery>): Promise<ChangeDashboard> {
    const org = ctx.organisationId!;
    const bucket: 'week' | 'month' = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 92 ? 'week' : 'month';
    return this.database.asUser(ctx, async (db) => {
      const one = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows[0] ?? {};
      const many = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows;

      const state = await one(sql`
        select count(*) filter (where stage in ${OPEN_STAGES})::int as open,
               count(*) filter (where stage in ${OPEN_STAGES} and urgency = 'expedited')::int as expedited,
               count(*) filter (where stage = 'approval')::int as at_board,
               count(*) filter (where stage = 'draft')::int as drafts
          from public.change_requests where organisation_id = ${org}::uuid`);
      const signoffs = await one(sql`select count(*)::int as n from (${WAITING_SIGNOFFS(org)}) w`);
      const tasks = await one(sql`
        select count(*) filter (where t.status = 'open')::int as open
          from public.change_tasks t join public.change_requests c on c.id = t.change_id and c.organisation_id = t.organisation_id and c.stage in ${WORKING_STAGES}
         where t.organisation_id = ${org}::uuid`);
      const late = await one(sql`select count(*)::int as n from (${LATE_TASKS(org)}) l`);
      const cut = await one(sql`select count(*)::int as n from (${PAST_CUT_IN(org)}) p`);
      const customer = await one(sql`select count(*)::int as n from (${CUSTOMER_WAITING(org)}) w`);
      const period = await one(sql`
        select count(*) filter (where submitted_at::date between ${q.from}::date and ${q.to}::date)::int as submitted,
               count(*) filter (where approved_at::date between ${q.from}::date and ${q.to}::date)::int as approved,
               count(*) filter (where closed_at::date between ${q.from}::date and ${q.to}::date)::int as closed,
               avg(extract(epoch from (approved_at - submitted_at)) / 86400) filter (where approved_at::date between ${q.from}::date and ${q.to}::date and submitted_at is not null) as days_to_approve,
               avg(extract(epoch from (closed_at - submitted_at)) / 86400) filter (where closed_at::date between ${q.from}::date and ${q.to}::date and submitted_at is not null) as days_to_close
          from public.change_requests where organisation_id = ${org}::uuid`);
      const notEffective = await one(sql`
        select count(distinct r.change_id)::int as n from public.change_reviews r
         where r.organisation_id = ${org}::uuid and r.result = 'not_effective' and r.reviewed_at::date between ${q.from}::date and ${q.to}::date`);

      const byStage = await many(sql`
        select stage, count(*)::int as n from public.change_requests where organisation_id = ${org}::uuid and stage in ${OPEN_STAGES} group by stage`);
      const byType = await many(sql`
        select t.label as type, count(*)::int as n
          from public.change_requests c join public.change_types t on t.id = c.type_id and t.organisation_id = c.organisation_id
         where c.organisation_id = ${org}::uuid and c.stage in ${OPEN_STAGES} group by t.label order by n desc, lower(t.label)`);
      const trend = await many(sql`
        select to_char(date_trunc(${bucket}, d.day), 'YYYY-MM-DD') as start, sum(d.submitted)::int as submitted, sum(d.closed)::int as closed
          from (select submitted_at::date as day, 1 as submitted, 0 as closed from public.change_requests where organisation_id = ${org}::uuid and submitted_at::date between ${q.from}::date and ${q.to}::date
                union all
                select closed_at::date, 0, 1 from public.change_requests where organisation_id = ${org}::uuid and closed_at::date between ${q.from}::date and ${q.to}::date) d
         group by 1 order by 1`);

      const waiting = await many(sql`
        select c.id as change_id, c.reference, c.title, ${sql.raw(personName('p'))} as signer, f.label as function, (current_date - w.created_at::date)::int as days
          from (${WAITING_SIGNOFFS(org)}) w
          join public.change_requests c on c.id = w.change_id
          join public.change_functions f on f.id = w.function_id
          left join public.profiles p on p.id = w.signer_user_id
         order by w.created_at, c.reference limit 10`);
      const overdue = await many(sql`
        select l.id as task_id, c.id as change_id, c.reference, l.description, ${sql.raw(personName('p'))} as owner, l.due_on::text as due_on, (current_date - l.due_on)::int as days_late
          from (${LATE_TASKS(org)}) l
          join public.change_requests c on c.id = l.change_id
          left join public.profiles p on p.id = l.owner_user_id
         order by l.due_on, c.reference limit 10`);
      const past = await many(sql`
        select c.id as change_id, c.reference, c.title, c.stage, p.cut_in_date::text as cut_in_on, (current_date - p.cut_in_date)::int as days_ago
          from (${PAST_CUT_IN(org)}) p join public.change_requests c on c.id = p.id
         order by p.cut_in_date, c.reference limit 10`);
      const closed = await many(sql`
        select c.id as change_id, c.reference, c.title, c.closed_at::date::text as closed_on,
               (select r.result from public.change_reviews r where r.change_id = c.id order by r.created_at desc, (r.result = 'effective') desc limit 1) as result
          from public.change_requests c where c.organisation_id = ${org}::uuid and c.stage = 'closed' order by c.closed_at desc, c.reference desc limit 8`);

      const stageCount = new Map(byStage.map((r) => [r.stage as string, n(r.n)]));
      return {
        period: { from: q.from, to: q.to, bucket },
        kpis: {
          open: n(state.open),
          expedited: n(state.expedited),
          atBoard: n(state.at_board),
          signoffsWaiting: n(signoffs.n),
          tasksOverdue: n(late.n),
          tasksOpen: n(tasks.open),
          pastCutIn: n(cut.n),
          customerWaiting: n(customer.n),
          drafts: n(state.drafts),
          submitted: n(period.submitted),
          approved: n(period.approved),
          closed: n(period.closed),
          notEffective: n(notEffective.n),
          daysToApprove: dec(period.days_to_approve),
          daysToClose: dec(period.days_to_close),
        },
        byStage: ['assessment', 'approval', 'approved', 'implementing', 'verifying'].map((stage) => ({ stage, count: stageCount.get(stage) ?? 0 })),
        byType: byType.map((r) => ({ type: r.type as string, count: n(r.n) })),
        trend: trend.map((r) => ({ start: r.start as string, submitted: n(r.submitted), closed: n(r.closed) })),
        waitingSignoffs: waiting.map((r) => ({
          changeId: r.change_id as string, reference: r.reference as string, title: r.title as string, signer: (r.signer as string) || 'Unnamed', function: r.function as string, days: n(r.days),
        })),
        overdueTasks: overdue.map((r) => ({
          taskId: r.task_id as string, changeId: r.change_id as string, reference: r.reference as string, description: r.description as string, owner: (r.owner as string) || 'Unnamed',
          dueOn: day(r.due_on) as string, daysLate: n(r.days_late),
        })),
        pastCutInList: past.map((r) => ({
          changeId: r.change_id as string, reference: r.reference as string, title: r.title as string, stage: r.stage as string, cutInOn: day(r.cut_in_on) as string, daysAgo: n(r.days_ago),
        })),
        recentlyClosed: closed.map((r) => ({
          changeId: r.change_id as string, reference: r.reference as string, title: r.title as string, closedOn: day(r.closed_on) as string, result: (r.result as string) ?? null,
        })),
      };
    });
  }
}

/** Changes dashboard: what is open and where, sign-offs and tasks waiting, changes past their cut-in date, and what was submitted, approved, closed and found not effective in the period. Read as the caller (change.read). */
@ApiTags('change')
@ApiBearerAuth()
@Controller('changes-dashboard')
export class ChangeDashboardController {
  constructor(private readonly service: ChangeDashboardService) {}

  @Get()
  @OrganisationScoped('change.read')
  @ApiQuery({ name: 'from', required: true, description: 'From (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: true, description: 'To (YYYY-MM-DD)' })
  @ApiOkResponse({ description: 'Figures as of today (open changes, sign-offs and tasks waiting, past cut-in) and the period (submitted, approved, closed, not effective)', schema: openApiSchema(ChangeDashboard) })
  get(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.get(ctx, parse(ChangeDashboardQuery, query));
  }
}
