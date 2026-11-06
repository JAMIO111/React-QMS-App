import { HttpStatus, Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { iso, personName, Row } from '../calibration/calibration.service';
import { DatabaseService, Db } from '../database/database.service';
import { BaselineQuery, Baseline, Chart, ChartQuery, CharacteristicsQuery, CreateBaselineBody } from './spc.schemas';
import { controlLimits, countRate, defectsKind, isProvisional, Limits, MINIMUM_POINTS, pBar, PROVISIONAL_BELOW, Rule, RULE_TEXT } from './spc';
import { applySubgroupSize, assemble, assembleDefects, assembleP, BASIS_TEXT, ChartPoint, evaluate, evaluateCount, evaluateP, parseRules, ReadingRow, SubgroupBasis } from './spc-data';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const MAX_READINGS = 20000;

const toBaseline = (r: Row): Baseline => ({
  id: r.id as string,
  partId: r.part_id as string,
  characteristicKey: r.characteristic_key as string,
  operationCode: (r.operation_code as string) ?? null,
  chartType: r.chart_type as Baseline['chartType'],
  subgroupSize: numOrNull(r.subgroup_size),
  subgroupBasis: (r.subgroup_basis as Baseline['subgroupBasis']) ?? null,
  meanSubgroupSize: numOrNull(r.mean_subgroup_size),
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
    dispersionCentre: numOrNull(r.dispersion_centre),
    dispersionUcl: numOrNull(r.dispersion_ucl),
    dispersionLcl: numOrNull(r.dispersion_lcl),
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
  b.mean_subgroup_size::float8 as mean_subgroup_size,
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
        where m.organisation_id = ${orgOf(ctx)}::uuid and r.part_id = ${q.partId}::uuid and q.spc_eligible
          and ((q.data_type = 'variable' and m.value_numeric is not null) or (q.data_type = 'attribute' and m.value_pass is not null) or (q.data_type = 'count' and m.value_count is not null)) and not exists (select 1 from public.inspection_measurements c where c.supersedes_id = m.id)
        group by q.characteristic_key, q.operation_code order by q.characteristic_key, q.operation_code`);
      return r.rows.map((x) => ({
        key: x.characteristic_key as string,
        name: x.name as string,
        operationCode: x.operation_code as string,
        chartType: (x.chart_type as 'imr' | 'xbar_r' | 'p' | 'defects') ?? null,
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
      if (isCountRows(rows)) return this.countChart(db, ctx, q, part, operationCode, rows, 'defects');
      if (isPRows(rows)) return q.display === 'np' ? this.countChart(db, ctx, q, part, operationCode, rows, 'np') : this.pChart(db, ctx, q, part, operationCode, rows);
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

      // Absent rules: those saved with the baseline in use, else all of them.
      const rules = q.rules !== undefined ? parseRules(q.rules) : usable ? usable.rules : parseRules(undefined);
      const result = evaluate(data, usable ? (usable.limits as Limits) : null, rules);
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
      if (isCountRows(rows)) return this.createCountBaseline(db, ctx, body, rows);
      if (isPRows(rows)) return this.createPBaseline(db, ctx, body, rows);
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

  /**
   * Where the processes stand: every characteristic with readings in the last `lookbackDays` (most recent first,
   * at most `maxCharts`) is evaluated like its chart (saved baseline, else trial limits) and the signals raised by
   * points from the last `days` days are collected. Needs spc.read; without it `available` is false.
   */
  overview(ctx: RequestContext, opts: { days: number; maxCharts: number; maxRecent: number }): Promise<SpcOverview> {
    return this.database.asUser(ctx, async (db) => {
      const empty: SpcOverview = { available: false, windowDays: opts.days, monitored: 0, withSignals: 0, withoutBaseline: 0, signalCount: 0, byRule: [], recent: [] };
      const allowed = await db.execute<Row>(sql`select app.has_permission(${orgOf(ctx)}::uuid, 'spc.read') as ok`);
      if (!allowed.rows[0]?.ok) return empty;
      const groups = await db.execute<Row>(sql`
        select r.part_id, p.part_number, p.name as part_name, q.characteristic_key, q.operation_code,
               (array_agg(q.name order by m.measured_at desc))[1] as name, max(m.measured_at) as last_at
        from public.inspection_measurements m
        join public.inspection_records r on r.id = m.inspection_record_id
        join public.parts p on p.id = r.part_id
        join public.resolved_inspection_requirements q on q.id = m.requirement_id
        where m.organisation_id = ${orgOf(ctx)}::uuid and q.spc_eligible
          and ((q.data_type = 'variable' and m.value_numeric is not null) or (q.data_type = 'attribute' and m.value_pass is not null) or (q.data_type = 'count' and m.value_count is not null))
          and m.measured_at >= now() - interval '90 days'
        group by r.part_id, p.part_number, p.name, q.characteristic_key, q.operation_code
        order by max(m.measured_at) desc limit ${opts.maxCharts}`);
      const since = Date.now() - opts.days * 86_400_000;
      const byRule: Record<string, number> = {};
      const recent: SpcOverview['recent'] = [];
      let withSignals = 0;
      let withoutBaseline = 0;
      let monitored = 0;
      let signalCount = 0;
      for (const g of groups.rows) {
        const partId = g.part_id as string;
        const key = g.characteristic_key as string;
        const op = g.operation_code as string;
        const groupRows = await this.readings(db, ctx, { partId, characteristicKey: key, operationCode: op });
        if (isPRows(groupRows) || isCountRows(groupRows)) {
          const found = await this.pOverview(db, ctx, g, groupRows, since);
          if (found) {
            monitored += 1;
            if (!found.baseline) withoutBaseline += 1;
            if (found.signals.length) withSignals += 1;
            for (const m of found.signals) byRule[m.rule] = (byRule[m.rule] ?? 0) + 1;
            signalCount += found.signals.length;
            recent.push(...found.signals);
          }
          continue;
        }
        const data = assemble(groupRows);
        if (!data.chartType || !data.points.length) continue;
        monitored += 1;
        const b = await db.execute<Row>(sql`${BASELINE_SELECT} where b.organisation_id = ${orgOf(ctx)}::uuid and b.part_id = ${partId}::uuid
          and b.characteristic_key = ${key} and b.operation_code = ${op} and b.chart_type = ${data.chartType} and b.superseded_at is null`);
        const base = b.rows[0] ? toBaseline(b.rows[0]) : null;
        const usable = base && base.subgroupSize === data.subgroupSize && base.unitCode === data.unitCode ? base : null;
        if (!usable) withoutBaseline += 1;
        const res = evaluate(data, usable ? (usable.limits as Limits) : null, usable ? usable.rules : parseRules(undefined));
        const mine: SpcOverview['recent'] = [];
        for (const sg of res.signals) {
          const pt = data.points[sg.index];
          if (new Date(pt.at).getTime() >= since) mine.push({ ...overviewRow(g, pt, data.unitCode), rule: sg.rule, text: RULE_TEXT[sg.rule] });
        }
        for (const i of res.dispersionSignals) {
          const pt = data.points[i];
          if (new Date(pt.at).getTime() >= since) mine.push({ ...overviewRow(g, pt, data.unitCode), rule: 'range', text: `${data.chartType === 'imr' ? 'Moving range' : 'Range'} above its upper limit` });
        }
        if (mine.length) withSignals += 1;
        for (const m of mine) byRule[m.rule] = (byRule[m.rule] ?? 0) + 1;
        signalCount += mine.length;
        recent.push(...mine);
      }
      recent.sort((x, y) => y.at.localeCompare(x.at));
      return {
        available: true,
        windowDays: opts.days,
        monitored,
        withSignals,
        withoutBaseline,
        signalCount,
        byRule: Object.entries(byRule).map(([rule, count]) => ({ rule, count })),
        recent: recent.slice(0, opts.maxRecent),
      };
    });
  }

  // ---- P charts (proportion failed) ----------------------------------------------------------

  private async activeBaseline(db: Db, ctx: RequestContext, partId: string, key: string, op: string, chartType: string): Promise<Baseline | null> {
    const b = await db.execute<Row>(sql`${BASELINE_SELECT} where b.organisation_id = ${orgOf(ctx)}::uuid and b.part_id = ${partId}::uuid
      and b.characteristic_key = ${key} and b.operation_code = ${op} and b.chart_type = ${chartType} and b.superseded_at is null`);
    return b.rows[0] ? toBaseline(b.rows[0]) : null;
  }

  private async pChart(db: Db, ctx: RequestContext, q: z.infer<typeof ChartQuery>, part: { id: string; partNumber: string; name: string }, operationCode: string, rows: ReadingRow[]): Promise<Chart> {
    const basis: SubgroupBasis = q.subgroup ?? 'inspection';
    const data = assembleP(rows, basis);
    const baseline = await this.activeBaseline(db, ctx, q.partId, q.characteristicKey, operationCode, 'p');
    let usable: Baseline | null = baseline;
    let baselineIssue: string | null = null;
    if (baseline && baseline.subgroupBasis !== basis) {
      usable = null;
      baselineIssue = `The saved baseline was made with subgroups of ${BASIS_TEXT[baseline.subgroupBasis ?? 'inspection']}; choose that subgroup to use it, or save a new baseline.`;
    } else if (!baseline) {
      const other = await db.execute<Row>(sql`select 1 from public.spc_baselines where organisation_id = ${orgOf(ctx)}::uuid and part_id = ${q.partId}::uuid
        and characteristic_key = ${q.characteristicKey} and operation_code = ${operationCode} and superseded_at is null`);
      if (other.rows.length) baselineIssue = 'The saved baseline is for a different chart type, so it is not used. Save a new baseline.';
    }
    const rules = q.rules !== undefined ? parseRules(q.rules) : usable ? usable.rules : parseRules(undefined);
    const res = evaluateP(data, usable ? usable.limits.centre : null, rules);
    const latest = await this.latestInfo(db, ctx, q.partId, q.characteristicKey, operationCode);
    const finite = (v: number) => (Number.isFinite(v) ? v : null);
    return {
      part,
      characteristic: { key: q.characteristicKey, name: latest.name, operationCode, chartType: 'p', subgroupSize: null, unitCode: null },
      spec: { nominal: null, lower: null, upper: null },
      points: res.points.map((pt) => ({
        index: pt.index,
        at: pt.at,
        value: pt.p,
        dispersion: null,
        readings: [],
        inspections: pt.inspections,
        lot: pt.lot,
        machineId: null,
        gaugeOverride: false,
        n: pt.n,
        failed: pt.d,
        ucl: finite(pt.ucl),
        lcl: finite(pt.lcl),
        z: pt.z,
      })),
      limitsSource: res.limitsSource,
      limits: res.centre === null || !res.atMeanSize ? null : { centre: res.centre, ucl: res.atMeanSize.ucl, lcl: res.atMeanSize.lcl, sigma: res.atMeanSize.sigma, dispersionCentre: null, dispersionUcl: null, dispersionLcl: null },
      provisional: res.provisional,
      rules,
      signals: res.signals,
      dispersionSignals: [],
      noVariation: res.noVariation,
      warnings: res.warnings,
      excluded: data.excluded,
      baseline: usable,
      baselineIssue,
      subgroup: res.reliability ? { basis, meanSize: res.reliability.meanSize, expectedFailures: res.reliability.expectedFailures, reliable: res.reliability.reliable } : null,
      variant: 'p',
      reactions: latest.reactions,
    };
  }

  /** Saves p̄ from the chosen window of subgroups; each subgroup's limits are recalculated from it and its own size. */
  private async createPBaseline(db: Db, ctx: RequestContext, body: z.infer<typeof CreateBaselineBody>, rows: ReadingRow[]): Promise<Baseline> {
    const assembled = assembleP(rows, body.subgroup);
    const data = body.size === undefined ? assembled : applySubgroupSize(assembled, body.size).data;
    let groups = data.groups;
    if (body.firstN) groups = groups.slice(0, body.firstN);
    else groups = groups.filter((g) => (!body.from || g.at >= body.from) && (!body.to || g.at <= body.to));
    if (groups.length < MINIMUM_POINTS) {
      throw rule(`A baseline needs at least ${MINIMUM_POINTS} subgroups (${BASIS_TEXT[body.subgroup]} each); the chosen window has ${groups.length}.`);
    }
    const centre = pBar(groups);
    const meanN = groups.reduce((t, g) => t + g.n, 0) / groups.length;
    const at = evaluateP({ basis: body.subgroup, groups, excluded: [] }, centre, []).atMeanSize!;
    // Every check of the window, by id, for traceability.
    const ids = this.windowIds(rows, body.subgroup, groups);
    if (ids.length > 50000) throw rule('That window has too many checks; choose a shorter one.');
    const inserted = await db.execute<{ id: string }>(sql`insert into public.spc_baselines
      (organisation_id, part_id, characteristic_key, operation_code, chart_type, subgroup_size, subgroup_basis, mean_subgroup_size, window_from, window_to, n_points, provisional,
       measurement_ids, centre, ucl, lcl, sigma, rules, notes)
      values (${orgOf(ctx)}::uuid, ${body.partId}::uuid, ${body.characteristicKey}, ${body.operationCode}, 'p', null, ${body.subgroup}, ${meanN}::numeric,
              ${groups[0].at}::timestamptz, ${groups[groups.length - 1].at}::timestamptz, ${groups.length}, ${groups.length < PROVISIONAL_BELOW.xbar_r},
              string_to_array(${ids.join(',')}, ',')::uuid[], ${centre}::numeric, ${at.ucl}::numeric, ${at.lcl}::numeric, ${at.sigma}::numeric,
              string_to_array(${body.rules.join(',')}, ',')::text[], ${body.notes ?? null})
      returning id`);
    const r = await db.execute<Row>(sql`${BASELINE_SELECT} where b.id = ${inserted.rows[0].id}::uuid`);
    return toBaseline(r.rows[0]);
  }

  /** The ids of the checks that fall in the chosen subgroups (same grouping as the chart). */
  private windowIds(rows: ReadingRow[], basis: SubgroupBasis, groups: { at: string; inspections: { id: string }[]; lot: string | null }[]): string[] {
    const keys = new Set(groups.map((g) => (basis === 'inspection' ? g.inspections[0]?.id : basis === 'day' ? g.at.slice(0, 10) : g.lot)));
    return rows
      .filter((r) => (r.valuePass !== null || (r.valueCount ?? null) !== null) && (r.chartType === 'p' || r.chartType === 'defects') && r.inspectionStatus !== 'abandoned' && !r.isRetest)
      .filter((r) => keys.has(basis === 'inspection' ? r.inspectionId : basis === 'day' ? r.measuredAt.slice(0, 10) : r.lot))
      .map((r) => r.id);
  }

  private async pOverview(db: Db, ctx: RequestContext, g: Row, rows: ReadingRow[], since: number) {
    if (isCountRows(rows)) {
      const cd = assembleDefects(rows, 'inspection');
      if (!cd.groups.length) return null;
      const cb = await this.activeBaseline(db, ctx, g.part_id as string, g.characteristic_key as string, g.operation_code as string, 'defects');
      const cu = cb && cb.subgroupBasis === 'inspection' ? cb : null;
      const cr = evaluateCount(defectsKind(cd.groups), cd.groups, cu ? cu.limits.centre : null, cu ? cu.rules : parseRules(undefined));
      const csignals: SpcOverview['recent'] = cr.signals
        .filter((sg) => new Date(cr.points[sg.index].at).getTime() >= since)
        .map((sg) => ({ ...overviewRow(g, cr.points[sg.index] as unknown as ChartPoint, null), rule: sg.rule, text: RULE_TEXT[sg.rule] }));
      return { baseline: cu, signals: csignals };
    }
    const data = assembleP(rows, 'inspection');
    if (!data.groups.length) return null;
    const baseline = await this.activeBaseline(db, ctx, g.part_id as string, g.characteristic_key as string, g.operation_code as string, 'p');
    const usable = baseline && baseline.subgroupBasis === 'inspection' ? baseline : null;
    const res = evaluateP(data, usable ? usable.limits.centre : null, usable ? usable.rules : parseRules(undefined));
    const signals: SpcOverview['recent'] = res.signals
      .filter((sg) => new Date(res.points[sg.index].at).getTime() >= since)
      .map((sg) => ({ ...overviewRow(g, res.points[sg.index] as unknown as ChartPoint, null), rule: sg.rule, text: RULE_TEXT[sg.rule] }));
    return { baseline: usable, signals };
  }

  private async countChart(
    db: Db,
    ctx: RequestContext,
    q: z.infer<typeof ChartQuery>,
    part: { id: string; partNumber: string; name: string },
    operationCode: string,
    rows: ReadingRow[],
    source: 'np' | 'defects',
  ): Promise<Chart> {
    const basis: SubgroupBasis = q.subgroup ?? 'inspection';
    let data = source === 'np' ? assembleP(rows, basis) : assembleDefects(rows, basis);
    let size: number | null = null;
    if (source === 'np') {
      const sized = applySubgroupSize(data, q.size === undefined || q.size === 'auto' ? 'auto' : Number(q.size));
      data = sized.data;
      size = sized.size;
    }
    const kind = source === 'np' ? 'np' : defectsKind(data.groups);
    const chartType = source === 'np' ? 'p' : 'defects';
    const baseline = await this.activeBaseline(db, ctx, q.partId, q.characteristicKey, operationCode, chartType);
    let usable: Baseline | null = baseline;
    let baselineIssue: string | null = null;
    if (baseline && baseline.subgroupBasis !== basis) {
      usable = null;
      baselineIssue = `The saved baseline was made with subgroups of ${BASIS_TEXT[baseline.subgroupBasis ?? 'inspection']}; choose that subgroup to use it, or save a new baseline.`;
    } else if (!baseline) {
      const other = await db.execute<Row>(sql`select 1 from public.spc_baselines where organisation_id = ${orgOf(ctx)}::uuid and part_id = ${q.partId}::uuid
        and characteristic_key = ${q.characteristicKey} and operation_code = ${operationCode} and superseded_at is null`);
      if (other.rows.length) baselineIssue = 'The saved baseline is for a different chart type, so it is not used. Save a new baseline.';
    }
    const rules = q.rules !== undefined ? parseRules(q.rules) : usable ? usable.rules : parseRules(undefined);
    const res = evaluateCount(kind, data.groups, usable ? usable.limits.centre : null, rules, source === 'np' ? 'checks' : 'units');
    const latest = await this.latestInfo(db, ctx, q.partId, q.characteristicKey, operationCode);
    const finite = (v: number) => (Number.isFinite(v) ? v : null);
    return {
      part,
      characteristic: { key: q.characteristicKey, name: latest.name, operationCode, chartType, subgroupSize: null, unitCode: null },
      spec: { nominal: null, lower: null, upper: null },
      points: res.points.map((pt) => ({
        index: pt.index,
        at: pt.at,
        value: pt.y,
        dispersion: null,
        readings: [],
        inspections: pt.inspections,
        lot: pt.lot,
        machineId: null,
        gaugeOverride: false,
        n: pt.n,
        failed: pt.d,
        ucl: finite(pt.ucl),
        lcl: finite(pt.lcl),
        z: pt.z,
      })),
      limitsSource: res.limitsSource,
      limits: res.rate === null || !res.atMeanSize ? null : { centre: res.atMeanSize.centre, ucl: res.atMeanSize.ucl, lcl: res.atMeanSize.lcl, sigma: res.atMeanSize.sigma, dispersionCentre: null, dispersionUcl: null, dispersionLcl: null },
      provisional: res.provisional,
      rules,
      signals: res.signals,
      dispersionSignals: [],
      noVariation: res.noVariation,
      warnings: res.warnings,
      excluded: data.excluded,
      baseline: usable,
      baselineIssue,
      subgroup: res.reliability ? { basis, meanSize: res.reliability.meanSize, expectedFailures: res.reliability.expected, reliable: res.reliability.reliable, size: res.size } : null,
      variant: kind,
      reactions: latest.reactions,
    };
  }

  /** Saves ū (defects per unit) from the chosen window of subgroups; each subgroup's limits are recalculated from it and its own size. */
  private async createCountBaseline(db: Db, ctx: RequestContext, body: z.infer<typeof CreateBaselineBody>, rows: ReadingRow[]): Promise<Baseline> {
    const data = assembleDefects(rows, body.subgroup);
    let groups = data.groups;
    if (body.firstN) groups = groups.slice(0, body.firstN);
    else groups = groups.filter((g) => (!body.from || g.at >= body.from) && (!body.to || g.at <= body.to));
    if (groups.length < MINIMUM_POINTS) {
      throw rule(`A baseline needs at least ${MINIMUM_POINTS} subgroups (${BASIS_TEXT[body.subgroup]} each); the chosen window has ${groups.length}.`);
    }
    const rate = countRate(groups);
    const meanN = groups.reduce((t, g) => t + g.n, 0) / groups.length;
    const at = evaluateCount('u', groups, rate, []).atMeanSize!;
    const ids = this.windowIds(rows, body.subgroup, groups);
    if (ids.length > 50000) throw rule('That window has too many readings; choose a shorter one.');
    const inserted = await db.execute<{ id: string }>(sql`insert into public.spc_baselines
      (organisation_id, part_id, characteristic_key, operation_code, chart_type, subgroup_size, subgroup_basis, mean_subgroup_size, window_from, window_to, n_points, provisional,
       measurement_ids, centre, ucl, lcl, sigma, rules, notes)
      values (${orgOf(ctx)}::uuid, ${body.partId}::uuid, ${body.characteristicKey}, ${body.operationCode}, 'defects', null, ${body.subgroup}, ${meanN}::numeric,
              ${groups[0].at}::timestamptz, ${groups[groups.length - 1].at}::timestamptz, ${groups.length}, ${groups.length < PROVISIONAL_BELOW.xbar_r},
              string_to_array(${ids.join(',')}, ',')::uuid[], ${rate}::numeric, ${at.ucl}::numeric, ${at.lcl}::numeric, ${at.sigma}::numeric,
              string_to_array(${body.rules.join(',')}, ',')::text[], ${body.notes ?? null})
      returning id`);
    const r = await db.execute<Row>(sql`${BASELINE_SELECT} where b.id = ${inserted.rows[0].id}::uuid`);
    return toBaseline(r.rows[0]);
  }

  private async latestInfo(db: Db, ctx: RequestContext, partId: string, key: string, op: string) {
    const latest = await db.execute<Row>(sql`select q.name, q.reactions from public.inspection_measurements m
      join public.resolved_inspection_requirements q on q.id = m.requirement_id join public.inspection_records r on r.id = m.inspection_record_id
      where m.organisation_id = ${orgOf(ctx)}::uuid and r.part_id = ${partId}::uuid and q.characteristic_key = ${key} and q.operation_code = ${op}
      order by m.measured_at desc limit 1`);
    const reactions = ((latest.rows[0]?.reactions as { triggerType: string; action: string; instruction: string }[]) ?? [])
      .filter((x) => x.triggerType === 'spc_signal' && x.instruction)
      .map((x) => ({ action: x.action, instruction: x.instruction }));
    return { name: (latest.rows[0]?.name as string) ?? null, reactions };
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
      sql`q.spc_eligible and ((q.data_type = 'variable' and m.value_numeric is not null) or (q.data_type = 'attribute' and m.value_pass is not null) or (q.data_type = 'count' and m.value_count is not null))`,
      sql`not exists (select 1 from public.inspection_measurements c where c.supersedes_id = m.id)`,
    ];
    if (f.from) where.push(sql`m.measured_at >= ${f.from}::timestamptz`);
    if (f.to) where.push(sql`m.measured_at <= ${f.to}::timestamptz`);
    if (f.machineId) where.push(sql`r.machine_id = ${f.machineId}::uuid`);
    if (f.lot) where.push(sql`r.lot = ${f.lot}`);
    const result = await db.execute<Row>(sql`
      select m.id, coalesce(m.value_numeric::text, '') as value, m.value_pass, m.value_count, m.measured_at, s.sample_number, s.subgroup_number, s.is_retest,
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
      valuePass: (x.value_pass as boolean | null) ?? null,
      valueCount: numOrNull(x.value_count),
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

/** True when the most recent reading is a defect count: the characteristic is charted as a C or U chart. */
const isCountRows = (rows: ReadingRow[]) => {
  const last = rows.reduce<ReadingRow | null>((a, r) => (!a || r.measuredAt >= a.measuredAt ? r : a), null);
  return !!last && (last.valueCount ?? null) !== null;
};

/** True when the most recent reading is a pass/fail check: the characteristic is charted as a P chart. */
const isPRows = (rows: ReadingRow[]) => {
  const last = rows.reduce<ReadingRow | null>((a, r) => (!a || r.measuredAt >= a.measuredAt ? r : a), null);
  return !!last && last.valuePass !== null;
};

const rule = (message: string) => new ApiError(HttpStatus.CONFLICT, 'spc_rule', message);

export interface SpcOverview {
  available: boolean;
  windowDays: number;
  /** Characteristics with charted points. */
  monitored: number;
  /** Of those, how many raised a signal in the window. */
  withSignals: number;
  withoutBaseline: number;
  signalCount: number;
  byRule: { rule: string; count: number }[];
  recent: {
    partId: string;
    partNumber: string;
    characteristicKey: string;
    characteristicName: string;
    operationCode: string;
    rule: string;
    text: string;
    at: string;
    point: number;
    inspections: { id: string; reference: string }[];
  }[];
}

const overviewRow = (g: Row, pt: ChartPoint, _unit: string | null) => ({
  partId: g.part_id as string,
  partNumber: g.part_number as string,
  characteristicKey: g.characteristic_key as string,
  characteristicName: (g.name as string) ?? (g.characteristic_key as string),
  operationCode: g.operation_code as string,
  at: pt.at,
  point: pt.index + 1,
  inspections: pt.inspections,
});
