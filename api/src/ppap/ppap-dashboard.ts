import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { DatabaseService } from '../database/database.service';
import { OrganisationScoped } from '../tenancy/organisation.guard';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Id = z.string().uuid();
const n = (v: unknown) => Number(v ?? 0);
type Row = Record<string, unknown>;

/** An interim approval is "ending" this many days before it runs to (the reminders area and the prompts use the same thirty). */
export const PPAP_ENDING_DAYS = 30;

/**
 * The SQL fragments the home page shares with this dashboard, so the two cannot disagree (`home-dashboard.e2e-spec.ts` compares them).
 * All are read under the caller's RLS (`ppap.read`). A submission that something replaced (a resubmission or a revalidation started from it) or that was
 * withdrawn is not "live": the newer one speaks for the part.
 */
const NOT_REPLACED = sql`not exists (select 1 from public.ppap_submissions r where r.replaces_id = s.id and r.organisation_id = s.organisation_id and r.status <> 'withdrawn')`;

/** Submissions still being prepared. */
export const PPAP_IN_PREPARATION = (org: string) => sql`
  select s.* from public.ppap_submissions s where s.organisation_id = ${org}::uuid and s.status in ('draft', 'in_preparation', 'ready')`;
/** Sent (or received) and not yet answered: a package waiting for the customer's answer, or a received one waiting for ours. */
export const PPAP_AWAITING = (org: string) => sql`
  select s.* from public.ppap_submissions s where s.organisation_id = ${org}::uuid and s.status = 'submitted' and ${NOT_REPLACED}`;
/** Approved, in force (nothing replaced it). */
export const PPAP_APPROVED = (org: string) => sql`
  select s.* from public.ppap_submissions s where s.organisation_id = ${org}::uuid and s.status = 'approved' and ${NOT_REPLACED}`;
/** Rejected and not yet answered by a resubmission. */
export const PPAP_REJECTED = (org: string) => sql`
  select s.* from public.ppap_submissions s where s.organisation_id = ${org}::uuid and s.status = 'rejected' and ${NOT_REPLACED}`;
/** Approved for now only, with the day the latest interim approval runs to (`expires_on`, negative days left once it has run out). */
export const PPAP_INTERIM = (org: string) => sql`
  select s.*, d.expires_on from public.ppap_submissions s
    join lateral (select x.expires_on from public.ppap_decisions x where x.submission_id = s.id and x.organisation_id = s.organisation_id and x.kind = 'interim_approved'
                   order by x.seq desc limit 1) d on true
   where s.organisation_id = ${org}::uuid and s.status = 'interim_approved' and ${NOT_REPLACED}`;
/** Approved and past the revalidation date, with nobody having started one. */
export const PPAP_REVIEWS_OVERDUE = (org: string) => sql`
  select s.* from (${PPAP_APPROVED(org)}) s where s.next_review_on < current_date`;

