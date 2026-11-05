import { Injectable } from '@nestjs/common';
import { SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import { decodeCursor, Page, toPage } from '../common/pagination';
import type { RequestContext } from '../common/request-context';
import { iso, num, personName, Row } from '../calibration/calibration.service';
import { DatabaseService, Db } from '../database/database.service';
import { buildSchedule, EVENT_TRIGGERS, eventViolations, nextSample, PLANNED_TRIGGERS, PlanRequirement, plannedViolations, timedDue } from './sampling-rules';
import {
  AbandonBody,
  AddSampleBody,
  CorrectionBody,
  InspectionDetail,
  InspectionListQuery,
  InspectionSummary,
  StartInspectionBody,
} from './inspection.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) || 'Unknown user' } : null);
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

const SUMMARY_SELECT = `
  select r.*, p.part_number, p.name as part_name, pr.revision as part_revision, cp.plan_code, cr.revision_code,
         s.name as site_name, m.code as machine_code, m.name as machine_name, ${personName('pc')} as started_by_name,
         ${personName('pd')} as completed_by_name,
         (select count(*) from public.inspection_measurements x
           where x.inspection_record_id = r.id and x.result = 'fail'
             and not exists (select 1 from public.inspection_measurements c where c.supersedes_id = x.id)) as failures
  from public.inspection_records r
  join public.parts p on p.id = r.part_id
  join public.part_revisions pr on pr.id = r.part_revision_id
  join public.control_plans cp on cp.id = r.control_plan_id
  join public.control_plan_revisions cr on cr.id = r.control_plan_revision_id
  join public.sites s on s.id = r.site_id
  left join public.machines m on m.id = r.machine_id
  left join public.profiles pc on pc.id = r.created_by
  left join public.profiles pd on pd.id = r.completed_by`;

const toSummary = (r: Row): InspectionSummary => ({
  id: r.id as string,
  reference: r.reference as string,
  status: r.status as InspectionSummary['status'],
  result: (r.result as InspectionSummary['result']) ?? null,
  part: { id: r.part_id as string, partNumber: r.part_number as string, name: r.part_name as string },
  partRevision: r.part_revision as string,
  plan: { id: r.control_plan_id as string, planCode: r.plan_code as string, revisionCode: r.revision_code as string },
  operationCode: (r.operation_code as string) ?? null,
  site: { id: r.site_id as string, name: r.site_name as string },
  machine: r.machine_id ? { id: r.machine_id as string, code: r.machine_code as string, name: r.machine_name as string } : null,
  workOrder: (r.work_order as string) ?? null,
  lot: (r.lot as string) ?? null,
  lotSize: r.lot_size == null ? null : Number(r.lot_size),
  serial: (r.serial as string) ?? null,
  triggerType: r.trigger_type as InspectionSummary['triggerType'],
  startedAt: iso(r.started_at)!,
  startedBy: person(r.created_by, r.started_by_name),
  failures: Number(r.failures ?? 0),
});

/**
 * In-process inspections (PC4). The database owns the rules: app.start_inspection resolves and
 * freezes the requirements in the same transaction (refusing with the reasons when blocked),
 * readings are insert-only with pass/fail worked out from the unrounded value, gauges are checked at
 * the time of use, corrections and retests are new rows, and completion works out the result. Its
 * messages come back as 409 inspection_rule.
 */
@Injectable()
export class InspectionService {
  constructor(private readonly database: DatabaseService) {}

  list(ctx: RequestContext, q: z.infer<typeof InspectionListQuery>): Promise<Page<InspectionSummary>> {
    const cursor = decodeCursor(q.cursor);
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`r.organisation_id = ${orgOf(ctx)}::uuid`];
      if (q.status) where.push(sql`r.status = ${q.status}`);
      if (q.result) where.push(sql`r.result = ${q.result}`);
      if (q.partId) where.push(sql`r.part_id = ${q.partId}::uuid`);
      if (q.q) {
        const like = likePattern(q.q);
        where.push(sql`(r.reference ilike ${like} or p.part_number ilike ${like} or r.work_order ilike ${like} or r.lot ilike ${like} or r.serial ilike ${like})`);
      }
      if (cursor) where.push(sql`(r.started_at, r.id) < (${cursor.k}::timestamptz, ${cursor.id}::uuid)`);
      const result = await db.execute<Row>(sql`${sql.raw(SUMMARY_SELECT)} where ${sql.join(where, sql` and `)}
        order by r.started_at desc, r.id desc limit ${q.limit + 1}`);
      return toPage(result.rows.map(toSummary), q.limit, (r) => ({ k: r.startedAt, id: r.id }));
    });
  }

  get(ctx: RequestContext, id: string): Promise<InspectionDetail> {
    return this.database.asUser(ctx, (db) => this.load(db, ctx, id));
  }

  start(ctx: RequestContext, body: z.infer<typeof StartInspectionBody>): Promise<InspectionDetail> {
    return this.database.asUser(ctx, async (db) => {
      const part = await db.execute(sql`select 1 from public.parts where id = ${body.partId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!part.rows.length) throw ApiError.notFound('part_not_found', 'Part not found');
      const result = await db.execute<{ id: string }>(sql`select app.start_inspection(
        ${body.siteId}::uuid, ${body.partId}::uuid, ${body.operationCode ?? null}, ${body.machineId ?? null}::uuid,
        ${body.workOrder ?? null}, ${body.lot ?? null}, ${body.serial ?? null}, ${body.triggerType ?? 'manual'},
        ${body.partRevisionId ?? null}::uuid, ${body.notes ?? null}, ${body.lotSize ?? null}::integer) as id`);
      return this.load(db, ctx, result.rows[0].id);
    });
  }

  /** A sample and its readings, saved in one transaction (all or nothing). */
  addSample(ctx: RequestContext, id: string, body: z.infer<typeof AddSampleBody>): Promise<InspectionDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.requireRecord(db, ctx, id);
      const trigger = body.isRetest ? (body.triggerType ?? 'manual') : await this.planSample(db, id, body);
      const sample = await db.execute<{ id: string }>(sql`insert into public.inspection_samples
        (organisation_id, inspection_record_id, unit_reference, trigger_type, is_retest, notes)
        values (${orgOf(ctx)}::uuid, ${id}::uuid, ${body.unitReference ?? null}, ${trigger}, ${body.isRetest ?? false}, ${body.notes ?? null})
        returning id`);
      const sampleId = sample.rows[0].id;
      for (const r of body.readings) {
        await db.execute(sql`insert into public.inspection_measurements
          (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, value_pass, gauge_id, gauge_override_reason, retest_of_id, notes)
          values (${orgOf(ctx)}::uuid, ${id}::uuid, ${sampleId}::uuid, ${r.requirementId}::uuid, ${r.valueNumeric ?? null}::numeric,
                  ${r.valuePass ?? null}, ${r.gaugeId ?? null}::uuid, ${r.gaugeOverrideReason ?? null}, ${r.retestOfId ?? null}::uuid, ${r.notes ?? null})`);
      }
      return this.load(db, ctx, id);
    });
  }

  /** An inspection can only be completed once every planned sample is recorded (abandon it otherwise). */
  private async assertPlannedSamplesDone(db: Db, id: string) {
    const rec = await db.execute<Row>(sql`select lot_size, status from public.inspection_records where id = ${id}::uuid`);
    if (rec.rows[0]?.status !== 'in_progress') return; // the database reports the status
    const reqRows = await db.execute<Row>(sql`select id, char_number, name, applicable, sampling from public.resolved_inspection_requirements where inspection_record_id = ${id}::uuid`);
    const reqs: PlanRequirement[] = reqRows.rows.map((q) => ({
      id: q.id as string,
      name: q.name as string,
      charNumber: (q.char_number as string) ?? null,
      applicable: q.applicable as boolean,
      sampling: (q.sampling as PlanRequirement['sampling']) ?? [],
    }));
    const schedule = buildSchedule(reqs, rec.rows[0]?.lot_size == null ? null : Number(rec.rows[0].lot_size));
    const samples = await db.execute<Row>(sql`select trigger_type from public.inspection_samples where inspection_record_id = ${id}::uuid and not is_retest`);
    const taken = samples.rows.filter((x) => PLANNED_TRIGGERS.includes(x.trigger_type as string)).length;
    if (taken < schedule.length) {
      const next = schedule[taken];
      throw new ApiError(409, 'inspection_rule', `Cannot complete: ${taken} of ${schedule.length} planned samples are recorded; sample ${next.number} (part ${next.position}) is next. Abandon the inspection to stop early`);
    }
  }

  /**
   * Applies the control plan's sampling rules to a new (non-retest) sample and returns the trigger to record.
   * Event samples (shift start, set-up, tool change, manual) must be checks the plan samples on that event.
   * Otherwise the sample is the next one of the planned sequence — exactly the checks it lists, plus timed
   * checks that are due — or a timed extra once the sequence is complete.
   */
  private async planSample(db: Db, id: string, body: z.infer<typeof AddSampleBody>): Promise<string> {
    const rec = await db.execute<Row>(sql`select lot_size, status from public.inspection_records where id = ${id}::uuid`);
    if (rec.rows[0]?.status !== 'in_progress') return body.triggerType ?? 'manual'; // the database refuses closed inspections
    const lot = rec.rows[0]?.lot_size == null ? null : Number(rec.rows[0].lot_size);
    const reqRows = await db.execute<Row>(sql`select id, char_number, name, applicable, sampling from public.resolved_inspection_requirements where inspection_record_id = ${id}::uuid`);
    const reqs: PlanRequirement[] = reqRows.rows.map((q) => ({
      id: q.id as string,
      name: `${(q.char_number as string) ?? ''} ${q.name as string}`.trim(),
      charNumber: (q.char_number as string) ?? null,
      applicable: q.applicable as boolean,
      sampling: (q.sampling as PlanRequirement['sampling']) ?? [],
    }));
    const sent = [...new Set(body.readings.map((r) => r.requirementId))];
    const trigger = body.triggerType ?? '';
    if (EVENT_TRIGGERS.includes(trigger)) {
      const problems = eventViolations(trigger, reqs, sent.filter((x) => reqs.some((q) => q.id === x)));
      if (problems.length) throw new ApiError(409, 'inspection_rule', problems.join('; '));
      return trigger;
    }
    const samples = await db.execute<Row>(sql`select trigger_type from public.inspection_samples where inspection_record_id = ${id}::uuid and not is_retest`);
    const plannedTaken = samples.rows.filter((x) => PLANNED_TRIGGERS.includes(x.trigger_type as string)).length;
    const last = await db.execute<Row>(sql`select requirement_id, max(m.measured_at) as at from public.inspection_measurements m
      join public.inspection_samples s on s.id = m.sample_id
      where m.inspection_record_id = ${id}::uuid and not s.is_retest and m.supersedes_id is null group by requirement_id`);
    const lastMs = new Map(last.rows.map((x) => [x.requirement_id as string, new Date(x.at as string).getTime()]));
    const next = nextSample(buildSchedule(reqs, lot), plannedTaken, timedDue(reqs, lastMs, new Date()));
    const problems = plannedViolations(next, sent, (rid) => reqs.find((q) => q.id === rid)?.name ?? rid);
    if (problems.length) throw new ApiError(409, 'inspection_rule', problems.join('; '));
    return next!.trigger;
  }

  /** Records a correction of a reading (a new row; the original is kept). */
  correct(ctx: RequestContext, measurementId: string, body: z.infer<typeof CorrectionBody>): Promise<InspectionDetail> {
    return this.database.asUser(ctx, async (db) => {
      const orig = await db.execute<Row>(sql`select * from public.inspection_measurements where id = ${measurementId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!orig.rows.length) throw ApiError.notFound('measurement_not_found', 'Reading not found');
      const m = orig.rows[0];
      const gaugeId = body.gaugeId !== undefined ? body.gaugeId : (m.gauge_id as string | null);
      await db.execute(sql`insert into public.inspection_measurements
        (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, value_pass, gauge_id, gauge_override_reason,
         supersedes_id, correction_reason, retest_of_id)
        values (${orgOf(ctx)}::uuid, ${m.inspection_record_id as string}::uuid, ${m.sample_id as string}::uuid, ${m.requirement_id as string}::uuid,
                ${body.valueNumeric ?? null}::numeric, ${body.valuePass ?? null}, ${gaugeId}::uuid,
                ${body.gaugeOverrideReason ?? (body.gaugeId === undefined ? ((m.gauge_override_reason as string) ?? null) : null)},
                ${measurementId}::uuid, ${body.reason}, ${(m.retest_of_id as string) ?? null}::uuid)`);
      return this.load(db, ctx, m.inspection_record_id as string);
    });
  }

  complete(ctx: RequestContext, id: string): Promise<InspectionDetail> {
    return this.setStatus(ctx, id, sql`status = 'completed'`, (db) => this.assertPlannedSamplesDone(db, id));
  }

  abandon(ctx: RequestContext, id: string, body: z.infer<typeof AbandonBody>): Promise<InspectionDetail> {
    return this.setStatus(ctx, id, sql`status = 'abandoned', abandon_reason = ${body.reason}`);
  }

  private setStatus(ctx: RequestContext, id: string, set: SQL, before?: (db: Db) => Promise<void>): Promise<InspectionDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.requireRecord(db, ctx, id);
      await before?.(db);
      const result = await db.execute(sql`update public.inspection_records set ${set} where id = ${id}::uuid returning id`);
      // Visible but not updatable (row level security): the caller may only read.
      if (!result.rows.length) throw ApiError.forbidden();
      return this.load(db, ctx, id);
    });
  }

  private async requireRecord(db: Db, ctx: RequestContext, id: string) {
    const result = await db.execute(sql`select 1 from public.inspection_records where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
    if (!result.rows.length) throw ApiError.notFound('inspection_not_found', 'Inspection not found');
  }

  private async load(db: Db, ctx: RequestContext, id: string): Promise<InspectionDetail> {
    const rec = await db.execute<Row>(sql`${sql.raw(SUMMARY_SELECT)} where r.organisation_id = ${orgOf(ctx)}::uuid and r.id = ${id}::uuid`);
    if (!rec.rows.length) throw ApiError.notFound('inspection_not_found', 'Inspection not found');
    const r = rec.rows[0];
    const reqs = await db.execute<Row>(sql`select * from public.resolved_inspection_requirements where inspection_record_id = ${id}::uuid order by sequence`);
    const samples = await db.execute<Row>(sql`select s.*, ${sql.raw(personName('pp'))} as taken_by_name from public.inspection_samples s
      left join public.profiles pp on pp.id = s.created_by where s.inspection_record_id = ${id}::uuid order by s.sample_number`);
    const readings = await db.execute<Row>(sql`select m.*, m.value_numeric::text as value_text, m.gauge_next_due_on::text as gauge_due_text, ${sql.raw(personName('pp'))} as measured_by_name,
        (select c.id from public.inspection_measurements c where c.supersedes_id = m.id) as superseded_by_id
      from public.inspection_measurements m left join public.profiles pp on pp.id = m.created_by
      where m.inspection_record_id = ${id}::uuid order by m.measured_at, m.id`);
    return {
      ...toSummary(r),
      notes: (r.notes as string) ?? null,
      completedAt: iso(r.completed_at),
      completedBy: person(r.completed_by, r.completed_by_name),
      abandonReason: (r.abandon_reason as string) ?? null,
      requirements: reqs.rows.map((q) => ({
        id: q.id as string,
        sequence: Number(q.sequence),
        characteristicKey: q.characteristic_key as string,
        charNumber: (q.char_number as string) ?? null,
        name: q.name as string,
        operationCode: q.operation_code as string,
        dataType: q.data_type as 'variable' | 'attribute',
        valueSource: q.value_source as 'plan' | 'part_spec',
        specKey: (q.spec_key as string) ?? null,
        applicable: q.applicable as boolean,
        applicability: q.applicability as string,
        nominal: num(q.nominal),
        lowerLimit: num(q.lower_limit),
        upperLimit: num(q.upper_limit),
        unitCode: (q.unit_code as string) ?? null,
        method: (q.method as string) ?? null,
        gaugeType: q.gauge_type_id ? { id: q.gauge_type_id as string, name: (q.gauge_type_name as string) ?? '' } : null,
        criticality: q.criticality as 'critical' | 'major' | 'minor',
        spcEligible: q.spc_eligible as boolean,
        chartType: (q.chart_type as 'imr' | 'xbar_r') ?? null,
        subgroupSize: q.subgroup_size === null ? null : Number(q.subgroup_size),
        decimals: q.decimals === null ? null : Number(q.decimals),
        sampling: (q.sampling as never) ?? [],
        reactions: (q.reactions as never) ?? [],
      })),
      schedule: (buildSchedule(
        reqs.rows.map((q) => ({ id: q.id as string, name: q.name as string, charNumber: (q.char_number as string) ?? null, applicable: q.applicable as boolean, sampling: ((q.sampling as never) ?? []) as PlanRequirement['sampling'] })),
        r.lot_size == null ? null : Number(r.lot_size),
      ) as InspectionDetail['schedule']),
      samples: samples.rows.map((s) => ({
        id: s.id as string,
        sampleNumber: Number(s.sample_number),
        sampledAt: iso(s.sampled_at)!,
        unitReference: (s.unit_reference as string) ?? null,
        triggerType: s.trigger_type as InspectionSummary['triggerType'],
        isRetest: s.is_retest as boolean,
        notes: (s.notes as string) ?? null,
        takenBy: person(s.created_by, s.taken_by_name),
      })),
      measurements: readings.rows.map((m) => ({
        id: m.id as string,
        sampleId: m.sample_id as string,
        requirementId: m.requirement_id as string,
        valueNumeric: (m.value_text as string) ?? null,
        valuePass: (m.value_pass as boolean) ?? null,
        unitCode: (m.unit_code as string) ?? null,
        result: m.result as 'pass' | 'fail',
        gauge: m.gauge_id
          ? {
              id: m.gauge_id as string,
              assetNumber: m.gauge_asset_number as string,
              status: m.gauge_status as string,
              nextDueOn: (m.gauge_due_text as string) ?? null,
              valid: m.gauge_valid as boolean,
            }
          : null,
        gaugeOverrideReason: (m.gauge_override_reason as string) ?? null,
        measuredAt: iso(m.measured_at)!,
        measuredBy: person(m.created_by, m.measured_by_name),
        supersedesId: (m.supersedes_id as string) ?? null,
        supersededById: (m.superseded_by_id as string) ?? null,
        correctionReason: (m.correction_reason as string) ?? null,
        retestOfId: (m.retest_of_id as string) ?? null,
        notes: (m.notes as string) ?? null,
      })),
    };
  }
}
