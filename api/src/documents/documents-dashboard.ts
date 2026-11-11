import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { Row } from '../calibration/calibration.service';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { DatabaseService } from '../database/database.service';
import { OrganisationScoped } from '../tenancy/organisation.guard';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const n = (v: unknown) => Number(v ?? 0);
const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);

export const DocumentsDashboardQuery = z
  .object({ from: isoDate, to: isoDate })
  .refine((q) => q.from <= q.to, { message: '"from" must be on or before "to"', path: ['from'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 3 * 366, { message: 'At most three years', path: ['from'] });

const Id = z.string().uuid();
const DocRef = { documentId: Id, number: z.string(), title: z.string() };
export const DocumentsDashboard = z.object({
  period: z.object({ from: isoDate, to: isoDate, bucket: z.enum(['week', 'month']) }),
  kpis: z.object({
    /** Documents in force now, and how many of them are external. */
    inForce: z.number(),
    external: z.number(),
    withdrawn: z.number(),
    /** Revisions being written, in review, waiting for approval, and approved waiting for their date. */
    drafts: z.number(),
    inReview: z.number(),
    awaitingApproval: z.number(),
    approvedWaiting: z.number(),
    /** Documents in force past their periodic review date, and due within 30 days. */
    reviewsOverdue: z.number(),
    reviewsDue30: z.number(),
    /** Readers of revisions in force who are past their date and have not acknowledged. */
    readersOverdue: z.number(),
    readersPending: z.number(),
    changeRequestsOpen: z.number(),
    /** In the period: revisions that took effect, acknowledgements made, change requests raised. */
    madeEffective: z.number(),
    acknowledgements: z.number(),
    changeRequestsRaised: z.number(),
  }),
  byType: z.array(z.object({ typeId: Id, name: z.string(), prefix: z.string(), inForce: z.number(), inProgress: z.number() })),
  activity: z.array(z.object({ start: isoDate, effective: z.number(), acknowledgements: z.number() })),
  waiting: z.array(z.object({ ...DocRef, revisionId: Id, letter: z.string().nullable(), status: z.string(), since: isoDate.nullable(), days: z.number() })),
  reviewsDue: z.array(z.object({ ...DocRef, nextReviewOn: isoDate, days: z.number() })),
  readersBehind: z.array(z.object({ ...DocRef, revisionId: Id, letter: z.string().nullable(), overdue: z.number(), total: z.number() })),
  effectiveSoon: z.array(z.object({ ...DocRef, revisionId: Id, letter: z.string().nullable(), effectiveFrom: isoDate })),
});
export type DocumentsDashboard = z.infer<typeof DocumentsDashboard>;

/** Documents dashboard (DC5): as of today and for the period. Read as the caller, so restricted documents count only for those who may read them. */
@Injectable()
export class DocumentsDashboardService {
  constructor(private readonly database: DatabaseService) {}

  get(ctx: RequestContext, q: z.infer<typeof DocumentsDashboardQuery>): Promise<DocumentsDashboard> {
    const org = ctx.organisationId!;
    const bucket: 'week' | 'month' = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 92 ? 'week' : 'month';
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.settle_documents(${org}::uuid)`);
      const one = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows[0] ?? {};
      const many = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows;

      const docs = await one(sql`
        select count(*) filter (where status = 'active')::int as in_force,
               count(*) filter (where status = 'active' and origin = 'external')::int as external,
               count(*) filter (where status = 'withdrawn')::int as withdrawn,
               count(*) filter (where status = 'active' and next_review_on < current_date)::int as reviews_overdue,
               count(*) filter (where status = 'active' and next_review_on >= current_date and next_review_on <= current_date + 30)::int as reviews_due30
          from public.documents where organisation_id = ${org}::uuid`);
      const revs = await one(sql`
        select count(*) filter (where status = 'draft')::int as drafts, count(*) filter (where status = 'in_review')::int as in_review,
               count(*) filter (where status = 'awaiting_approval')::int as awaiting, count(*) filter (where status = 'approved')::int as approved,
               count(*) filter (where status in ('effective', 'superseded', 'withdrawn') and effective_from between ${q.from}::date and ${q.to}::date)::int as made_effective
          from public.document_revisions where organisation_id = ${org}::uuid`);
      const readers = await one(sql`
        select count(*) filter (where x.acknowledged_at is null and x.due_on < current_date)::int as overdue, count(*) filter (where x.acknowledged_at is null)::int as pending,
               (select count(*)::int from public.document_recipients y where y.organisation_id = ${org}::uuid and y.acknowledged_at::date between ${q.from}::date and ${q.to}::date) as acknowledgements
          from public.document_recipients x join public.documents d on d.current_revision_id = x.revision_id and d.status = 'active'
         where x.organisation_id = ${org}::uuid`);
      const crs = await one(sql`
        select count(*) filter (where status = 'open')::int as open, count(*) filter (where created_at::date between ${q.from}::date and ${q.to}::date)::int as raised
          from public.document_change_requests where organisation_id = ${org}::uuid`);

      const byType = await many(sql`
        select t.id, t.name, t.prefix, count(d.id) filter (where d.status = 'active')::int as in_force,
               count(distinct r.document_id)::int as in_progress
          from public.document_types t
          left join public.documents d on d.type_id = t.id
          left join public.document_revisions r on r.document_id = d.id and r.status in ('draft', 'in_review', 'awaiting_approval', 'approved')
         where t.organisation_id = ${org}::uuid
         group by t.id, t.name, t.prefix, t.sequence having count(d.id) > 0 order by t.sequence, lower(t.name)`);
      const effective = await many(sql`
        select to_char(date_trunc(${bucket}, effective_from), 'YYYY-MM-DD') as start, count(*)::int as n
          from public.document_revisions
         where organisation_id = ${org}::uuid and status in ('effective', 'superseded', 'withdrawn') and effective_from between ${q.from}::date and ${q.to}::date group by 1`);
      const acks = await many(sql`
        select to_char(date_trunc(${bucket}, acknowledged_at::date), 'YYYY-MM-DD') as start, count(*)::int as n
          from public.document_recipients
         where organisation_id = ${org}::uuid and acknowledged_at::date between ${q.from}::date and ${q.to}::date group by 1`);
      const waiting = await many(sql`
        select d.id as document_id, d.number, d.title, r.id, r.letter, r.status, r.submitted_at::date::text as since, (current_date - coalesce(r.submitted_at::date, current_date))::int as days
          from public.document_revisions r join public.documents d on d.id = r.document_id
         where r.organisation_id = ${org}::uuid and r.status in ('in_review', 'awaiting_approval')
         order by r.submitted_at nulls last limit 10`);
      const due = await many(sql`
        select id as document_id, number, title, next_review_on::text as next_review_on, (next_review_on - current_date)::int as days
          from public.documents
         where organisation_id = ${org}::uuid and status = 'active' and next_review_on <= current_date + 30
         order by next_review_on, upper(number) limit 10`);
      const behind = await many(sql`
        select d.id as document_id, d.number, d.title, r.id, r.letter,
               count(*) filter (where x.acknowledged_at is null and x.due_on < current_date)::int as overdue, count(*)::int as total
          from public.documents d join public.document_revisions r on r.id = d.current_revision_id join public.document_recipients x on x.revision_id = r.id
         where d.organisation_id = ${org}::uuid and d.status = 'active'
         group by d.id, d.number, d.title, r.id, r.letter having count(*) filter (where x.acknowledged_at is null and x.due_on < current_date) > 0
         order by overdue desc, upper(d.number) limit 10`);
      const soon = await many(sql`
        select d.id as document_id, d.number, d.title, r.id, r.letter, r.effective_from::text as effective_from
          from public.document_revisions r join public.documents d on d.id = r.document_id
         where r.organisation_id = ${org}::uuid and r.status = 'approved' order by r.effective_from, upper(d.number) limit 10`);

      const starts = [...new Set([...effective, ...acks].map((r) => r.start as string))].sort();
      const eff = new Map(effective.map((r) => [r.start as string, n(r.n)]));
      const ack = new Map(acks.map((r) => [r.start as string, n(r.n)]));
      const ref = (r: Row) => ({ documentId: r.document_id as string, number: r.number as string, title: r.title as string });
      return {
        period: { from: q.from, to: q.to, bucket },
        kpis: {
          inForce: n(docs.in_force),
          external: n(docs.external),
          withdrawn: n(docs.withdrawn),
          drafts: n(revs.drafts),
          inReview: n(revs.in_review),
          awaitingApproval: n(revs.awaiting),
          approvedWaiting: n(revs.approved),
          reviewsOverdue: n(docs.reviews_overdue),
          reviewsDue30: n(docs.reviews_due30),
          readersOverdue: n(readers.overdue),
          readersPending: n(readers.pending),
          changeRequestsOpen: n(crs.open),
          madeEffective: n(revs.made_effective),
          acknowledgements: n(readers.acknowledgements),
          changeRequestsRaised: n(crs.raised),
        },
        byType: byType.map((r) => ({ typeId: r.id as string, name: r.name as string, prefix: r.prefix as string, inForce: n(r.in_force), inProgress: n(r.in_progress) })),
        activity: starts.map((start) => ({ start, effective: eff.get(start) ?? 0, acknowledgements: ack.get(start) ?? 0 })),
        waiting: waiting.map((r) => ({ ...ref(r), revisionId: r.id as string, letter: (r.letter as string) ?? null, status: r.status as string, since: day(r.since), days: n(r.days) })),
        reviewsDue: due.map((r) => ({ ...ref(r), nextReviewOn: day(r.next_review_on) as string, days: n(r.days) })),
        readersBehind: behind.map((r) => ({ ...ref(r), revisionId: r.id as string, letter: (r.letter as string) ?? null, overdue: n(r.overdue), total: n(r.total) })),
        effectiveSoon: soon.map((r) => ({ ...ref(r), revisionId: r.id as string, letter: (r.letter as string) ?? null, effectiveFrom: day(r.effective_from) as string })),
      };
    });
  }
}

@ApiTags('documents')
@ApiBearerAuth()
@Controller('documents-dashboard')
export class DocumentsDashboardController {
  constructor(private readonly service: DocumentsDashboardService) {}

  @Get()
  @OrganisationScoped('documentation.read')
  @ApiQuery({ name: 'from', required: true, description: 'From (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: true, description: 'To (YYYY-MM-DD)' })
  @ApiOkResponse({ description: 'Documents in force, revisions in progress, reviews and readers due, and activity in the period', schema: openApiSchema(DocumentsDashboard) })
  get(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.get(ctx, parse(DocumentsDashboardQuery, query));
  }
}
