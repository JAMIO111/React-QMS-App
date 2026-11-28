import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { DatabaseService } from '../database/database.service';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { NCR_SOURCE_LABELS, NCR_SOURCES, sourceList } from './ncr.schemas';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const DashboardQuery = z
  .object({ source: sourceList, from: isoDate, to: isoDate, siteId: z.string().uuid().optional() })
  .refine((q) => q.from <= q.to, { message: '"from" must be on or before "to"', path: ['from'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 3 * 366, { message: 'At most three years', path: ['from'] });

const Count = z.object({ key: z.string(), label: z.string(), count: z.number() });
export const Dashboard = z.object({
  period: z.object({ from: isoDate, to: isoDate, previousFrom: isoDate, previousTo: isoDate, bucket: z.enum(['week', 'month']) }),
  /** The currency every cost figure is in: the site's when one site is shown, the organisation's for all sites. (Same as `currency`; the older name.) */
  baseCurrency: z.string(),
  currency: z.string(),
  /** The site shown (chosen, or the only one the caller may read); null = all sites, in the organisation currency. */
  site: z.object({ id: z.string().uuid(), code: z.string(), name: z.string(), currency: z.string() }).nullable(),
  /** The sites the caller may read, to choose from. */
  sites: z.array(z.object({ id: z.string().uuid(), code: z.string(), name: z.string(), currency: z.string() })),
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
    /** Cost lines in the period that add nothing yet (waiting for a rate, or, for one site, still stated in another currency). */
    unconverted: z.number(),
  }),
  /** Per week or month: all raised, how many from each source (sources with none are left out), and the cost. */
  trend: z.array(z.object({ start: isoDate, total: z.number(), bySource: z.record(z.number()), cost: z.number() })),
  /** Raised in the period, by source (all eleven, in the fixed order) and by category ("Uncategorised" for those that have none). */
  bySource: z.array(Count),
  byCategory: z.array(Count),
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
 * Figures for the NC dashboard, for one period and optionally one source and one site. Deleted NCRs are left out; RLS limits everything to the sites the
 * caller may read. Costs are net, credits (recoveries, charges) taken off: in the site's currency for one site, in the organisation's for all of them
 * (docs/cost-currency-plan.md CU1, CU9, CU10).
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
    const siteFilter = (siteId: string | undefined) => (siteId ? sql`and n.site_id = ${siteId}::uuid` : sql``);
    const src = q.source.length ? sql`and n.source = any(string_to_array(${q.source.join(',')}, ','))` : sql``;
    const inPeriod = (a: string, b: string) => sql`and n.detected_at between ${a}::date and ${b}::date`;

    return this.database.asUser(ctx, async (db) => {
      const one = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows;

      // The sites the caller may read.
      const sites = (await one(sql`
        select s.id, s.code, s.name, s.currency from public.sites s
        where s.organisation_id = ${org}::uuid and s.active and app.has_permission(${org}::uuid, 'ncr.read', s.id) order by s.code`))
        .map((r) => ({ id: String(r.id), code: String(r.code), name: String(r.name), currency: String(r.currency) }));
      // A person who can read non-conformances organisation-wide sees every one of them (also those with no site or at a switched-off site) unless
      // they choose a site; only someone limited to a single site is shown that site, so their figures are in its currency.
      const [orgWide] = await one(sql`select app.has_permission(${org}::uuid, 'ncr.read') as ok`);
      const siteId = q.siteId ?? (!orgWide?.ok && sites.length === 1 ? sites[0].id : undefined);
      const site = siteId ? sites.find((s) => s.id === siteId) ?? null : null;
      if (siteId && !site) throw ApiError.notFound('site_not_found', 'Site not found');
      const [settings] = await one(sql`select base_currency from public.organisation_settings where organisation_id = ${org}::uuid`);
      const orgCurrency = (settings?.base_currency as string) ?? 'GBP';
      const currency = site ? site.currency : orgCurrency;
      // One site: lines stated in the site currency (net_base). All sites: the organisation figure (net_org). Either way credits count -1 and a line
      // with no rate yet adds nothing.
      const costCol = sql.raw(site ? 'k.net_base' : 'k.net_org');
      const inCurrency = site ? sql`and k.base_currency = ${site.currency}` : sql``;
      // NCRs (not deleted) of this organisation, source and site, with failure mode, part and live net cost total.
      const base = sql`
        from public.nonconformances n
        left join public.ncr_classifications fm on fm.id = n.failure_mode_id
        left join public.parts p on p.id = n.part_id
        left join lateral (select sum(${costCol} * k.cost_sign) as total from public.ncr_costs k where k.nonconformance_id = n.id and k.deleted_at is null ${inCurrency}) tc on true
        where n.organisation_id = ${org}::uuid and n.deleted_at is null ${src} ${siteFilter(siteId)}`;

      const [unconverted] = await one(sql`
        select count(*) as n from public.ncr_costs k join public.nonconformances n on n.id = k.nonconformance_id and n.organisation_id = k.organisation_id
        where n.organisation_id = ${org}::uuid and n.deleted_at is null and k.deleted_at is null ${src} ${siteFilter(siteId)} ${inPeriod(q.from, q.to)}
          and (${costCol} is null ${site ? sql`or k.base_currency <> ${site.currency}` : sql``})`);

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
               coalesce(sum(r.n), 0) as total,
               coalesce(jsonb_object_agg(r.source, r.n) filter (where r.source is not null), '{}'::jsonb) as by_source,
               coalesce(sum(r.cost), 0) as cost
        from buckets b
        left join (select start, source, count(*) as n, sum(cost) as cost from rows group by start, source) r on r.start = b.start
        group by b.start order by b.start`);

      const sources = await one(sql`select n.source as key, count(*) as count ${base} ${inPeriod(q.from, q.to)} group by 1`);
      const categories = await one(sql`
        select coalesce(cat.id::text, 'none') as key, coalesce(cat.name, 'Uncategorised') as label, count(*) as count
        from public.nonconformances n
        left join public.ncr_classifications cat on cat.id = n.category_id
        where n.organisation_id = ${org}::uuid and n.deleted_at is null ${src} ${siteFilter(siteId)} ${inPeriod(q.from, q.to)}
        group by 1, 2 order by 3 desc, 2`);

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

      // Top eight failure modes; the rest are folded into "Other".
      const fm = failureModes.map((r) => ({ key: String(r.key), label: String(r.label), count: n(r.count) }));
      const byFailureMode = fm.length > 8 ? [...fm.slice(0, 7), { key: 'other', label: 'Other', count: fm.slice(7).reduce((t, r) => t + r.count, 0) }] : fm;
      const stageCount = Object.fromEntries(stages.map((r) => [String(r.key), n(r.count)]));
      const sevCount = Object.fromEntries(severities.map((r) => [String(r.key), n(r.count)]));

      return {
        period: { from: q.from, to: q.to, previousFrom: day(previousFrom), previousTo: day(previousTo), bucket },
        baseCurrency: currency,
        currency,
        site,
        sites,
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
          unconverted: n(unconverted?.n),
        },
        trend: trend.map((r) => ({ start: String(r.start), total: n(r.total), bySource: Object.fromEntries(Object.entries((r.by_source as Record<string, unknown>) ?? {}).map(([k, v]) => [k, n(v)])), cost: Math.round(n(r.cost) * 100) / 100 })),
        bySource: NCR_SOURCES.map((s) => ({ key: s, label: NCR_SOURCE_LABELS[s], count: n(sources.find((r) => r.key === s)?.count) })),
        byCategory: categories.map((r) => ({ key: String(r.key), label: String(r.label), count: n(r.count) })),
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

  /** KPIs and chart series for the NC dashboard (period from–to, optional source and site). Costs are net of credits, in the site's currency or the organisation's. */
  @Get()
  @OrganisationScoped('ncr.read', { anyScope: true })
  @ApiQuery({ name: 'source', required: false, description: 'Comma-separated sources' })
  @ApiQuery({ name: 'from', required: true, description: 'Detected on or after (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: true, description: 'Detected on or before (YYYY-MM-DD)' })
  @ApiQuery({ name: 'siteId', required: false, description: 'One site (its currency); omitted = all sites in the organisation currency' })
  @ApiOkResponse({ schema: openApiSchema(Dashboard) })
  get(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.get(ctx, parse(DashboardQuery, query));
  }
}
