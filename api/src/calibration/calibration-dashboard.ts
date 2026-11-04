import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { DatabaseService } from '../database/database.service';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { Dashboard, DashboardQuery } from './calibration.schemas';
import { IN_USE } from './calibration.service';

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);
const day = (d: Date) => d.toISOString().slice(0, 10);
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

const STATUS_LABEL: Record<string, string> = {
  active: 'Active', in_calibration: 'In calibration', quarantined: 'Quarantined', out_of_service: 'Out of service', retired: 'Retired', lost: 'Lost',
};

/**
 * Figures for the calibration dashboard. Gauge counts are as of today; calibration counts are for
 * the period. Deleted gauges and records are left out; RLS limits everything to the sites the
 * caller may read.
 */
@Injectable()
export class CalibrationDashboardService {
  constructor(private readonly database: DatabaseService) {}

  get(ctx: RequestContext, q: z.infer<typeof DashboardQuery>): Promise<Dashboard> {
    const from = new Date(`${q.from}T00:00:00Z`);
    const to = new Date(`${q.to}T00:00:00Z`);
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    const previousTo = new Date(from.getTime() - 86_400_000);
    const previousFrom = new Date(previousTo.getTime() - (days - 1) * 86_400_000);
    const bucket = days > 92 ? 'month' : 'week';
    const org = ctx.organisationId!;
    const gauges = sql`from public.gauges g where g.organisation_id = ${org}::uuid and g.deleted_at is null`;
    const calibrations = sql`
      from public.calibrations c join public.gauges g on g.id = c.gauge_id and g.deleted_at is null
      where c.organisation_id = ${org}::uuid and c.deleted_at is null`;

    return this.database.asUser(ctx, async (db) => {
      const rows = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows;

      const [k] = await rows(sql`
        select to_char(current_date, 'YYYY-MM-DD') as today,
          count(*) filter (where g.status not in ('retired', 'lost')) as gauges,
          count(*) filter (where ${sql.raw(IN_USE)}) as in_use,
          count(*) filter (where ${sql.raw(IN_USE)} and g.next_due_on < current_date) as overdue,
          count(*) filter (where ${sql.raw(IN_USE)} and g.next_due_on between current_date and current_date + 30) as due_30,
          count(*) filter (where g.status = 'quarantined') as quarantined
        ${gauges}`);

      const [c] = await rows(sql`
        select
          count(*) filter (where c.calibrated_on between ${q.from}::date and ${q.to}::date) as calibrated,
          count(*) filter (where c.calibrated_on between ${day(previousFrom)}::date and ${day(previousTo)}::date) as calibrated_previous,
          count(*) filter (where c.calibrated_on between ${q.from}::date and ${q.to}::date and c.outcome = 'fail') as failed,
          count(*) filter (where c.calibrated_on between ${q.from}::date and ${q.to}::date and c.outcome = 'pass') as passed
        ${calibrations}`);

      // Gauges in use falling due in each of the next twelve months (the first includes overdue ones).
      const schedule = await rows(sql`
        with months as (
          select generate_series(date_trunc('month', current_date), date_trunc('month', current_date) + interval '11 months', interval '1 month')::date as start
        )
        select to_char(m.start, 'YYYY-MM-DD') as start,
               count(g.id) as count
        from months m
        left join public.gauges g on g.organisation_id = ${org}::uuid and g.deleted_at is null and ${sql.raw(IN_USE)}
          and g.next_due_on is not null
          and greatest(date_trunc('month', g.next_due_on), date_trunc('month', current_date))::date = m.start
        group by m.start order by m.start`);

      const outcomes = await rows(sql`
        with buckets as (
          select generate_series(date_trunc(${bucket}, ${q.from}::date), date_trunc(${bucket}, ${q.to}::date), ${`1 ${bucket}`}::interval)::date as start
        ), cals as (
          select date_trunc(${bucket}, c.calibrated_on)::date as start, c.outcome
          ${calibrations} and c.calibrated_on between ${q.from}::date and ${q.to}::date
        )
        select to_char(b.start, 'YYYY-MM-DD') as start,
               count(x.*) filter (where x.outcome = 'pass') as pass,
               count(x.*) filter (where x.outcome = 'adjusted') as adjusted,
               count(x.*) filter (where x.outcome = 'fail') as fail
        from buckets b left join cals x on x.start = b.start
        group by b.start order by b.start`);

      const statuses = await rows(sql`select g.status as key, count(*) as count ${gauges} group by 1`);

      const types = await rows(sql`
        select coalesce(t.id::text, 'none') as key, coalesce(t.name, 'No type') as label, count(*) as count
        from public.gauges g left join public.gauge_types t on t.id = g.gauge_type_id
        where g.organisation_id = ${org}::uuid and g.deleted_at is null and g.status not in ('retired', 'lost')
        group by 1, 2 order by 3 desc, 2`);

      const attention = await rows(sql`
        select g.id, g.asset_number, g.description, g.status, to_char(g.next_due_on, 'YYYY-MM-DD') as next_due_on,
               (g.next_due_on - current_date) as days_until_due, s.name as site
        from public.gauges g left join public.sites s on s.id = g.site_id
        where g.organisation_id = ${org}::uuid and g.deleted_at is null
          and ((${sql.raw(IN_USE)} and g.next_due_on <= current_date + 30) or g.status = 'quarantined')
        order by (g.status = 'quarantined') desc, g.next_due_on nulls last, g.asset_number
        limit 15`);

      const statusCount = Object.fromEntries(statuses.map((r) => [String(r.key), n(r.count)]));
      const typeCounts = types.map((r) => ({ key: String(r.key), label: String(r.label), count: n(r.count) }));
      const byType = typeCounts.length > 8 ? [...typeCounts.slice(0, 7), { key: 'other', label: 'Other', count: typeCounts.slice(7).reduce((t, r) => t + r.count, 0) }] : typeCounts;

      return {
        period: { from: q.from, to: q.to, previousFrom: day(previousFrom), previousTo: day(previousTo), bucket },
        today: String(k.today),
        kpis: {
          gauges: n(k.gauges),
          inUse: n(k.in_use),
          overdue: n(k.overdue),
          dueNext30: n(k.due_30),
          quarantined: n(k.quarantined),
          calibrated: n(c.calibrated),
          calibratedPrevious: n(c.calibrated_previous),
          failed: n(c.failed),
          firstTimePassRate: pct(n(c.passed), n(c.calibrated)),
          compliance: pct(n(k.in_use) - n(k.overdue), n(k.in_use)),
        },
        dueSchedule: schedule.map((r) => ({ start: String(r.start), count: n(r.count) })),
        outcomes: outcomes.map((r) => ({ start: String(r.start), pass: n(r.pass), adjusted: n(r.adjusted), fail: n(r.fail) })),
        byStatus: Object.keys(STATUS_LABEL).map((key) => ({ key, label: STATUS_LABEL[key], count: statusCount[key] ?? 0 })),
        byType,
        attention: attention.map((r) => ({
          id: String(r.id),
          assetNumber: String(r.asset_number),
          description: String(r.description),
          status: r.status as Dashboard['attention'][number]['status'],
          nextDueOn: (r.next_due_on as string) ?? null,
          daysUntilDue: r.days_until_due === null || r.days_until_due === undefined ? null : n(r.days_until_due),
          site: (r.site as string) ?? null,
        })),
      };
    });
  }
}

@ApiTags('calibration')
@ApiBearerAuth()
@Controller('calibration-dashboard')
export class CalibrationDashboardController {
  constructor(private readonly service: CalibrationDashboardService) {}

  /** KPIs and chart series for the calibration dashboard (calibrations in from–to; gauges as of today). */
  @Get()
  @OrganisationScoped('calibration.read', { anyScope: true })
  @ApiQuery({ name: 'from', required: true, description: 'Calibrated on or after (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: true, description: 'Calibrated on or before (YYYY-MM-DD)' })
  @ApiOkResponse({ schema: openApiSchema(Dashboard) })
  get(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.get(ctx, parse(DashboardQuery, query));
  }
}
