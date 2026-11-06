import { HttpStatus, Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { iso, personName, Row } from '../calibration/calibration.service';
import { DatabaseService, Db } from '../database/database.service';
import { BaselineQuery, Baseline, Chart, ChartQuery, CharacteristicsQuery, CreateBaselineBody } from './spc.schemas';
import { controlLimits, isProvisional, Limits, MINIMUM_POINTS, Rule } from './spc';
import { assemble, ChartPoint, evaluate, parseRules, ReadingRow } from './spc-data';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const MAX_READINGS = 20000;

const toBaseline = (r: Row): Baseline => ({
  id: r.id as string,
  partId: r.part_id as string,
  characteristicKey: r.characteristic_key as string,
  operationCode: (r.operation_code as string) ?? null,
  chartType: r.chart_type as Baseline['chartType'],
  subgroupSize: Number(r.subgroup_size),
  unitCode: (r.unit_code as string) ?? null,
  windowFrom: iso(r.window_from)!,
  windowTo: iso(r.window_to)!,
  points: Number(r.n_points),
  provisional: r.provisional as boolean,
  spec: { nominal: numOrNull(r.spec_nominal), lower: numOrNull(r.spec_lower), upper: numOrNull(r.spec_upper) },
  limits: {
    centre: Number(r.centre),
    ucl: Number(r.ucl),
    lcl: Number(r.lcl),
    dispersionCentre: Number(r.dispersion_centre),
    dispersionUcl: Number(r.dispersion_ucl),
    dispersionLcl: Number(r.dispersion_lcl),
    sigma: Number(r.sigma),
  },
  rules: r.rules as Rule[],
  notes: (r.notes as string) ?? null,
  createdAt: iso(r.created_at)!,
  createdBy: r.created_by ? { id: r.created_by as string, name: (r.created_by_name as string) || 'Unknown user' } : null,
  supersededAt: iso(r.superseded_at),
  supersededBy: (r.superseded_by as string) ?? null,
});

const BASELINE_SELECT = sql.raw(`select b.*, b.n_points, b.spec_nominal::float8 as spec_nominal, b.spec_lower::float8 as spec_lower, b.spec_upper::float8 as spec_upper,
  b.centre::float8 as centre, b.ucl::float8 as ucl, b.lcl::float8 as lcl, b.dispersion_centre::float8 as dispersion_centre,
  b.dispersion_ucl::float8 as dispersion_ucl, b.dispersion_lcl::float8 as dispersion_lcl, b.sigma::float8 as sigma,
  ${personName('pc')} as created_by_name
  from public.spc_baselines b left join public.profiles pc on pc.id = b.created_by`);

/**
 * SPC control charts. Charts read inspection_measurements live (nothing is copied), only compatible data
 * is charted (one part, characteristic, operation, unit, chart type, specification) and what was left out
 * is reported. Row-level security applies: a user sees only readings of inspections they may read.
 */
@Injectable()
export class SpcService {
  constructor(private readonly database: DatabaseService) {}

  /** Characteristics of a part that have numeric readings and are marked for SPC in the plan. */
  characteristics(ctx: RequestContext, q: z.infer<typeof CharacteristicsQuery>) {
    return this.database.asUser(ctx, async (db) => {
      await this.requirePart(db, ctx, q.partId);
      const r = await db.execute<Row>(sql`
        select q.characteristic_key, q.operation_code, count(*) as readings, max(m.measured_at) as last_at,
               (array_agg(q.name order by m.measured_at desc))[1] as name,
               (array_agg(q.chart_type order by m.measured_at desc))[1] as chart_type,
               (array_agg(q.subgroup_size order by m.measured_at desc))[1] as subgroup_size,
               (array_agg(q.unit_code order by m.measured_at desc))[1] as unit_code,
               exists (select 1 from public.spc_baselines b where b.organisation_id = ${orgOf(ctx)}::uuid and b.part_id = ${q.partId}::uuid
                         and b.characteristic_key = q.characteristic_key and b.operation_code = q.operation_code and b.superseded_at is null) as has_baseline
        from public.inspection_measurements m
        join public.inspection_records r on r.id = m.inspection_record_id
        join public.resolved_inspection_requirements q on q.id = m.requirement_id
        where m.organisation_id = ${orgOf(ctx)}::uuid and r.part_id = ${q.partId}::uuid and q.spc_eligible and q.data_type = 'variable'
          and m.value_numeric is not null and not exists (select 1 from public.inspection_measurements c where c.supersedes_id = m.id)
        group by q.characteristic_key, q.operation_code order by q.characteristic_key, q.operation_code`);
      return r.rows.map((x) => ({
        key: x.characteristic_key as string,
        name: x.name as string,
        operationCode: x.operation_code as string,
        chartType: (x.chart_type as 'imr' | 'xbar_r') ?? null,
        subgroupSize: numOrNull(x.subgroup_size),
        unitCode: (x.unit_code as string) ?? null,
        readings: Number(x.readings),
        lastMeasuredAt: iso(x.last_at),
        hasBaseline: x.has_baseline as boolean,
      }));
    });
  }

  chart(ctx: RequestContext, q: z.infer<typeof ChartQuery>): Promise<Chart> {
    return this.database.asUser(ctx, async (db) => {
      const part = await this.requirePart(db, ctx, q.partId);
      const operationCode = await this.resolveOperation(db, ctx, q.partId, q.characteristicKey, q.operationCode);
      const rows = await this.readings(db, ctx, { ...q, operationCode });
      const data = assemble(rows);

      const baselines = data.chartType
        ? await db.execute<Row>(sql`${BASELINE_SELECT} where b.organisation_id = ${orgOf(ctx)}::uuid and b.part_id = ${q.partId}::uuid
            and b.characteristic_key = ${q.characteristicKey} and b.operation_code = ${operationCode} and b.chart_type = ${data.chartType} and b.superseded_at is null`)
        : { rows: [] as Row[] };
      const baseline = baselines.rows[0] ? toBaseline(baselines.rows[0]) : null;
      let usable: Baseline | null = baseline;
      let baselineIssue: string | null = null;
      if (baseline && (baseline.subgroupSize !== data.subgroupSize || baseline.unitCode !== data.unitCode)) {
        usable = null;
        baselineIssue = 'The saved baseline was made with a different subgroup size or unit, so it is not used. Save a new baseline.';
      } else if (!baseline && data.chartType) {
        const old = await db.execute<Row>(sql`select 1 from public.spc_baselines where organisation_id = ${orgOf(ctx)}::uuid and part_id = ${q.partId}::uuid
          and characteristic_key = ${q.characteristicKey} and operation_code = ${operationCode} and superseded_at is null`);
        if (old.rows.length) baselineIssue = 'The saved baseline is for a different chart type, so it is not used. Save a new baseline.';
      }

      const rules = parseRules(q.rules);
      const result = evaluate(data, usable ? usable.limits : null, rules);
      if (usable && usable.spec && data.spec.nominal !== null && (usable.spec.lower !== data.spec.lower || usable.spec.upper !== data.spec.upper)) {
        result.warnings.push('The specification has changed since the baseline was saved.');
      }

      const latest = await db.execute<Row>(sql`select q.name, q.reactions from public.inspection_measurements m
        join public.resolved_inspection_requirements q on q.id = m.requirement_id join public.inspection_records r on r.id = m.inspection_record_id
        where m.organisation_id = ${orgOf(ctx)}::uuid and r.part_id = ${q.partId}::uuid and q.characteristic_key = ${q.characteristicKey} and q.operation_code = ${operationCode}
        order by m.measured_at desc limit 1`);
      const reactions = ((latest.rows[0]?.reactions as { triggerType: string; action: string; instruction: string }[]) ?? [])
        .filter((x) => x.triggerType === 'spc_signal' && x.instruction)
        .map((x) => ({ action: x.action, instruction: x.instruction }));

      return {
        part,
        characteristic: {
          key: q.characteristicKey,
          name: (latest.rows[0]?.name as string) ?? null,
          operationCode,
          chartType: data.chartType,
          subgroupSize: data.subgroupSize,
          unitCode: data.unitCode,
        },
        spec: data.spec,
        points: data.points,
        limitsSource: result.limitsSource,
        limits: result.limits,
        provisional: result.provisional,
        rules,
        signals: result.signals,
        dispersionSignals: result.dispersionSignals,
        noVariation: result.noVariation,
        warnings: result.warnings,
        excluded: data.excluded,
        baseline: usable,
        baselineIssue,
        reactions,
      };
    });
  }

  baselines(ctx: RequestContext, q: z.infer<typeof BaselineQuery>): Promise<Baseline[]> {
    return this.database.asUser(ctx, async (db) => {
      await this.requirePart(db, ctx, q.partId);
      const op = q.operationCode ? sql`and b.operation_code = ${q.operationCode}` : sql``;
      const r = await db.execute<Row>(sql`${BASELINE_SELECT} where b.organisation_id = ${orgOf(ctx)}::uuid and b.part_id = ${q.partId}::uuid
        and b.characteristic_key = ${q.characteristicKey} ${op} order by b.created_at desc`);
      return r.rows.map(toBaseline);
    });
  }

  /** Calculates limits from the chosen window of all compatible data and saves them (the previous baseline is superseded by the database). */
  createBaseline(ctx: RequestContext, body: z.infer<typeof CreateBaselineBody>): Promise<Baseline> {
    return this.database.asUser(ctx, async (db) => {
      await this.requirePart(db, ctx, body.partId);
      const rows = await this.readings(db, ctx, { partId: body.partId, characteristicKey: body.characteristicKey, operationCode: body.operationCode });
      const data = assemble(rows);
      if (!data.chartType || data.subgroupSize === null) throw rule('There are no chartable readings for this characteristic.');
      let points: ChartPoint[] = data.points;
      if (body.firstN) points = points.slice(0, body.firstN);
      else points = points.filter((p) => (!body.from || p.at >= body.from) && (!body.to || p.at <= body.to));
      if (points.length < MINIMUM_POINTS) {
        throw rule(`A baseline needs at least ${MINIMUM_POINTS} ${data.chartType === 'imr' ? 'readings' : 'complete subgroups'}; the chosen window has ${points.length}.`);
      }
      const limits: Limits = controlLimits(data.chartType, points.map((p) => p.readings.map((r) => Number(r.value))));
      const ids = points.flatMap((p) => p.readings.map((r) => r.id));
      const inserted = await db.execute<{ id: string }>(sql`insert into public.spc_baselines
        (organisation_id, part_id, characteristic_key, operation_code, chart_type, subgroup_size, unit_code, window_from, window_to, n_points, provisional,
         measurement_ids, spec_nominal, spec_lower, spec_upper, centre, ucl, lcl, dispersion_centre, dispersion_ucl, dispersion_lcl, sigma, rules, notes)
        values (${orgOf(ctx)}::uuid, ${body.partId}::uuid, ${body.characteristicKey}, ${body.operationCode}, ${data.chartType}, ${data.subgroupSize}, ${data.unitCode},
                ${points[0].at}::timestamptz, ${points[points.length - 1].at}::timestamptz, ${points.length}, ${isProvisional(data.chartType, points.length)},
                string_to_array(${ids.join(',')}, ',')::uuid[], ${data.spec.nominal}::numeric, ${data.spec.lower}::numeric, ${data.spec.upper}::numeric,
                ${limits.centre}::numeric, ${limits.ucl}::numeric, ${limits.lcl}::numeric, ${limits.dispersionCentre}::numeric, ${limits.dispersionUcl}::numeric,
                ${limits.dispersionLcl}::numeric, ${limits.sigma}::numeric, string_to_array(${body.rules.join(',')}, ',')::text[], ${body.notes ?? null})
        returning id`);
      const r = await db.execute<Row>(sql`${BASELINE_SELECT} where b.id = ${inserted.rows[0].id}::uuid`);
      return toBaseline(r.rows[0]);
    });
  }

  // ---- helpers ------------------------------------------------------------------------------

  private async requirePart(db: Db, ctx: RequestContext, partId: string) {
    const r = await db.execute<Row>(sql`select id, part_number, name from public.parts where id = ${partId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
    if (!r.rows.length) throw ApiError.notFound('part_not_found', 'Part not found');
    return { id: r.rows[0].id as string, partNumber: r.rows[0].part_number as string, name: r.rows[0].name as string };
  }

  /** One chart is for one operation: use the one asked for, the only one there is, or ask. */
  private async resolveOperation(db: Db, ctx: RequestContext, partId: string, key: string, asked?: string): Promise<string> {
    const r = await db.execute<Row>(sql`select distinct q.operation_code from public.inspection_measurements m
      join public.inspection_records r on r.id = m.inspection_record_id join public.resolved_inspection_requirements q on q.id = m.requirement_id
      where m.organisation_id = ${orgOf(ctx)}::uuid and r.part_id = ${partId}::uuid and q.characteristic_key = ${key} order by 1`);
    const ops = r.rows.map((x) => x.operation_code as string);
    if (asked) return asked;
    if (ops.length === 1) return ops[0];
    if (ops.length === 0) throw ApiError.notFound('no_readings', 'There are no readings for this characteristic');
    throw ApiError.badRequest('operation_required', 'This characteristic is measured in more than one operation: choose one', { operations: ops });
  }

  private async readings(
    db: Db,
    ctx: RequestContext,
    f: { partId: string; characteristicKey: string; operationCode: string; from?: string; to?: string; machineId?: string; lot?: string },
  ): Promise<ReadingRow[]> {
    const where: SQL[] = [
      sql`m.organisation_id = ${orgOf(ctx)}::uuid`,
      sql`r.part_id = ${f.partId}::uuid`,
      sql`q.characteristic_key = ${f.characteristicKey}`,
      sql`q.operation_code = ${f.operationCode}`,
      sql`q.spc_eligible and q.data_type = 'variable' and m.value_numeric is not null`,
      sql`not exists (select 1 from public.inspection_measurements c where c.supersedes_id = m.id)`,
    ];
    if (f.from) where.push(sql`m.measured_at >= ${f.from}::timestamptz`);
    if (f.to) where.push(sql`m.measured_at <= ${f.to}::timestamptz`);
    if (f.machineId) where.push(sql`r.machine_id = ${f.machineId}::uuid`);
    if (f.lot) where.push(sql`r.lot = ${f.lot}`);
    const result = await db.execute<Row>(sql`
      select m.id, m.value_numeric::text as value, m.measured_at, s.sample_number, s.subgroup_number, s.is_retest,
             r.id as inspection_id, r.reference, r.status, r.machine_id, r.lot,
             q.unit_code, q.chart_type, q.subgroup_size, q.nominal::float8 as nominal, q.lower_limit::float8 as lower_limit, q.upper_limit::float8 as upper_limit,
             (m.gauge_override_reason is not null) as gauge_override
      from public.inspection_measurements m
      join public.inspection_samples s on s.id = m.sample_id
      join public.inspection_records r on r.id = m.inspection_record_id
      join public.resolved_inspection_requirements q on q.id = m.requirement_id
      where ${sql.join(where, sql` and `)} order by m.measured_at, s.sample_number limit ${MAX_READINGS}`);
    return result.rows.map((x) => ({
      id: x.id as string,
      value: x.value as string,
      measuredAt: iso(x.measured_at)!,
      sampleNumber: Number(x.sample_number),
      subgroupNumber: numOrNull(x.subgroup_number),
      isRetest: x.is_retest as boolean,
      inspectionId: x.inspection_id as string,
      inspectionReference: x.reference as string,
      inspectionStatus: x.status as ReadingRow['inspectionStatus'],
      unitCode: (x.unit_code as string) ?? null,
      chartType: (x.chart_type as ReadingRow['chartType']) ?? null,
      subgroupSize: numOrNull(x.subgroup_size),
      nominal: numOrNull(x.nominal),
      lower: numOrNull(x.lower_limit),
      upper: numOrNull(x.upper_limit),
      machineId: (x.machine_id as string) ?? null,
      lot: (x.lot as string) ?? null,
      gaugeOverride: x.gauge_override as boolean,
    }));
  }
}

const rule = (message: string) => new ApiError(HttpStatus.CONFLICT, 'spc_rule', message);
