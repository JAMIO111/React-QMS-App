import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { personName, Row } from '../calibration/calibration.service';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { DatabaseService, Db } from '../database/database.service';
import { OrganisationScoped } from '../tenancy/organisation.guard';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const n = (v: unknown) => Number(v ?? 0);
const Id = z.string().uuid();

/** A live risk: not closed and not retired. */
const LIVE = sql.raw(`r.status not in ('closed', 'retired')`);

/**
 * Every risk with its current assessments: `i_*` before treatment, `x_*` after, `e_*` the one in force (after when there is one, else before).
 * Read under the caller's RLS (risk.read).
 */
const WITH_BANDS = (org: string) => sql`
  select r.*, c.label as category_label, ${sql.raw(personName('po'))} as owner_name,
         a.likelihood as i_l, a.consequence as i_c, a.score as i_score, a.band as i_band,
         b.likelihood as x_l, b.consequence as x_c, b.score as x_score, b.band as x_band,
         coalesce(b.likelihood, a.likelihood) as e_l, coalesce(b.consequence, a.consequence) as e_c,
         coalesce(b.score, a.score) as e_score, coalesce(b.band, a.band) as e_band
    from public.risks r
    join public.risk_categories c on c.id = r.category_id
    left join public.profiles po on po.id = r.owner_user_id
    left join public.risk_assessments a on a.risk_id = r.id and a.phase = 'inherent' and a.status = 'current'
    left join public.risk_assessments b on b.risk_id = r.id and b.phase = 'residual' and b.status = 'current'
   where r.organisation_id = ${org}::uuid`;

// ---- heat map -------------------------------------------------------------------------------------

export const HeatmapQuery = z.object({
  /** Which assessment places a risk: before treatment, after treatment (only risks assessed after), or the one in force (default). */
  phase: z.enum(['inherent', 'residual', 'effective']).default('effective'),
  kind: z.enum(['risk', 'opportunity']).optional(),
  categoryId: Id.optional(),
  owner: z.enum(['me']).optional(),
});
const MapRisk = z.object({ id: Id, reference: z.string(), title: z.string(), kind: z.string(), status: z.string(), owner: z.string().nullable(), score: z.number() });
export const Heatmap = z.object({
  phase: z.enum(['inherent', 'residual', 'effective']),
  /** Live risks placed on the map, and those that cannot be (not yet assessed, or not assessed after treatment for `residual`). */
  placed: z.number(),
  notPlaced: z.number(),
  cells: z.array(z.object({ likelihood: z.number(), consequence: z.number(), count: z.number(), risks: z.array(MapRisk) })),
});

// ---- dashboard ------------------------------------------------------------------------------------

