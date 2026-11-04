import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { DatabaseService } from '../database/database.service';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { NcrSource } from './ncr.schemas';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const DashboardQuery = z
  .object({ source: NcrSource.optional(), from: isoDate, to: isoDate })
  .refine((q) => q.from <= q.to, { message: '"from" must be on or before "to"', path: ['from'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 3 * 366, { message: 'At most three years', path: ['from'] });

const Count = z.object({ key: z.string(), label: z.string(), count: z.number() });
export const Dashboard = z.object({
  period: z.object({ from: isoDate, to: isoDate, previousFrom: isoDate, previousTo: isoDate, bucket: z.enum(['week', 'month']) }),
  baseCurrency: z.string(),
  kpis: z.object({
    raised: z.number(),
    raisedPrevious: z.number(),
    open: z.number(),
    criticalOpen: z.number(),
    closed: z.number(),
    avgDaysToClose: z.number().nullable(),
    cost: z.number(),
    costPrevious: z.number(),
    quantity: z.number(),
  }),
  trend: z.array(z.object({ start: isoDate, internal: z.number(), customer: z.number(), supplier: z.number(), cost: z.number() })),
  byFailureMode: z.array(Count),
  byStage: z.array(Count),
  bySeverity: z.array(Count),
  topParts: z.array(z.object({ id: z.string(), partNumber: z.string(), name: z.string(), count: z.number(), cost: z.number() })),
});
export type Dashboard = z.infer<typeof Dashboard>;

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);
const day = (d: Date) => d.toISOString().slice(0, 10);

const OPEN_STAGES = ['draft', 'open', 'contained', 'investigating', 'dispositioned', 'awaiting_closure'];
const STAGE_LABEL: Record<string, string> = {
  draft: 'Draft', open: 'Open', contained: 'Contained', investigating: 'Investigating', dispositioned: 'Dispositioned', awaiting_closure: 'Awaiting closure',
};

/**
 * Figures for the NC dashboard, for one period and optionally one source. Deleted NCRs are left
 * out; RLS limits everything to the sites the caller may read.
 */
@Injectable()
export class NcrDashboardService {
  constructor(private readonly database: DatabaseService) {}

  get(ctx: RequestContext, q: z.infer<typeof DashboardQuery>): Promise<Dashboard> {
    const from = new Date(`${q.from}T00:00:00Z`);
    const to = new Date(`${q.to}T00:00:00Z`);
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    const previousTo = new Date(from.getTime() - 86_400_000);
    const previousFrom = new Date(previousTo.getTime() - (days - 1) * 86_400_000);
    const bucket = days > 92 ? 'month' : 'week';
    const org = ctx.organisationId!;
    const src = q.source ? sql`and n.source = ${q.source}` : sql``;
    // NCRs (not deleted) of this organisation and source, with failure mode, part and live cost total.
    const base = sql`
      from public.nonconformances n
      left join public.ncr_classifications fm on fm.id = n.failure_mode_id
      left join public.parts p on p.id = n.part_id
      left join lateral (select sum(k.gross_base) as total from public.ncr_costs k where k.nonconformance_id = n.id and k.deleted_at is null) tc on true
      where n.organisation_id = ${org}::uuid and n.deleted_at is null ${src}`;
    const inPeriod = (a: string, b: string) => sql`and n.detected_at between ${a}::date and ${b}::date`;

    return this.database.asUser(ctx, async (db) => {
      const one = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows;

      const [k] = await one(sql`
        select
          count(*) filter (where n.detected_at between ${q.from}::date and ${q.to}::date) as raised,
          count(*) filter (where n.detected_at between ${day(previousFrom)}::date and ${day(previousTo)}::date) as raised_previous,
          count(*) filter (where n.stage <> all(array['closed','cancelled'])) as open,
          count(*) filter (where n.stage <> all(array['closed','cancelled']) and n.severity = 'critical') as critical_open,
          count(*) filter (where n.closed_at::date between ${q.from}::date and ${q.to}::date) as closed,
          avg(n.closed_at::date - n.detected_at) filter (where n.closed_at::date between ${q.from}::date and ${q.to}::date) as avg_days,
          coalesce(sum(tc.total) filter (where n.detected_at between ${q.from}::date and ${q.to}::date), 0) as cost,
          coalesce(sum(tc.total) filter (where n.detected_at between ${day(previousFrom)}::date and ${day(previousTo)}::date), 0) as cost_previous,
          coalesce(sum(n.quantity_affected) filter (where n.detected_at between ${q.from}::date and ${q.to}::date), 0) as quantity
        ${base}`);

      const trend = await one(sql`
        with buckets as (
          select generate_series(date_trunc(${bucket}, ${q.from}::date), date_trunc(${bucket}, ${q.to}::date), ${`1 ${bucket}`}::interval)::date as start
        ), rows as (
          select date_trunc(${bucket}, n.detected_at)::date as start, n.source, coalesce(tc.total, 0) as cost
          ${base} ${inPeriod(q.from, q.to)}
        )
        select to_char(b.start, 'YYYY-MM-DD') as start,
               count(r.*) filter (where r.source = 'internal') as internal,
               count(r.*) filter (where r.source = 'customer') as customer,
               count(r.*) filter (where r.source = 'supplier') as supplier,
               coalesce(sum(r.cost), 0) as cost
        from buckets b left join rows r on r.start = b.start
        group by b.start order by b.start`);

      const failureModes = await one(sql`
        select coalesce(fm.id::text, 'none') as key, coalesce(fm.name, 'Not classified') as label, count(*) as count
        ${base} ${inPeriod(q.from, q.to)}
        group by 1, 2 order by 3 desc, 2`);

      const stages = await one(sql`
        select n.stage as key, count(*) as count ${base} and n.stage <> all(array['closed','cancelled']) group by 1`);

      const severities = await one(sql`
        select coalesce(n.severity, 'unset') as key, count(*) as count ${base} ${inPeriod(q.from, q.to)} group by 1`);

      const parts = await one(sql`
        select p.id, p.part_number, p.name, count(*) as count, coalesce(sum(tc.total), 0) as cost
        ${base} ${inPeriod(q.from, q.to)} and n.part_id is not null
        group by p.id, p.part_number, p.name order by 4 desc, 5 desc limit 5`);

      const [settings] = await one(sql`select base_currency from public.organisation_settings where organisation_id = ${org}::uuid`);

      // Top eight failure modes; the rest are folded into "Other".
      const fm = failureModes.map((r) => ({ key: String(r.key), label: String(r.label), count: n(r.count) }));
      const byFailureMode = fm.length > 8 ? [...fm.slice(0, 7), { key: 'other', label: 'Other', count: fm.slice(7).reduce((t, r) => t + r.count, 0) }] : fm;
      const stageCount = Object.fromEntries(stages.map((r) => [String(r.key), n(r.count)]));
      const sevCount = Object.fromEntries(severities.map((r) => [String(r.key), n(r.count)]));

      return {
        period: { from: q.from, to: q.to, previousFrom: day(previousFrom), previousTo: day(previousTo), bucket },
        baseCurrency: (settings?.base_currency as string) ?? 'GBP',
        kpis: {
          raised: n(k.raised),
          raisedPrevious: n(k.raised_previous),
          open: n(k.open),
          criticalOpen: n(k.critical_open),
          closed: n(k.closed),
          avgDaysToClose: k.avg_days === null || k.avg_days === undefined ? null : Math.round(Number(k.avg_days) * 10) / 10,
          cost: Math.round(n(k.cost) * 100) / 100,
          costPrevious: Math.round(n(k.cost_previous) * 100) / 100,
          quantity: n(k.quantity),
        },
        trend: trend.map((r) => ({ start: String(r.start), internal: n(r.internal), customer: n(r.customer), supplier: n(r.supplier), cost: Math.round(n(r.cost) * 100) / 100 })),
        byFailureMode,
        byStage: OPEN_STAGES.map((s) => ({ key: s, label: STAGE_LABEL[s], count: stageCount[s] ?? 0 })),
        bySeverity: [
          { key: 'critical', label: 'Critical', count: sevCount.critical ?? 0 },
          { key: 'major', label: 'Major', count: sevCount.major ?? 0 },
          { key: 'minor', label: 'Minor', count: sevCount.minor ?? 0 },
          { key: 'unset', label: 'Not set', count: sevCount.unset ?? 0 },
        ],
        topParts: parts.map((r) => ({ id: String(r.id), partNumber: String(r.part_number), name: String(r.name), count: n(r.count), cost: Math.round(n(r.cost) * 100) / 100 })),
      };
    });
  }
}

@ApiTags('ncrs')
@ApiBearerAuth()
@Controller('ncr-dashboard')
export class NcrDashboardController {
  constructor(private readonly service: NcrDashboardService) {}

  /** KPIs and chart series for the NC dashboard (period from–to, optional source). */
  @Get()
  @OrganisationScoped('ncr.read', { anyScope: true })
  @ApiQuery({ name: 'source', required: false, enum: ['internal', 'customer', 'supplier'] })
  @ApiQuery({ name: 'from', required: true, description: 'Detected on or after (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: true, description: 'Detected on or before (YYYY-MM-DD)' })
  @ApiOkResponse({ schema: openApiSchema(Dashboard) })
  get(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.get(ctx, parse(DashboardQuery, query));
  }
}