export const PpapDashboardQuery = z
  .object({ from: isoDate, to: isoDate })
  .refine((q) => q.from <= q.to, { message: '"from" must be on or before "to"', path: ['from'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 3 * 366, { message: 'At most three years', path: ['from'] });

const Item = z.object({
  id: Id,
  reference: z.string(),
  direction: z.enum(['submitted', 'received']),
  partNumber: z.string(),
  partName: z.string(),
  party: z.string().nullable(),
  /** Why it is listed. */
  reason: z.enum(['rejected', 'interim_lapsed', 'interim_ending', 'review_overdue', 'awaiting']),
  /** The date that matters for the reason (when it was sent, its answer, the day an interim approval runs to, the revalidation date). */
  on: isoDate.nullable(),
  /** Days waiting, days since the answer, days left (negative once past) or days overdue, by reason. */
  days: z.number().nullable(),
});

export const PpapDashboard = z.object({
  period: z.object({ from: isoDate, to: isoDate, bucket: z.enum(['week', 'month']) }),
  kpis: z.object({
    /** As of today. */
    inPreparation: z.number(),
    awaitingCustomer: z.number(),
    awaitingUs: z.number(),
    approved: z.number(),
    interim: z.number(),
    interimEnding: z.number(),
    interimLapsed: z.number(),
    rejected: z.number(),
    reviewsOverdue: z.number(),
    /** In the period (the customer's or our answers, by the day they were recorded). */
    sent: z.number(),
    approvedInPeriod: z.number(),
    interimInPeriod: z.number(),
    rejectedInPeriod: z.number(),
    /** Average days from sent to answer for the answers recorded in the period; null when there are none. */
    averageDaysToAnswer: z.number().nullable(),
  }),
  byStatus: z.array(z.object({ status: z.string(), count: z.number() })),
  byDirection: z.array(z.object({ direction: z.string(), count: z.number() })),
  trend: z.array(z.object({ start: isoDate, sent: z.number(), approved: z.number(), interim: z.number(), rejected: z.number() })),
  needsAction: z.array(Item),
  awaiting: z.array(Item),
});
export type PpapDashboard = z.infer<typeof PpapDashboard>;

const STATUS_ORDER = ['draft', 'in_preparation', 'ready', 'submitted', 'approved', 'interim_approved', 'rejected'];

/** The PPAP dashboard: figures as of today and what was sent and answered in a period. Read as the caller (ppap.read); nothing is written. */
@Injectable()
export class PpapDashboardService {
  constructor(private readonly database: DatabaseService) {}

  get(ctx: RequestContext, q: z.infer<typeof PpapDashboardQuery>): Promise<PpapDashboard> {
    const org = ctx.organisationId!;
    const bucket: 'week' | 'month' = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 92 ? 'week' : 'month';
    return this.database.asUser(ctx, async (db) => {
      const one = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows[0] ?? {};
      const many = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows;

      const k = await one(sql`
        select (select count(*) from (${PPAP_IN_PREPARATION(org)}) s)::int as in_preparation,
               (select count(*) from (${PPAP_AWAITING(org)}) s where s.direction = 'submitted')::int as awaiting_customer,
               (select count(*) from (${PPAP_AWAITING(org)}) s where s.direction = 'received')::int as awaiting_us,
               (select count(*) from (${PPAP_APPROVED(org)}) s)::int as approved,
               (select count(*) from (${PPAP_INTERIM(org)}) s where s.expires_on >= current_date)::int as interim,
               (select count(*) from (${PPAP_INTERIM(org)}) s where s.expires_on >= current_date and s.expires_on <= current_date + ${PPAP_ENDING_DAYS}::int)::int as interim_ending,
               (select count(*) from (${PPAP_INTERIM(org)}) s where s.expires_on < current_date)::int as interim_lapsed,
               (select count(*) from (${PPAP_REJECTED(org)}) s)::int as rejected,
               (select count(*) from (${PPAP_REVIEWS_OVERDUE(org)}) s)::int as reviews_overdue`);
      const p = await one(sql`
        select count(*) filter (where d.kind = 'submitted')::int as sent,
               count(*) filter (where d.kind = 'approved')::int as approved,
               count(*) filter (where d.kind = 'interim_approved')::int as interim,
               count(*) filter (where d.kind = 'rejected')::int as rejected,
               round(avg(d.decided_on - sent.decided_on) filter (where d.kind in ('approved', 'interim_approved', 'rejected'))::numeric, 1) as avg_days
          from public.ppap_decisions d
          left join public.ppap_decisions sent on sent.submission_id = d.submission_id and sent.organisation_id = d.organisation_id and sent.kind = 'submitted' and sent.seq = 1
         where d.organisation_id = ${org}::uuid and d.decided_on between ${q.from}::date and ${q.to}::date`);

      const byStatus = await many(sql`
        select s.status, count(*)::int as n from public.ppap_submissions s
         where s.organisation_id = ${org}::uuid and s.status <> 'withdrawn' and ${NOT_REPLACED} group by 1`);
      const byDirection = await many(sql`
        select s.direction, count(*)::int as n from public.ppap_submissions s
         where s.organisation_id = ${org}::uuid and s.status <> 'withdrawn' and ${NOT_REPLACED} group by 1 order by 1`);
      const trend = await many(sql`
        select to_char(b, 'YYYY-MM-DD') as start,
               count(d.id) filter (where d.kind = 'submitted')::int as sent,
               count(d.id) filter (where d.kind = 'approved')::int as approved,
               count(d.id) filter (where d.kind = 'interim_approved')::int as interim,
               count(d.id) filter (where d.kind = 'rejected')::int as rejected
          from generate_series(date_trunc(${bucket}, ${q.from}::date), ${q.to}::date, ${sql.raw(`interval '1 ${bucket}'`)}) b
          left join public.ppap_decisions d on d.organisation_id = ${org}::uuid
               and d.decided_on between greatest(b::date, ${q.from}::date) and least((b + ${sql.raw(`interval '1 ${bucket}'`)})::date - 1, ${q.to}::date)
         group by b order by b`);

      // One shape for every listed row; `extra` is the date and the days that matter for the reason.
      const listed = (reason: z.infer<typeof Item>['reason'], from: ReturnType<typeof sql>, on: ReturnType<typeof sql>, days: ReturnType<typeof sql>, order: ReturnType<typeof sql>, limit = 10) =>
        many(sql`
          select s.id, s.reference, s.direction, p.part_number, p.name as part_name, coalesce(c.name, su.name) as party, ${reason}::text as reason,
                 (${on})::text as on_date, (${days})::int as days
            from (${from}) s
            join public.parts p on p.id = s.part_id and p.organisation_id = s.organisation_id
            left join public.customers c on c.id = s.customer_id and c.organisation_id = s.organisation_id
            left join public.suppliers su on su.id = s.supplier_id and su.organisation_id = s.organisation_id
           order by ${order} limit ${limit}`);
      const item = (r: Row) => ({
        id: r.id as string,
        reference: r.reference as string,
        direction: r.direction as 'submitted' | 'received',
        partNumber: r.part_number as string,
        partName: r.part_name as string,
        party: (r.party as string) ?? null,
        reason: r.reason as z.infer<typeof Item>['reason'],
        on: (r.on_date as string) ?? null,
        days: r.days == null ? null : n(r.days),
      });
      const lastRejected = sql`(select max(x.decided_on) from public.ppap_decisions x where x.submission_id = s.id and x.organisation_id = s.organisation_id and x.kind = 'rejected')`;
      const rejected = await listed('rejected', PPAP_REJECTED(org), lastRejected, sql`current_date - ${lastRejected}`, sql`${lastRejected} nulls last, s.reference`);
      const lapsed = await listed('interim_lapsed', sql`select * from (${PPAP_INTERIM(org)}) i where i.expires_on < current_date`, sql`s.expires_on`, sql`s.expires_on - current_date`, sql`s.expires_on, s.reference`);
      const ending = await listed(
        'interim_ending',
        sql`select * from (${PPAP_INTERIM(org)}) i where i.expires_on >= current_date and i.expires_on <= current_date + ${PPAP_ENDING_DAYS}::int`,
        sql`s.expires_on`,
        sql`s.expires_on - current_date`,
        sql`s.expires_on, s.reference`,
      );
      const reviews = await listed('review_overdue', PPAP_REVIEWS_OVERDUE(org), sql`s.next_review_on`, sql`current_date - s.next_review_on`, sql`s.next_review_on, s.reference`);
      // How long it has waited is counted from the day it was sent (the day recorded when it was sent), which may be earlier than the day it was entered.
      const sentOn = sql`(select x.decided_on from public.ppap_decisions x where x.submission_id = s.id and x.organisation_id = s.organisation_id and x.kind = 'submitted' order by x.seq limit 1)`;
      const awaiting = await listed('awaiting', PPAP_AWAITING(org), sentOn, sql`current_date - ${sentOn}`, sql`${sentOn} nulls last, s.reference`);

      const status = new Map(byStatus.map((r) => [r.status as string, n(r.n)]));
      return {
        period: { from: q.from, to: q.to, bucket },
        kpis: {
          inPreparation: n(k.in_preparation),
          awaitingCustomer: n(k.awaiting_customer),
          awaitingUs: n(k.awaiting_us),
          approved: n(k.approved),
          interim: n(k.interim),
          interimEnding: n(k.interim_ending),
          interimLapsed: n(k.interim_lapsed),
          rejected: n(k.rejected),
          reviewsOverdue: n(k.reviews_overdue),
          sent: n(p.sent),
          approvedInPeriod: n(p.approved),
          interimInPeriod: n(p.interim),
          rejectedInPeriod: n(p.rejected),
          averageDaysToAnswer: p.avg_days == null ? null : Number(p.avg_days),
        },
        byStatus: STATUS_ORDER.map((s) => ({ status: s, count: status.get(s) ?? 0 })),
        byDirection: byDirection.map((r) => ({ direction: r.direction as string, count: n(r.n) })),
        trend: trend.map((r) => ({ start: r.start as string, sent: n(r.sent), approved: n(r.approved), interim: n(r.interim), rejected: n(r.rejected) })),
        // The most pressing first: a rejection, an interim approval that has run out, one about to, a revalidation overdue.
        needsAction: [...rejected, ...lapsed, ...ending, ...reviews].map(item).slice(0, 12),
        awaiting: awaiting.map(item),
      };
    });
  }
}

@ApiTags('ppap')
@ApiBearerAuth()
@Controller()
export class PpapDashboardController {
  constructor(private readonly service: PpapDashboardService) {}

  @Get('ppap-dashboard')
  @OrganisationScoped('ppap.read')
  @ApiQuery({ name: 'from', required: true, schema: { type: 'string', format: 'date' } })
  @ApiQuery({ name: 'to', required: true, schema: { type: 'string', format: 'date' } })
  @ApiOkResponse({ description: 'Part approvals being prepared, waiting for an answer, approved, on an interim approval, rejected or due for revalidation as of today, and what was sent and answered in the period', schema: openApiSchema(PpapDashboard) })
  get(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.get(ctx, parse(PpapDashboardQuery, query));
  }
}