export const RiskDashboardQuery = z
  .object({ from: isoDate, to: isoDate })
  .refine((q) => q.from <= q.to, { message: '"from" must be on or before "to"', path: ['from'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 3 * 366, { message: 'At most three years', path: ['from'] });

const ListRisk = z.object({
  id: Id, reference: z.string(), title: z.string(), kind: z.string(), status: z.string(), band: z.string().nullable(), score: z.number().nullable(),
  owner: z.string().nullable(), nextReviewOn: isoDate.nullable(), days: z.number().nullable(),
});
export const RiskDashboard = z.object({
  period: z.object({ from: isoDate, to: isoDate, bucket: z.enum(['week', 'month']) }),
  kpis: z.object({
    /** Live risks and live opportunities (not closed, not retired). */
    risks: z.number(),
    opportunities: z.number(),
    /** Live risks not yet assessed (drafts). */
    unassessed: z.number(),
    /** Live risks whose band in force is high or critical. */
    highOrCritical: z.number(),
    /** Of those, with no treatment chosen. */
    untreatedHigh: z.number(),
    /** Live risks whose review date has passed. */
    reviewsOverdue: z.number(),
    /** Open actions, and those past their due date. */
    openActions: z.number(),
    overdueActions: z.number(),
    /** Acceptances proposed and waiting for an approver. */
    acceptancesWaiting: z.number(),
    /** In the period: risks and opportunities raised, raised from a non-conformance / 8D / audit finding, closed, and assessments recorded. */
    raised: z.number(),
    raisedFromRecords: z.number(),
    closed: z.number(),
    assessments: z.number(),
  }),
  byBand: z.array(z.object({ band: z.string(), count: z.number() })),
  byStatus: z.array(z.object({ status: z.string(), count: z.number() })),
  byCategory: z.array(z.object({ categoryId: Id, label: z.string(), count: z.number(), highOrCritical: z.number() })),
  byStrategy: z.array(z.object({ strategy: z.string().nullable(), count: z.number() })),
  trend: z.array(z.object({ start: isoDate, raised: z.number(), closed: z.number() })),
  topRisks: z.array(ListRisk),
  overdueReviews: z.array(ListRisk),
  overdueActions: z.array(z.object({ id: Id, riskId: Id, reference: z.string(), title: z.string(), description: z.string(), owner: z.string().nullable(), dueDate: isoDate, days: z.number() })),
  waitingAcceptances: z.array(z.object({ id: Id, riskId: Id, reference: z.string(), title: z.string(), band: z.string(), proposedBy: z.string().nullable(), proposedAt: z.string() })),
  raisedFromRecords: z.array(z.object({ id: Id, reference: z.string(), title: z.string(), originKind: z.string(), band: z.string().nullable(), createdAt: z.string() })),
});
export type RiskDashboard = z.infer<typeof RiskDashboard>;

// ---- my work --------------------------------------------------------------------------------------

export const MyRiskWork = z.object({
  /** My live risks whose review is overdue or due within 30 days, soonest first. */
  reviews: z.array(ListRisk),
  /** Open actions given to me. */
  actions: z.array(z.object({ id: Id, riskId: Id, reference: z.string(), title: z.string(), description: z.string(), dueDate: isoDate.nullable(), overdue: z.boolean() })),
  /** Acceptances waiting for a decision that I may make (risk.approve, and not proposed by me). */
  acceptances: z.array(z.object({ id: Id, riskId: Id, reference: z.string(), title: z.string(), band: z.string(), rationale: z.string(), proposedBy: z.string().nullable(), proposedAt: z.string() })),
});
export const MyRiskCount = z.object({ overdueReviews: z.number(), openActions: z.number(), overdueActions: z.number(), acceptances: z.number(), total: z.number() });

const listRisk = (r: Row) => ({
  id: r.id as string,
  reference: r.reference as string,
  title: r.title as string,
  kind: r.kind as string,
  status: r.status as string,
  band: (r.e_band as string) ?? null,
  score: r.e_score == null ? null : n(r.e_score),
  owner: (r.owner_name as string) ?? null,
  nextReviewOn: (r.next_review as string) ?? null,
  days: r.days == null ? null : n(r.days),
});

const BAND_ORDER = ['critical', 'high', 'medium', 'low'];

/** Risk heat map, dashboard and "my work" (RK4). All read as the caller under RLS (risk.read); nothing is written. */
@Injectable()
export class RiskDashboardService {
  constructor(private readonly database: DatabaseService) {}

  heatmap(ctx: RequestContext, q: z.infer<typeof HeatmapQuery>): Promise<z.infer<typeof Heatmap>> {
    const org = ctx.organisationId!;
    const p = q.phase === 'inherent' ? 'i' : q.phase === 'residual' ? 'x' : 'e';
    return this.database.asUser(ctx, async (db) => {
      const rows = (
        await db.execute<Row>(sql`
          select r.id, r.reference, r.title, r.kind, r.status, r.owner_name, r.${sql.raw(`${p}_l`)} as l, r.${sql.raw(`${p}_c`)} as c, r.${sql.raw(`${p}_score`)} as score
            from (${WITH_BANDS(org)}) r
           where ${LIVE} ${q.kind ? sql`and r.kind = ${q.kind}` : sql``} ${q.categoryId ? sql`and r.category_id = ${q.categoryId}::uuid` : sql``}
                 ${q.owner === 'me' ? sql`and r.owner_user_id = auth.uid()` : sql``}
           order by r.${sql.raw(`${p}_score`)} desc nulls last, r.reference`)
      ).rows;
      const cells = new Map<string, z.infer<typeof Heatmap>['cells'][number]>();
      let notPlaced = 0;
      for (const r of rows) {
        if (r.l == null) {
          notPlaced++;
          continue;
        }
        const key = `${r.l}:${r.c}`;
        const cell = cells.get(key) ?? { likelihood: n(r.l), consequence: n(r.c), count: 0, risks: [] };
        cell.count++;
        if (cell.risks.length < 50) {
          cell.risks.push({ id: r.id as string, reference: r.reference as string, title: r.title as string, kind: r.kind as string, status: r.status as string, owner: (r.owner_name as string) ?? null, score: n(r.score) });
        }
        cells.set(key, cell);
      }
      return { phase: q.phase, placed: rows.length - notPlaced, notPlaced, cells: [...cells.values()] };
    });
  }

  dashboard(ctx: RequestContext, q: z.infer<typeof RiskDashboardQuery>): Promise<RiskDashboard> {
    const org = ctx.organisationId!;
    const bucket: 'week' | 'month' = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 92 ? 'week' : 'month';
    return this.database.asUser(ctx, async (db) => {
      const one = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows[0] ?? {};
      const many = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows;
      const B = WITH_BANDS(org);

      const k = await one(sql`
        select count(*) filter (where ${LIVE} and r.kind = 'risk')::int as risks,
               count(*) filter (where ${LIVE} and r.kind = 'opportunity')::int as opportunities,
               count(*) filter (where ${LIVE} and r.e_band is null)::int as unassessed,
               count(*) filter (where ${LIVE} and r.kind = 'risk' and r.e_band in ('high', 'critical'))::int as high,
               count(*) filter (where ${LIVE} and r.kind = 'risk' and r.e_band in ('high', 'critical') and r.strategy is null)::int as untreated,
               count(*) filter (where ${LIVE} and r.next_review_on < current_date)::int as reviews_overdue,
               count(*) filter (where r.created_at::date between ${q.from}::date and ${q.to}::date)::int as raised,
               count(*) filter (where r.origin_kind is not null and r.created_at::date between ${q.from}::date and ${q.to}::date)::int as raised_from,
               count(*) filter (where r.status = 'closed' and r.closed_at::date between ${q.from}::date and ${q.to}::date)::int as closed
          from (${B}) r`);
      const acts = await one(sql`
        select count(*) filter (where a.status = 'open')::int as open, count(*) filter (where a.status = 'open' and a.due_date < current_date)::int as overdue
          from public.risk_actions a where a.organisation_id = ${org}::uuid`);
      const acc = await one(sql`select count(*)::int as n from public.risk_acceptances a where a.organisation_id = ${org}::uuid and a.status = 'proposed'`);
      const assessed = await one(sql`
        select count(*)::int as n from public.risk_assessments a where a.organisation_id = ${org}::uuid and a.assessed_on between ${q.from}::date and ${q.to}::date`);

      const byBand = await many(sql`select coalesce(r.e_band, 'unassessed') as band, count(*)::int as n from (${B}) r where ${LIVE} group by 1`);
      const byStatus = await many(sql`select r.status, count(*)::int as n from (${B}) r where r.status <> 'retired' group by 1`);
      const byCategory = await many(sql`
        select r.category_id, r.category_label, count(*)::int as n, count(*) filter (where r.e_band in ('high', 'critical'))::int as high
          from (${B}) r where ${LIVE} group by 1, 2 order by n desc, lower(r.category_label) limit 10`);
      const byStrategy = await many(sql`select r.strategy, count(*)::int as n from (${B}) r where ${LIVE} and r.e_band is not null group by 1 order by n desc`);
      const trend = await many(sql`
        select to_char(s, 'YYYY-MM-DD') as start,
               (select count(*)::int from public.risks r where r.organisation_id = ${org}::uuid and r.created_at::date between greatest(s::date, ${q.from}::date)
                                                         and least((s + ${sql.raw(`interval '1 ${bucket}'`)})::date - 1, ${q.to}::date)) as raised,
               (select count(*)::int from public.risks r where r.organisation_id = ${org}::uuid and r.status = 'closed' and r.closed_at::date between greatest(s::date, ${q.from}::date)
                                                         and least((s + ${sql.raw(`interval '1 ${bucket}'`)})::date - 1, ${q.to}::date)) as closed
          from generate_series(date_trunc(${bucket}, ${q.from}::date), ${q.to}::date, ${sql.raw(`interval '1 ${bucket}'`)}) s`);
      const top = await many(sql`
        select r.*, r.next_review_on::text as next_review, (r.next_review_on - current_date)::int as days
          from (${B}) r where ${LIVE} and r.kind = 'risk' and r.e_score is not null order by r.e_score desc, r.reference limit 10`);
      const overdue = await many(sql`
        select r.*, r.next_review_on::text as next_review, (current_date - r.next_review_on)::int as days
          from (${B}) r where ${LIVE} and r.next_review_on < current_date order by r.next_review_on, r.reference limit 10`);
      const overdueActions = await many(sql`
        select a.id, a.risk_id, r.reference, r.title, a.description, a.due_date::text as due, (current_date - a.due_date)::int as days, ${sql.raw(personName('p'))} as owner_name
          from public.risk_actions a join public.risks r on r.id = a.risk_id left join public.profiles p on p.id = a.owner_user_id
         where a.organisation_id = ${org}::uuid and a.status = 'open' and a.due_date < current_date order by a.due_date, r.reference limit 10`);
      const waiting = await many(sql`
        select a.id, a.risk_id, r.reference, r.title, s.band, a.created_at, ${sql.raw(personName('p'))} as proposer
          from public.risk_acceptances a join public.risks r on r.id = a.risk_id join public.risk_assessments s on s.id = a.assessment_id
          left join public.profiles p on p.id = a.proposed_by
         where a.organisation_id = ${org}::uuid and a.status = 'proposed' order by a.created_at limit 10`);
      const fromRecords = await many(sql`
        select r.id, r.reference, r.title, r.origin_kind, r.e_band, r.created_at from (${B}) r
         where r.origin_kind is not null and r.status <> 'retired' order by r.created_at desc limit 8`);

      const bands = new Map(byBand.map((r) => [r.band as string, n(r.n)]));
      return {
        period: { from: q.from, to: q.to, bucket },
        kpis: {
          risks: n(k.risks),
          opportunities: n(k.opportunities),
          unassessed: n(k.unassessed),
          highOrCritical: n(k.high),
          untreatedHigh: n(k.untreated),
          reviewsOverdue: n(k.reviews_overdue),
          openActions: n(acts.open),
          overdueActions: n(acts.overdue),
          acceptancesWaiting: n(acc.n),
          raised: n(k.raised),
          raisedFromRecords: n(k.raised_from),
          closed: n(k.closed),
          assessments: n(assessed.n),
        },
        byBand: [...BAND_ORDER, 'unassessed'].map((band) => ({ band, count: bands.get(band) ?? 0 })),
        byStatus: byStatus.map((r) => ({ status: r.status as string, count: n(r.n) })),
        byCategory: byCategory.map((r) => ({ categoryId: r.category_id as string, label: r.category_label as string, count: n(r.n), highOrCritical: n(r.high) })),
        byStrategy: byStrategy.map((r) => ({ strategy: (r.strategy as string) ?? null, count: n(r.n) })),
        trend: trend.map((r) => ({ start: r.start as string, raised: n(r.raised), closed: n(r.closed) })),
        topRisks: top.map(listRisk),
        overdueReviews: overdue.map(listRisk),
        overdueActions: overdueActions.map((r) => ({
          id: r.id as string, riskId: r.risk_id as string, reference: r.reference as string, title: r.title as string, description: r.description as string,
          owner: (r.owner_name as string) ?? null, dueDate: r.due as string, days: n(r.days),
        })),
        waitingAcceptances: waiting.map((r) => ({
          id: r.id as string, riskId: r.risk_id as string, reference: r.reference as string, title: r.title as string, band: r.band as string,
          proposedBy: (r.proposer as string) ?? null, proposedAt: new Date(r.created_at as string).toISOString(),
        })),
        raisedFromRecords: fromRecords.map((r) => ({
          id: r.id as string, reference: r.reference as string, title: r.title as string, originKind: r.origin_kind as string, band: (r.e_band as string) ?? null,
          createdAt: new Date(r.created_at as string).toISOString(),
        })),
      };
    });
  }

  private async mineIn(db: Db, org: string) {
    const reviews = (
      await db.execute<Row>(sql`
        select r.*, r.next_review_on::text as next_review, (r.next_review_on - current_date)::int as days
          from (${WITH_BANDS(org)}) r
         where ${LIVE} and r.owner_user_id = auth.uid() and r.next_review_on <= current_date + 30 order by r.next_review_on, r.reference limit 100`)
    ).rows;
    const actions = (
      await db.execute<Row>(sql`
        select a.id, a.risk_id, r.reference, r.title, a.description, a.due_date::text as due, coalesce(a.due_date < current_date, false) as overdue
          from public.risk_actions a join public.risks r on r.id = a.risk_id
         where a.organisation_id = ${org}::uuid and a.status = 'open' and a.owner_user_id = auth.uid() order by a.due_date nulls last, r.reference limit 100`)
    ).rows;
    const acceptances = (
      await db.execute<Row>(sql`
        select a.id, a.risk_id, r.reference, r.title, s.band, a.rationale, a.created_at, ${sql.raw(personName('p'))} as proposer
          from public.risk_acceptances a join public.risks r on r.id = a.risk_id join public.risk_assessments s on s.id = a.assessment_id
          left join public.profiles p on p.id = a.proposed_by
         where a.organisation_id = ${org}::uuid and a.status = 'proposed' and a.proposed_by <> auth.uid() and app.has_permission(${org}::uuid, 'risk.approve')
         order by a.created_at limit 100`)
    ).rows;
    return { reviews, actions, acceptances };
  }

  mine(ctx: RequestContext): Promise<z.infer<typeof MyRiskWork>> {
    return this.database.asUser(ctx, async (db) => {
      const m = await this.mineIn(db, ctx.organisationId!);
      return {
        reviews: m.reviews.map(listRisk),
        actions: m.actions.map((r) => ({
          id: r.id as string, riskId: r.risk_id as string, reference: r.reference as string, title: r.title as string, description: r.description as string,
          dueDate: (r.due as string) ?? null, overdue: Boolean(r.overdue),
        })),
        acceptances: m.acceptances.map((r) => ({
          id: r.id as string, riskId: r.risk_id as string, reference: r.reference as string, title: r.title as string, band: r.band as string, rationale: r.rationale as string,
          proposedBy: (r.proposer as string) ?? null, proposedAt: new Date(r.created_at as string).toISOString(),
        })),
      };
    });
  }

  /** For the menu badge: what needs me now — my overdue reviews, my open actions and acceptances I may decide. */
  count(ctx: RequestContext): Promise<z.infer<typeof MyRiskCount>> {
    const org = ctx.organisationId!;
    return this.database.asUser(ctx, async (db) => {
      const r = (
        await db.execute<Row>(sql`
          select (select count(*)::int from public.risks r where r.organisation_id = ${org}::uuid and ${LIVE} and r.owner_user_id = auth.uid() and r.next_review_on < current_date) as reviews,
                 (select count(*)::int from public.risk_actions a where a.organisation_id = ${org}::uuid and a.status = 'open' and a.owner_user_id = auth.uid()) as actions,
                 (select count(*)::int from public.risk_actions a where a.organisation_id = ${org}::uuid and a.status = 'open' and a.owner_user_id = auth.uid() and a.due_date < current_date) as late,
                 (select count(*)::int from public.risk_acceptances a where a.organisation_id = ${org}::uuid and a.status = 'proposed' and a.proposed_by <> auth.uid()
                     and app.has_permission(${org}::uuid, 'risk.approve')) as acceptances`)
      ).rows[0];
      const overdueReviews = n(r.reviews);
      const openActions = n(r.actions);
      const acceptances = n(r.acceptances);
      return { overdueReviews, openActions, overdueActions: n(r.late), acceptances, total: overdueReviews + openActions + acceptances };
    });
  }
}

@ApiTags('risk')
@ApiBearerAuth()
@Controller()
export class RiskDashboardController {
  constructor(private readonly service: RiskDashboardService) {}

  @Get('risk-heatmap')
  @OrganisationScoped('risk.read')
  @ApiQuery({ name: 'phase', required: false, schema: { type: 'string', enum: ['inherent', 'residual', 'effective'] } })
  @ApiQuery({ name: 'kind', required: false, schema: { type: 'string', enum: ['risk', 'opportunity'] } })
  @ApiQuery({ name: 'categoryId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'owner', required: false, schema: { type: 'string', enum: ['me'] } })
  @ApiOkResponse({ description: 'Live risks counted per cell of the matrix (before treatment, after it, or as in force), with the risks in each cell', schema: openApiSchema(Heatmap) })
  heatmap(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.heatmap(ctx, parse(HeatmapQuery, query));
  }

  @Get('risks-dashboard')
  @OrganisationScoped('risk.read')
  @ApiQuery({ name: 'from', required: true, schema: { type: 'string', format: 'date' } })
  @ApiQuery({ name: 'to', required: true, schema: { type: 'string', format: 'date' } })
  @ApiOkResponse({ description: 'Figures as of today (bands in force, untreated high risks, overdue reviews and actions, acceptances waiting) and what was raised, assessed and closed in the period', schema: openApiSchema(RiskDashboard) })
  dashboard(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.dashboard(ctx, parse(RiskDashboardQuery, query));
  }

  @Get('risk-work/mine')
  @OrganisationScoped('risk.read')
  @ApiOkResponse({ description: 'My risks due for review within 30 days or overdue, my open risk actions, and acceptances waiting for me to decide', schema: openApiSchema(MyRiskWork) })
  mine(@Ctx() ctx: RequestContext) {
    return this.service.mine(ctx);
  }

  @Get('risk-work/count')
  @OrganisationScoped('risk.read')
  @ApiOkResponse({ description: 'Counts for the menu badge: overdue reviews of my risks, my open actions (and how many are late) and acceptances I may decide', schema: openApiSchema(MyRiskCount) })
  count(@Ctx() ctx: RequestContext) {
    return this.service.count(ctx);
  }
}
