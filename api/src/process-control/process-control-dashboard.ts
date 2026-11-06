import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { Row, personName } from '../calibration/calibration.service';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { DatabaseService } from '../database/database.service';
import { SpcService } from '../spc/spc.service';
import { OrganisationScoped } from '../tenancy/organisation.guard';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const n = (v: unknown) => Number(v ?? 0);
const day = (d: Date) => d.toISOString().slice(0, 10);
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export const ProcessControlDashboardQuery = z
  .object({ from: isoDate, to: isoDate })
  .refine((q) => q.from <= q.to, { message: '"from" must be on or before "to"', path: ['from'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 3 * 366, { message: 'At most three years', path: ['from'] });

const Count = z.object({ key: z.string(), label: z.string(), count: z.number() });
export const ProcessControlDashboard = z.object({
  period: z.object({ from: isoDate, to: isoDate, previousFrom: isoDate, previousTo: isoDate, bucket: z.enum(['week', 'month']) }),
  kpis: z.object({
    awaitingApproval: z.number(),
    effectivePlans: z.number(),
    plansWithoutEffective: z.number(),
    inspections: z.number(),
    inspectionsPrevious: z.number(),
    inProgress: z.number(),
    /** Share of completed inspections in the period that passed (0–100), null without any. */
    firstPassRate: z.number().nullable(),
    /** Failed readings still without an acknowledgement or a non-conformance. */
    openFailures: z.number(),
  }),
  inspectionsByPeriod: z.array(z.object({ start: isoDate, pass: z.number(), fail: z.number(), inProgress: z.number() })),
  revisionsByStatus: z.array(Count),
  failuresByCharacteristic: z.array(Count),
  planAttention: z.array(
    z.object({
      kind: z.enum(['awaiting_approval', 'no_effective_revision', 'review_due']),
      planId: z.string().uuid(),
      revisionId: z.string().uuid().nullable(),
      planCode: z.string(),
      title: z.string(),
      revisionCode: z.string().nullable(),
      since: z.string().nullable(),
      by: z.string().nullable(),
    }),
  ),
  openFailures: z.array(
    z.object({
      inspectionId: z.string().uuid(),
      reference: z.string(),
      partNumber: z.string(),
      characteristic: z.string(),
      value: z.string(),
      limits: z.string(),
      measuredAt: z.string(),
    }),
  ),
  inProgress: z.array(
    z.object({ id: z.string().uuid(), reference: z.string(), partNumber: z.string(), operationCode: z.string().nullable(), startedAt: z.string(), ageHours: z.number(), samples: z.number() }),
  ),
  spc: z.object({
    available: z.boolean(),
    windowDays: z.number(),
    monitored: z.number(),
    withSignals: z.number(),
    withoutBaseline: z.number(),
    signalCount: z.number(),
    byRule: z.array(z.object({ rule: z.string(), count: z.number() })),
    recent: z.array(
      z.object({
        partId: z.string().uuid(),
        partNumber: z.string(),
        characteristicKey: z.string(),
        characteristicName: z.string(),
        operationCode: z.string(),
        rule: z.string(),
        text: z.string(),
        at: z.string(),
        point: z.number(),
        inspections: z.array(z.object({ id: z.string().uuid(), reference: z.string() })),
      }),
    ),
  }),
});
export type ProcessControlDashboard = z.infer<typeof ProcessControlDashboard>;

const REVISION_LABEL: Record<string, string> = {
  draft: 'Draft',
  pending_approval: 'Awaiting approval',
  approved: 'Approved',
  effective: 'Effective',
  superseded: 'Superseded',
  obsolete: 'Obsolete',
};

/**
 * The process control dashboard: control plan pipeline as of today, inspection activity in a period, the failures
 * that still need someone, and where the SPC charts are signalling. Row-level security limits every figure to what
 * the caller may read (inspections by site); SPC needs spc.read.
 */
@Injectable()
export class ProcessControlDashboardService {
  constructor(
    private readonly database: DatabaseService,
    private readonly spc: SpcService,
  ) {}

  async get(ctx: RequestContext, q: z.infer<typeof ProcessControlDashboardQuery>): Promise<ProcessControlDashboard> {
    const from = new Date(`${q.from}T00:00:00Z`);
    const to = new Date(`${q.to}T00:00:00Z`);
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    const previousTo = new Date(from.getTime() - 86_400_000);
    const previousFrom = new Date(previousTo.getTime() - (days - 1) * 86_400_000);
    const bucket = days > 92 ? 'month' : 'week';
    const org = ctx.organisationId!;
    const unhandled = sql`
      m.result = 'fail' and not exists (select 1 from public.inspection_measurements c where c.supersedes_id = m.id)
      and not exists (select 1 from public.inspection_failure_acknowledgements a where a.measurement_id = m.id)
      and app.reading_live_ncr(m.id) is null`;

    const spc = await this.spc.overview(ctx, { days: 30, maxCharts: 40, maxRecent: 10 });

    return this.database.asUser(ctx, async (db) => {
      const rows = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows;

      const [plans] = await rows(sql`
        select count(*) filter (where r.status = 'pending_approval') as awaiting,
               count(*) filter (where r.status = 'effective') as effective,
               (select count(*) from public.control_plans p where p.organisation_id = ${org}::uuid and p.active
                  and not exists (select 1 from public.control_plan_revisions e where e.control_plan_id = p.id and e.status = 'effective')) as without_effective
        from public.control_plan_revisions r where r.organisation_id = ${org}::uuid`);

      const [insp] = await rows(sql`
        select count(*) filter (where r.started_at::date between ${q.from}::date and ${q.to}::date) as started,
               count(*) filter (where r.started_at::date between ${day(previousFrom)}::date and ${day(previousTo)}::date) as started_previous,
               count(*) filter (where r.status = 'in_progress') as in_progress,
               count(*) filter (where r.status = 'completed' and r.completed_at::date between ${q.from}::date and ${q.to}::date) as completed,
               count(*) filter (where r.status = 'completed' and r.result = 'pass' and r.completed_at::date between ${q.from}::date and ${q.to}::date) as passed
        from public.inspection_records r where r.organisation_id = ${org}::uuid`);

      const [open] = await rows(sql`select count(*) as count from public.inspection_measurements m where m.organisation_id = ${org}::uuid and ${unhandled}`);

      const byPeriod = await rows(sql`
        with buckets as (
          select generate_series(date_trunc(${bucket}, ${q.from}::date), date_trunc(${bucket}, ${q.to}::date), ${`1 ${bucket}`}::interval)::date as start
        ), recs as (
          select date_trunc(${bucket}, r.started_at)::date as start, r.status, r.result
          from public.inspection_records r
          where r.organisation_id = ${org}::uuid and r.started_at::date between ${q.from}::date and ${q.to}::date and r.status <> 'abandoned'
        )
        select to_char(b.start, 'YYYY-MM-DD') as start,
               count(x.*) filter (where x.status = 'completed' and x.result = 'pass') as pass,
               count(x.*) filter (where x.status = 'completed' and x.result = 'fail') as fail,
               count(x.*) filter (where x.status = 'in_progress') as in_progress
        from buckets b left join recs x on x.start = b.start group by b.start order by b.start`);

      const statuses = await rows(sql`
        select r.status as key, count(*) as count from public.control_plan_revisions r
        join public.control_plans p on p.id = r.control_plan_id where r.organisation_id = ${org}::uuid and p.active group by 1`);
      const statusCount = Object.fromEntries(statuses.map((r) => [String(r.key), n(r.count)]));

      const failing = await rows(sql`
        select q.characteristic_key as key, (array_agg(q.name order by m.measured_at desc))[1] as label, count(*) as count
        from public.inspection_measurements m join public.resolved_inspection_requirements q on q.id = m.requirement_id
        where m.organisation_id = ${org}::uuid and m.result = 'fail' and not exists (select 1 from public.inspection_measurements c where c.supersedes_id = m.id)
          and m.measured_at::date between ${q.from}::date and ${q.to}::date
        group by q.characteristic_key order by 3 desc, 2 limit 8`);

      const attention = await rows(sql`
        select 'awaiting_approval' as kind, p.id as plan_id, r.id as revision_id, p.plan_code, p.title, r.revision_code, r.submitted_at as since,
               ${sql.raw(personName('pr'))} as by_name, 1 as ord
        from public.control_plan_revisions r join public.control_plans p on p.id = r.control_plan_id
        left join public.profiles pr on pr.id = r.submitted_by
        where r.organisation_id = ${org}::uuid and r.status = 'pending_approval' and p.active
        union all
        select 'no_effective_revision', p.id, null, p.plan_code, p.title, null, p.created_at, null, 2
        from public.control_plans p
        where p.organisation_id = ${org}::uuid and p.active
          and not exists (select 1 from public.control_plan_revisions e where e.control_plan_id = p.id and e.status in ('effective', 'pending_approval'))
        union all
        select 'review_due', p.id, r.id, p.plan_code, p.title, r.revision_code, r.effective_from, null, 3
        from public.control_plan_revisions r join public.control_plans p on p.id = r.control_plan_id
        where r.organisation_id = ${org}::uuid and r.status = 'effective' and p.active and r.effective_from < now() - interval '12 months'
        order by 9, 7 nulls last limit 12`);

      const failures = await rows(sql`
        select m.value_numeric::text as value_text, m.value_pass, m.value_count, m.measured_at, r.id as inspection_id, r.reference, p.part_number,
               q.name, q.nominal, q.lower_limit, q.upper_limit, q.unit_code
        from public.inspection_measurements m
        join public.inspection_records r on r.id = m.inspection_record_id join public.parts p on p.id = r.part_id
        join public.resolved_inspection_requirements q on q.id = m.requirement_id
        where m.organisation_id = ${org}::uuid and ${unhandled} order by m.measured_at desc limit 10`);

      const working = await rows(sql`
        select r.id, r.reference, p.part_number, r.operation_code, r.started_at,
               extract(epoch from (now() - r.started_at)) / 3600 as age_hours,
               (select count(*) from public.inspection_samples s where s.inspection_record_id = r.id) as samples
        from public.inspection_records r join public.parts p on p.id = r.part_id
        where r.organisation_id = ${org}::uuid and r.status = 'in_progress' order by r.started_at limit 10`);

      const hasLimit = (v: unknown) => v !== null && v !== undefined;
      const limitsText = (r: Row) => {
        if (r.value_pass !== null && r.value_pass !== undefined) return 'Pass/fail check';
        if (r.value_count !== null && r.value_count !== undefined) return hasLimit(r.upper_limit) ? `at most ${n(r.upper_limit)} defects per unit` : 'defects counted';
        const unit = r.unit_code ? ` ${r.unit_code}` : '';
        const lo = r.lower_limit === null ? null : n(r.lower_limit);
        const hi = r.upper_limit === null ? null : n(r.upper_limit);
        if (lo !== null && hi !== null) return `${lo} to ${hi}${unit}`;
        return lo !== null ? `min ${lo}${unit}` : hi !== null ? `max ${hi}${unit}` : 'no limits';
      };

      return {
        period: { from: q.from, to: q.to, previousFrom: day(previousFrom), previousTo: day(previousTo), bucket },
        kpis: {
          awaitingApproval: n(plans.awaiting),
          effectivePlans: n(plans.effective),
          plansWithoutEffective: n(plans.without_effective),
          inspections: n(insp.started),
          inspectionsPrevious: n(insp.started_previous),
          inProgress: n(insp.in_progress),
          firstPassRate: pct(n(insp.passed), n(insp.completed)),
          openFailures: n(open.count),
        },
        inspectionsByPeriod: byPeriod.map((r) => ({ start: String(r.start), pass: n(r.pass), fail: n(r.fail), inProgress: n(r.in_progress) })),
        revisionsByStatus: Object.keys(REVISION_LABEL).map((key) => ({ key, label: REVISION_LABEL[key], count: statusCount[key] ?? 0 })),
        failuresByCharacteristic: failing.map((r) => ({ key: String(r.key), label: String(r.label), count: n(r.count) })),
        planAttention: attention.map((r) => ({
          kind: r.kind as ProcessControlDashboard['planAttention'][number]['kind'],
          planId: String(r.plan_id),
          revisionId: (r.revision_id as string) ?? null,
          planCode: String(r.plan_code),
          title: String(r.title),
          revisionCode: (r.revision_code as string) ?? null,
          since: iso(r.since),
          by: (r.by_name as string) ?? null,
        })),
        openFailures: failures.map((r) => ({
          inspectionId: String(r.inspection_id),
          reference: String(r.reference),
          partNumber: String(r.part_number),
          characteristic: String(r.name),
          value: r.value_pass !== null && r.value_pass !== undefined ? (r.value_pass ? 'Pass' : 'Fail') : r.value_count !== null && r.value_count !== undefined ? `${r.value_count} ${Number(r.value_count) === 1 ? 'defect' : 'defects'}` : `${r.value_text}${r.unit_code ? ` ${r.unit_code}` : ''}`,
          limits: limitsText(r),
          measuredAt: iso(r.measured_at)!,
        })),
        inProgress: working.map((r) => ({
          id: String(r.id),
          reference: String(r.reference),
          partNumber: String(r.part_number),
          operationCode: (r.operation_code as string) ?? null,
          startedAt: iso(r.started_at)!,
          ageHours: Math.round(n(r.age_hours) * 10) / 10,
          samples: n(r.samples),
        })),
        spc,
      };
    });
  }
}

@ApiTags('process-control')
@ApiBearerAuth()
@Controller('process-control-dashboard')
export class ProcessControlDashboardController {
  constructor(private readonly service: ProcessControlDashboardService) {}

  /** KPIs, chart series and attention lists for the process control dashboard (inspections in from–to; plans and SPC as of today). */
  @Get()
  @OrganisationScoped('process_control.read', { anyScope: true })
  @ApiQuery({ name: 'from', required: true, description: 'Started on or after (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: true, description: 'Started on or before (YYYY-MM-DD)' })
  @ApiOkResponse({ schema: openApiSchema(ProcessControlDashboard) })
  get(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.get(ctx, parse(ProcessControlDashboardQuery, query));
  }
}
