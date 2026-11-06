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
  AcknowledgeBody,
  AddSampleBody,
  AddToNcrBody,
  CorrectionBody,
  DraftQuery,
  GaugeUsage,
  InspectionDetail,
  InspectionListQuery,
  InspectionSummary,
  NcDraft,
  NcrInspectionSource,
  NcrRef,
  RaiseNcrBody,
  StartInspectionBody,
} from './inspection.schemas';
import { buildNcDraft, isCurrent, limitsText } from './ncr-draft';

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
        (organisation_id, inspection_record_id, unit_reference, trigger_type, is_retest, notes, subgroup_number)
        values (${orgOf(ctx)}::uuid, ${id}::uuid, ${body.unitReference ?? null}, ${trigger}, ${body.isRetest ?? false}, ${body.notes ?? null},
                ${body.newSubgroup && !body.isRetest ? sql`(select coalesce(max(subgroup_number), 0) + 1 from public.inspection_samples where inspection_record_id = ${id}::uuid)` : sql`null`})
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

  // ---- NC integration (PC5) ----------------------------------------------------------------

  /** The suggested NC for some failed readings (default: current failures that have no NC yet). */
  ncrDraft(ctx: RequestContext, id: string, q: z.infer<typeof DraftQuery>): Promise<NcDraft> {
    return this.database.asUser(ctx, async (db) => {
      const inspection = await this.load(db, ctx, id);
      const ids = q.measurementIds ?? inspection.measurements.filter((m) => m.result === 'fail' && isCurrent(m) && m.ncrs.length === 0).map((m) => m.id);
      const failed = new Set(inspection.measurements.filter((m) => m.result === 'fail').map((m) => m.id));
      if (ids.some((x) => !failed.has(x))) throw ApiError.badRequest('invalid_reference', 'Only failed readings of this inspection can be chosen');
      return buildNcDraft(inspection, ids);
    });
  }

  /** Creates the NC and links the readings in one transaction (app.raise_ncr_from_inspection). */
  raiseNcr(ctx: RequestContext, id: string, body: z.infer<typeof RaiseNcrBody>): Promise<{ ncr: { id: string; reference: string; stage: string; source: string }; inspection: InspectionDetail }> {
    return this.database.asUser(ctx, async (db) => {
      await this.requireRecord(db, ctx, id);
      const ids = body.measurementIds.length ? body.measurementIds.join(',') : '';
      const result = await db.execute<{ id: string }>(sql`select app.raise_ncr_from_inspection(
        ${id}::uuid, string_to_array(${ids}, ',')::uuid[] , ${body.title}, ${body.description ?? null}, ${body.severity ?? null},
        ${body.quantityAffected ?? null}::numeric, ${body.requirement ?? null}, ${body.actualResult ?? null}, ${body.open ?? false}) as id`);
      const ncr = await db.execute<Row>(sql`select id, reference, stage, source from public.nonconformances where id = ${result.rows[0].id}::uuid`);
      const n = ncr.rows[0];
      return {
        ncr: { id: n.id as string, reference: n.reference as string, stage: n.stage as string, source: n.source as string },
        inspection: await this.load(db, ctx, id),
      };
    });
  }

  /** Links more failed readings of this inspection to an NC raised from it (the database refuses closed or cancelled NCs). */
  addToNcr(ctx: RequestContext, id: string, body: z.infer<typeof AddToNcrBody>): Promise<InspectionDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.requireRecord(db, ctx, id);
      const ids = [...new Set(body.measurementIds)];
      const own = await db.execute<Row>(sql`select count(*) as n from public.inspection_measurements
        where inspection_record_id = ${id}::uuid and id = any (string_to_array(${ids.join(',')}, ',')::uuid[])`);
      if (Number(own.rows[0].n) !== ids.length) throw ApiError.badRequest('invalid_reference', 'Choose failed readings of this inspection');
      await db.execute(sql`select app.add_readings_to_ncr(${body.ncrId}::uuid, string_to_array(${ids.join(',')}, ',')::uuid[], ${body.quantityAffected ?? null}::numeric)`);
      return this.load(db, ctx, id);
    });
  }

  acknowledge(ctx: RequestContext, measurementId: string, body: z.infer<typeof AcknowledgeBody>): Promise<InspectionDetail> {
    return this.database.asUser(ctx, async (db) => {
      const m = await db.execute<Row>(sql`select inspection_record_id from public.inspection_measurements where id = ${measurementId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!m.rows.length) throw ApiError.notFound('measurement_not_found', 'Reading not found');
      const record = m.rows[0].inspection_record_id as string;
      await db.execute(sql`insert into public.inspection_failure_acknowledgements (organisation_id, inspection_record_id, measurement_id, note)
        values (${orgOf(ctx)}::uuid, ${record}::uuid, ${measurementId}::uuid, ${body.note})`);
      return this.load(db, ctx, record);
    });
  }

  /** The inspections and readings behind a non-conformance raised from inspections (those the caller may read). */
  ncrSource(ctx: RequestContext, ncrId: string): Promise<z.infer<typeof NcrInspectionSource>> {
    return this.database.asUser(ctx, async (db) => {
      const ncr = await db.execute(sql`select 1 from public.nonconformances where id = ${ncrId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!ncr.rows.length) throw ApiError.notFound('ncr_not_found', 'Non-conformance not found');
      const links = await db.execute<Row>(sql`select inspection_record_id, measurement_id from public.inspection_ncr_links
        where nonconformance_id = ${ncrId}::uuid and organisation_id = ${orgOf(ctx)}::uuid order by created_at, id`);
      const out: z.infer<typeof NcrInspectionSource>['inspections'] = [];
      for (const recordId of [...new Set(links.rows.map((l) => l.inspection_record_id as string))]) {
        const insp = await this.load(db, ctx, recordId);
        const wanted = links.rows.filter((l) => l.inspection_record_id === recordId && l.measurement_id).map((l) => l.measurement_id as string);
        const reqById = new Map(insp.requirements.map((q) => [q.id, q]));
        const sampleNo = new Map(insp.samples.map((x) => [x.id, x.sampleNumber]));
        const finalOf = (m: InspectionDetail['measurements'][number]) => {
          let cur = m;
          while (cur.supersededById) {
            const next = insp.measurements.find((x) => x.id === cur.supersededById);
            if (!next) break;
            cur = next;
          }
          return cur;
        };
        out.push({
          id: insp.id,
          reference: insp.reference,
          status: insp.status,
          result: insp.result,
          part: insp.part,
          plan: insp.plan,
          operationCode: insp.operationCode,
          startedAt: insp.startedAt,
          wholeInspection: links.rows.some((l) => l.inspection_record_id === recordId && !l.measurement_id),
          readings: wanted.flatMap((mid) => {
            const m = insp.measurements.find((x) => x.id === mid);
            if (!m) return [];
            const q = reqById.get(m.requirementId)!;
            const last = finalOf(m);
            return [
              {
                id: m.id,
                requirementName: q.name,
                sampleNumber: sampleNo.get(m.sampleId) ?? 0,
                valueNumeric: m.valueNumeric,
                valuePass: m.valuePass,
                unitCode: m.unitCode,
                limits: limitsText(q),
                result: m.result,
                measuredAt: m.measuredAt,
                gaugeAssetNumber: m.gauge?.assetNumber ?? null,
                correctedTo: last.id === m.id ? null : { valueNumeric: last.valueNumeric, valuePass: last.valuePass, result: last.result, reason: last.correctionReason },
              },
            ];
          }),
        });
      }
      return { inspections: out };
    });
  }

  /** Which inspections used a gauge since its previous calibration (impact assessment; reads only). */
  gaugeUsage(ctx: RequestContext, calibrationId: string): Promise<z.infer<typeof GaugeUsage>> {
    return this.database.asUser(ctx, async (db) => {
      const cal = await db.execute<Row>(sql`select c.id, c.reference, c.gauge_id, c.calibrated_on::text as calibrated_on, c.outcome, g.asset_number
        from public.calibrations c join public.gauges g on g.id = c.gauge_id
        where c.id = ${calibrationId}::uuid and c.organisation_id = ${orgOf(ctx)}::uuid`);
      if (!cal.rows.length) throw ApiError.notFound('calibration_not_found', 'Calibration record not found');
      const c = cal.rows[0];
      const prev = await db.execute<Row>(sql`select reference, calibrated_on::text as calibrated_on from public.calibrations
        where gauge_id = ${c.gauge_id as string}::uuid and deleted_at is null and id <> ${calibrationId}::uuid
          and (calibrated_on, created_at) < (${c.calibrated_on as string}::date, (select created_at from public.calibrations where id = ${calibrationId}::uuid))
        order by calibrated_on desc, created_at desc limit 1`);
      const p = prev.rows[0];
      const usage = await db.execute<Row>(sql`select * from app.gauge_usage(
        ${c.gauge_id as string}::uuid, ${p ? sql`(${p.calibrated_on as string}::date)::timestamptz` : sql`null`},
        ((${c.calibrated_on as string}::date) + 1)::timestamptz)`);
      const inspections = usage.rows.map((u) => ({
        id: u.inspection_record_id as string,
        reference: u.reference as string,
        status: u.status as string,
        partNumber: u.part_number as string,
        readings: Number(u.readings),
        failedReadings: Number(u.failed_readings),
        overrides: Number(u.overrides),
        firstUsed: iso(u.first_used)!,
        lastUsed: iso(u.last_used)!,
      }));
      return {
        calibration: { id: c.id as string, reference: c.reference as string, calibratedOn: c.calibrated_on as string, outcome: c.outcome as string },
        gauge: { id: c.gauge_id as string, assetNumber: c.asset_number as string },
        previous: p ? { reference: p.reference as string, calibratedOn: p.calibrated_on as string } : null,
        inspections,
        totals: {
          inspections: inspections.length,
          readings: inspections.reduce((n, i) => n + i.readings, 0),
          failedReadings: inspections.reduce((n, i) => n + i.failedReadings, 0),
        },
      };
    });
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
    const acks = await db.execute<Row>(sql`select a.measurement_id, a.note, a.acknowledged_at, a.created_by, ${sql.raw(personName('pp'))} as by_name
      from public.inspection_failure_acknowledgements a left join public.profiles pp on pp.id = a.created_by
      where a.inspection_record_id = ${id}::uuid`);
    // Only NCs the caller may read are named (row level security hides the others).
    const links = await db.execute<Row>(sql`select l.measurement_id, n.id as ncr_id, n.reference, n.stage, n.title, n.quantity_affected
      from public.inspection_ncr_links l join public.nonconformances n on n.id = l.nonconformance_id
      where l.inspection_record_id = ${id}::uuid order by n.created_at, n.id`);
    const ncrOf = (l: Row): NcrRef => ({ id: l.ncr_id as string, reference: l.reference as string, stage: l.stage as string, title: l.title as string, quantityAffected: l.quantity_affected === null ? null : Number(l.quantity_affected) });
    const allNcrs = new Map<string, NcrRef>();
    for (const l of links.rows) allNcrs.set(l.ncr_id as string, ncrOf(l));
    return {
      ...toSummary(r),
      ncrs: [...allNcrs.values()],
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
        subgroupNumber: s.subgroup_number === null || s.subgroup_number === undefined ? null : Number(s.subgroup_number),
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
        acknowledgement: (() => {
          const a = acks.rows.find((x) => x.measurement_id === m.id);
          return a ? { note: a.note as string, at: iso(a.acknowledged_at)!, by: person(a.created_by, a.by_name) } : null;
        })(),
        ncrs: links.rows.filter((l) => l.measurement_id === m.id).map(ncrOf),
      })),
    };
  }
}
