import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { Row, personName } from '../calibration/calibration.service';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { DatabaseService } from '../database/database.service';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { REC_JOIN, STATE_SQL } from './audit-schedule.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const n = (v: unknown) => Number(v ?? 0);
const day = (d: Date) => d.toISOString().slice(0, 10);
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
/** A target that has not been covered for this long counts as stale on the coverage card. */
export const STALE_DAYS = 90;

export const AuditsDashboardQuery = z
  .object({ from: isoDate, to: isoDate })
  .refine((q) => q.from <= q.to, { message: '"from" must be on or before "to"', path: ['from'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 3 * 366, { message: 'At most three years', path: ['from'] });

const Count = z.object({ key: z.string(), label: z.string(), count: z.number() });
const Id = z.string().uuid();

export const AuditsDashboard = z.object({
  period: z.object({ from: isoDate, to: isoDate, previousFrom: isoDate, previousTo: isoDate, bucket: z.enum(['week', 'month']) }),
  kpis: z.object({
    /** Slots due in the period, not counting those skipped. */
    planned: z.number(),
    done: z.number(),
    doneOnTime: z.number(),
    missed: z.number(),
    /** Past due but still inside their grace period, as of today. */
    overdue: z.number(),
    /** Done, as a share of the slots that are decided or overdue (done, missed, overdue); null when there are none. */
    completionRate: z.number().nullable(),
    /** Of the slots done or missed, the share done by the due date plus the grace period; null when there are none. */
    onTimeRate: z.number().nullable(),
    /** Audits completed in the period (any, scheduled or not). */
    completed: z.number(),
    completedPrevious: z.number(),
    passRate: z.number().nullable(),
    passRatePrevious: z.number().nullable(),
    averageScore: z.number().nullable(),
    openFindings: z.number(),
    overdueFindings: z.number(),
    findingsRaised: z.number(),
    findingsRaisedPrevious: z.number(),
    /** Findings raised in the period that became a non-conformance still alive (counted among the non-conformances the caller may read). */
    nonconformances: z.number(),
    /** Changes to audit templates in the period (a version after the first). */
    versionsSaved: z.number(),
  }),
  /** Slots due per week or month, by how they stand. */
  planned: z.array(z.object({ start: isoDate, done: z.number(), late: z.number(), missed: z.number(), overdue: z.number(), upcoming: z.number() })),
  results: z.array(z.object({ start: isoDate, pass: z.number(), fail: z.number() })),
  findingsByClassification: z.array(Count.extend({ kind: z.string() })),
  findingsByStatus: z.array(Count),
  failedQuestions: z.array(z.object({ auditId: Id, auditReference: z.string(), auditTitle: z.string(), question: z.string(), failed: z.number(), answered: z.number(), failRate: z.number() })),
  coverage: z.object({
    listed: z.number(),
    never: z.number(),
    stale: z.number(),
    staleAfterDays: z.number(),
    items: z.array(z.object({ kind: z.enum(['machine', 'operation', 'department']), label: z.string(), audits: z.array(z.string()), lastAuditedOn: isoDate.nullable(), daysSince: z.number().nullable() })),
  }),
  slotsNeedingAttention: z.array(z.object({ auditId: Id, auditReference: z.string(), auditTitle: z.string(), dueOn: isoDate, state: z.enum(['overdue', 'missed']) })),
  overdueFindings: z.array(z.object({ id: Id, reference: z.string(), title: z.string(), classification: z.string(), dueOn: isoDate, daysOverdue: z.number(), owner: z.string().nullable() })),
  failedRecords: z.array(z.object({ id: Id, reference: z.string(), auditReference: z.string(), auditTitle: z.string(), performedOn: isoDate, score: z.number().nullable(), criticalFailed: z.number() })),
  recentVersions: z.array(z.object({ auditId: Id, auditReference: z.string(), auditTitle: z.string(), version: z.number(), reason: z.string(), at: z.string(), by: z.string().nullable() })),
});
export type AuditsDashboard = z.infer<typeof AuditsDashboard>;

/**
 * The audits dashboard: planned versus done, results, findings, the questions that fail most, how recently each machine, operation and department was covered, and the
 * latest changes to audit templates. Every figure is read as the caller (row-level security, audits.read); the schedule's own state rules are used for slots.
 */
@Injectable()
export class AuditsDashboardService {
  constructor(private readonly database: DatabaseService) {}

  async get(ctx: RequestContext, q: z.infer<typeof AuditsDashboardQuery>): Promise<AuditsDashboard> {
    const from = new Date(`${q.from}T00:00:00Z`);
    const to = new Date(`${q.to}T00:00:00Z`);
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    const previousTo = new Date(from.getTime() - 86_400_000);
    const previousFrom = new Date(previousTo.getTime() - (days - 1) * 86_400_000);
    const bucket = days > 92 ? 'month' : 'week';
    const org = ctx.organisationId!;
    const prev = { from: day(previousFrom), to: day(previousTo) };

    return this.database.asUser(ctx, async (db) => {
      const rows = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows;
      // Slots are made when someone looks (no worker): make sure they exist for the period, and a little beyond today.
      await db.execute(sql`select app.generate_audit_occurrences(${org}::uuid, least(${q.to}::date, current_date + 62))`);

      const slotBase = sql`from public.audit_occurrences o join public.audit_definitions d on d.id = o.audit_definition_id ${sql.raw(REC_JOIN)}
        where o.organisation_id = ${org}::uuid and o.due_on between ${q.from}::date and ${q.to}::date`;
      const state = sql.raw(STATE_SQL);
      const [slots] = await rows(sql`
        select count(*) filter (where ${state} <> 'skipped') as planned,
               count(*) filter (where ${state} = 'done') as done,
               count(*) filter (where ${state} = 'done' and rec.performed_on <= o.due_on + d.grace_days) as done_on_time,
               count(*) filter (where ${state} = 'missed') as missed,
               count(*) filter (where ${state} = 'overdue') as overdue
        ${slotBase}`);

      const [recs] = await rows(sql`
        select count(*) filter (where r.performed_on between ${q.from}::date and ${q.to}::date) as completed,
               count(*) filter (where r.performed_on between ${q.from}::date and ${q.to}::date and r.result = 'pass') as passed,
               avg(r.score) filter (where r.performed_on between ${q.from}::date and ${q.to}::date) as average_score,
               count(*) filter (where r.performed_on between ${prev.from}::date and ${prev.to}::date) as completed_previous,
               count(*) filter (where r.performed_on between ${prev.from}::date and ${prev.to}::date and r.result = 'pass') as passed_previous
          from public.audit_records r where r.organisation_id = ${org}::uuid and r.status = 'completed'`);

      const [fnd] = await rows(sql`
        select count(*) filter (where f.status = 'open') as open_now,
               count(*) filter (where f.status = 'open' and f.due_on < current_date) as overdue_now,
               count(*) filter (where f.status <> 'withdrawn' and f.created_at::date between ${q.from}::date and ${q.to}::date) as raised,
               count(*) filter (where f.status <> 'withdrawn' and f.created_at::date between ${prev.from}::date and ${prev.to}::date) as raised_previous,
               count(*) filter (where f.status <> 'withdrawn' and f.created_at::date between ${q.from}::date and ${q.to}::date and exists (select 1 from public.audit_ncr_links l join public.nonconformances x on x.id = l.nonconformance_id
                                where l.finding_id = f.id and x.deleted_at is null and x.stage <> 'cancelled')) as with_ncr
          from public.audit_findings f where f.organisation_id = ${org}::uuid`);

      const [vers] = await rows(sql`
        select count(*) as saved from public.audit_versions v
         where v.organisation_id = ${org}::uuid and v.version > 1 and v.created_at::date between ${q.from}::date and ${q.to}::date`);

      const planned = await rows(sql`
        with buckets as (
          select generate_series(date_trunc(${bucket}, ${q.from}::date), date_trunc(${bucket}, ${q.to}::date), ${`1 ${bucket}`}::interval)::date as start
        ), s as (
          select date_trunc(${bucket}, o.due_on)::date as start, (${state}) as state, (rec.performed_on <= o.due_on + d.grace_days) as on_time ${slotBase}
        )
        select to_char(b.start, 'YYYY-MM-DD') as start,
               count(s.*) filter (where s.state = 'done' and s.on_time) as done,
               count(s.*) filter (where s.state = 'done' and not s.on_time) as late,
               count(s.*) filter (where s.state = 'missed') as missed,
               count(s.*) filter (where s.state = 'overdue') as overdue,
               count(s.*) filter (where s.state in ('upcoming', 'in_progress')) as upcoming
          from buckets b left join s on s.start = b.start group by b.start order by b.start`);

      const results = await rows(sql`
        with buckets as (
          select generate_series(date_trunc(${bucket}, ${q.from}::date), date_trunc(${bucket}, ${q.to}::date), ${`1 ${bucket}`}::interval)::date as start
        ), r as (
          select date_trunc(${bucket}, x.performed_on)::date as start, x.result from public.audit_records x
           where x.organisation_id = ${org}::uuid and x.status = 'completed' and x.performed_on between ${q.from}::date and ${q.to}::date
        )
        select to_char(b.start, 'YYYY-MM-DD') as start, count(r.*) filter (where r.result = 'pass') as pass, count(r.*) filter (where r.result = 'fail') as fail
          from buckets b left join r on r.start = b.start group by b.start order by b.start`);

      const byClass = await rows(sql`
        select c.key, c.label, c.kind, count(f.id) as count
          from public.audit_finding_classifications c
          left join public.audit_findings f on f.classification_id = c.id and f.status <> 'withdrawn' and f.created_at::date between ${q.from}::date and ${q.to}::date
         where c.organisation_id = ${org}::uuid and (c.active or f.id is not null)
         group by c.id, c.key, c.label, c.kind, c.sequence order by c.sequence, c.label`);

      const byStatus = await rows(sql`
        select f.status as key, count(*) as count from public.audit_findings f
         where f.organisation_id = ${org}::uuid and f.created_at::date between ${q.from}::date and ${q.to}::date group by 1`);

      const failedQuestions = await rows(sql`
        select rec.audit_definition_id as audit_id, rec.audit_reference, rec.audit_title, qu.question,
               count(*) filter (where s.result = 'fail') as failed, count(*) filter (where s.result in ('pass', 'fail')) as answered
          from public.audit_responses s
          join public.audit_record_questions qu on qu.id = s.record_question_id
          join public.audit_records rec on rec.id = s.audit_record_id and rec.status = 'completed' and rec.performed_on between ${q.from}::date and ${q.to}::date
         where s.organisation_id = ${org}::uuid
         group by rec.audit_definition_id, rec.audit_reference, rec.audit_title, qu.question
        having count(*) filter (where s.result = 'fail') > 0
         order by failed desc, answered, qu.question limit 8`);

      const coverage = await rows(sql`
        with listed as (
          select t.kind, coalesce(t.machine_id::text, upper(t.operation_code), t.department_id::text) as ref,
                 min(case t.kind when 'machine' then m.code || ' · ' || m.name when 'operation' then t.operation_code else dp.code || ' · ' || dp.name end) as label,
                 array_agg(distinct d.reference order by d.reference) as audits
            from public.audit_targets t
            join public.audit_definitions d on d.id = t.audit_definition_id and d.status = 'active'
            left join public.machines m on m.id = t.machine_id
            left join public.departments dp on dp.id = t.department_id
           where t.organisation_id = ${org}::uuid group by 1, 2
        ), covered as (
          select rt.kind, coalesce(rt.machine_id::text, upper(rt.operation_code), rt.department_id::text) as ref, max(r.performed_on) as last_on
            from public.audit_record_targets rt join public.audit_records r on r.id = rt.audit_record_id and r.status = 'completed'
           where rt.organisation_id = ${org}::uuid group by 1, 2
        )
        select l.kind, l.label, l.audits, to_char(c.last_on, 'YYYY-MM-DD') as last_on, (current_date - c.last_on) as days_since
          from listed l left join covered c on c.kind = l.kind and c.ref = l.ref
         order by c.last_on nulls first, l.label`);

      const attention = await rows(sql`
        select d.id as audit_id, d.reference, d.title, to_char(o.due_on, 'YYYY-MM-DD') as due_on, (${state}) as state
          ${slotBase} and (${state}) in ('overdue', 'missed') order by o.due_on desc limit 8`);

      const overdueFindings = await rows(sql`
        select f.id, f.reference, f.title, c.label as classification, to_char(f.due_on, 'YYYY-MM-DD') as due_on, (current_date - f.due_on) as days_overdue,
               ${sql.raw(personName('e'))} as owner
          from public.audit_findings f
          join public.audit_finding_classifications c on c.id = f.classification_id
          left join public."Employees" e on e.id = f.owner_employee_id
         where f.organisation_id = ${org}::uuid and f.status = 'open' and f.due_on < current_date order by f.due_on limit 8`);

      const failedRecords = await rows(sql`
        select r.id, r.reference, r.audit_reference, r.audit_title, to_char(r.performed_on, 'YYYY-MM-DD') as performed_on, r.score, r.critical_failed_count
          from public.audit_records r
         where r.organisation_id = ${org}::uuid and r.status = 'completed' and r.result = 'fail' and r.performed_on between ${q.from}::date and ${q.to}::date
         order by r.performed_on desc, r.reference desc limit 6`);

      const recentVersions = await rows(sql`
        select d.id as audit_id, d.reference, d.title, v.version, v.reason, v.created_at, ${sql.raw(personName('p'))} as by
          from public.audit_versions v join public.audit_definitions d on d.id = v.audit_definition_id left join public.profiles p on p.id = v.created_by
         where v.organisation_id = ${org}::uuid and v.version > 1 and v.created_at::date between ${q.from}::date and ${q.to}::date
         order by v.created_at desc limit 8`);

      const done = n(slots.done);
      const missed = n(slots.missed);
      const overdue = n(slots.overdue);
      const completed = n(recs.completed);
      const completedPrevious = n(recs.completed_previous);
      const items = coverage.map((r) => ({
        kind: r.kind as 'machine' | 'operation' | 'department',
        label: r.label as string,
        audits: (r.audits as string[]) ?? [],
        lastAuditedOn: (r.last_on as string) ?? null,
        daysSince: r.days_since === null || r.days_since === undefined ? null : n(r.days_since),
      }));

      return {
        period: { from: q.from, to: q.to, previousFrom: prev.from, previousTo: prev.to, bucket },
        kpis: {
          planned: n(slots.planned),
          done,
          doneOnTime: n(slots.done_on_time),
          missed,
          overdue,
          completionRate: pct(done, done + missed + overdue),
          onTimeRate: pct(n(slots.done_on_time), done + missed),
          completed,
          completedPrevious,
          passRate: pct(n(recs.passed), completed),
          passRatePrevious: pct(n(recs.passed_previous), completedPrevious),
          averageScore: recs.average_score === null || recs.average_score === undefined ? null : Math.round(n(recs.average_score) * 10) / 10,
          openFindings: n(fnd.open_now),
          overdueFindings: n(fnd.overdue_now),
          findingsRaised: n(fnd.raised),
          findingsRaisedPrevious: n(fnd.raised_previous),
          nonconformances: n(fnd.with_ncr),
          versionsSaved: n(vers.saved),
        },
        planned: planned.map((r) => ({ start: r.start as string, done: n(r.done), late: n(r.late), missed: n(r.missed), overdue: n(r.overdue), upcoming: n(r.upcoming) })),
        results: results.map((r) => ({ start: r.start as string, pass: n(r.pass), fail: n(r.fail) })),
        findingsByClassification: byClass.map((r) => ({ key: r.key as string, label: r.label as string, kind: r.kind as string, count: n(r.count) })),
        findingsByStatus: (['open', 'closed', 'withdrawn'] as const).map((k) => ({ key: k, label: k[0].toUpperCase() + k.slice(1), count: n(byStatus.find((r) => r.key === k)?.count) })),
        failedQuestions: failedQuestions.map((r) => ({
          auditId: r.audit_id as string,
          auditReference: r.audit_reference as string,
          auditTitle: r.audit_title as string,
          question: r.question as string,
          failed: n(r.failed),
          answered: n(r.answered),
          failRate: pct(n(r.failed), n(r.answered)) ?? 0,
        })),
        coverage: {
          listed: items.length,
          never: items.filter((i) => i.lastAuditedOn === null).length,
          stale: items.filter((i) => i.daysSince !== null && i.daysSince > STALE_DAYS).length,
          staleAfterDays: STALE_DAYS,
          items: items.slice(0, 15),
        },
        slotsNeedingAttention: attention.map((r) => ({ auditId: r.audit_id as string, auditReference: r.reference as string, auditTitle: r.title as string, dueOn: r.due_on as string, state: r.state as 'overdue' | 'missed' })),
        overdueFindings: overdueFindings.map((r) => ({
          id: r.id as string,
          reference: r.reference as string,
          title: r.title as string,
          classification: r.classification as string,
          dueOn: r.due_on as string,
          daysOverdue: n(r.days_overdue),
          owner: (r.owner as string) ?? null,
        })),
        failedRecords: failedRecords.map((r) => ({
          id: r.id as string,
          reference: r.reference as string,
          auditReference: r.audit_reference as string,
          auditTitle: r.audit_title as string,
          performedOn: r.performed_on as string,
          score: r.score === null || r.score === undefined ? null : n(r.score),
          criticalFailed: n(r.critical_failed_count),
        })),
        recentVersions: recentVersions.map((r) => ({ auditId: r.audit_id as string, auditReference: r.reference as string, auditTitle: r.title as string, version: n(r.version), reason: r.reason as string, at: iso(r.created_at)!, by: (r.by as string) ?? null })),
      };
    });
  }
}

@ApiTags('audits')
@ApiBearerAuth()
@Controller('audits-dashboard')
export class AuditsDashboardController {
  constructor(private readonly service: AuditsDashboardService) {}

  /** KPIs, chart series, findings, coverage and attention lists for the audits dashboard (slots due and audits done in from–to; findings and coverage as of today). */
  @Get()
  @OrganisationScoped('audits.read')
  @ApiQuery({ name: 'from', required: true, description: 'From (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: true, description: 'To (YYYY-MM-DD)' })
  @ApiOkResponse({ schema: openApiSchema(AuditsDashboard) })
  get(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.get(ctx, parse(AuditsDashboardQuery, query));
  }
}
