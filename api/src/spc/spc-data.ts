import { ChartType, controlLimits, detectSignals, dispersionSignals, isProvisional, Limits, MINIMUM_POINTS, plotted, Rule, RULE_TEXT, RULES, Signal } from './spc';

/** One current (not corrected) numeric reading, with the context it was taken in. */
export interface ReadingRow {
  id: string;
  /** Exactly as stored. */
  value: string;
  measuredAt: string;
  sampleNumber: number;
  subgroupNumber: number | null;
  isRetest: boolean;
  inspectionId: string;
  inspectionReference: string;
  inspectionStatus: 'in_progress' | 'completed' | 'abandoned';
  unitCode: string | null;
  chartType: ChartType | null;
  subgroupSize: number | null;
  nominal: number | null;
  lower: number | null;
  upper: number | null;
  machineId: string | null;
  lot: string | null;
  gaugeOverride: boolean;
}

export type ExclusionReason = 'retest' | 'abandoned' | 'unit' | 'chart_type' | 'specification' | 'no_subgroup' | 'incomplete_subgroup';
export const EXCLUSION_TEXT: Record<ExclusionReason, string> = {
  retest: 'Retests (they re-measure a failed reading)',
  abandoned: 'Abandoned inspections',
  unit: 'Recorded in a different unit',
  chart_type: 'Taken under a different chart type or subgroup size',
  specification: 'Measured against a different specification (nominal or limits)',
  no_subgroup: 'No subgroup recorded (taken before subgroups existed)',
  incomplete_subgroup: 'Incomplete subgroup (fewer readings than the subgroup size)',
};

export interface ChartPoint {
  index: number;
  at: string;
  /** Plotted on the location chart: the reading, or the subgroup mean. */
  value: number;
  /** Plotted on the dispersion chart: the moving range (null for the first point) or the subgroup range. */
  dispersion: number | null;
  readings: { id: string; value: string; sampleNumber: number }[];
  inspections: { id: string; reference: string }[];
  lot: string | null;
  machineId: string | null;
  gaugeOverride: boolean;
}

export interface Dataset {
  chartType: ChartType | null;
  subgroupSize: number | null;
  unitCode: string | null;
  spec: { nominal: number | null; lower: number | null; upper: number | null };
  points: ChartPoint[];
  excluded: { reason: ExclusionReason; text: string; count: number }[];
}

const specKey = (r: ReadingRow) => `${r.nominal}|${r.lower}|${r.upper}`;
const byTime = (a: ReadingRow, b: ReadingRow) => a.measuredAt.localeCompare(b.measuredAt) || a.sampleNumber - b.sampleNumber;

/**
 * Turns the readings found for one part / characteristic / operation into chartable points. SPC only charts
 * compatible data: the target is whatever the MOST RECENT usable reading used (chart type, subgroup size, unit
 * and specification); anything else is left out and counted by reason, never silently mixed in.
 */
export function assemble(rows: ReadingRow[]): Dataset {
  const counts = new Map<ExclusionReason, number>();
  const skip = (reason: ExclusionReason, n = 1) => counts.set(reason, (counts.get(reason) ?? 0) + n);
  const sorted = [...rows].sort(byTime);

  let usable: ReadingRow[] = [];
  for (const r of sorted) {
    if (r.inspectionStatus === 'abandoned') skip('abandoned');
    else if (r.isRetest) skip('retest');
    else usable.push(r);
  }

  const withChart = usable.filter((r) => r.chartType !== null && r.subgroupSize !== null);
  skip('chart_type', usable.length - withChart.length);
  usable = withChart;
  const latest = usable[usable.length - 1];
  if (!latest) return finish(null, null, null, { nominal: null, lower: null, upper: null }, [], counts);

  const type = latest.chartType as ChartType;
  const size = latest.subgroupSize as number;
  const unit = latest.unitCode;
  const spec = specKey(latest);

  const kept: ReadingRow[] = [];
  for (const r of usable) {
    if (r.chartType !== type || r.subgroupSize !== size) skip('chart_type');
    else if (r.unitCode !== unit) skip('unit');
    else if (specKey(r) !== spec) skip('specification');
    else kept.push(r);
  }

  let groups: ReadingRow[][];
  if (type === 'imr') {
    groups = kept.map((r) => [r]);
  } else {
    const by = new Map<string, ReadingRow[]>();
    for (const r of kept) {
      if (r.subgroupNumber === null) {
        skip('no_subgroup');
        continue;
      }
      const k = `${r.inspectionId}:${r.subgroupNumber}`;
      by.set(k, [...(by.get(k) ?? []), r]);
    }
    groups = [];
    for (const g of by.values()) {
      if (g.length === size) groups.push(g);
      else skip('incomplete_subgroup', g.length);
    }
    groups.sort((a, b) => byTime(a[a.length - 1], b[b.length - 1]));
  }

  const stats = plotted(type, groups.map((g) => g.map((r) => Number(r.value))));
  const points: ChartPoint[] = groups.map((g, i) => ({
    index: i,
    at: g[g.length - 1].measuredAt,
    value: stats.location[i],
    dispersion: stats.dispersion[i],
    readings: g.map((r) => ({ id: r.id, value: r.value, sampleNumber: r.sampleNumber })),
    inspections: [...new Map(g.map((r) => [r.inspectionId, { id: r.inspectionId, reference: r.inspectionReference }])).values()],
    lot: g[g.length - 1].lot,
    machineId: g[g.length - 1].machineId,
    gaugeOverride: g.some((r) => r.gaugeOverride),
  }));
  return finish(type, size, unit, { nominal: latest.nominal, lower: latest.lower, upper: latest.upper }, points, counts);
}

function finish(
  chartType: ChartType | null,
  subgroupSize: number | null,
  unitCode: string | null,
  spec: Dataset['spec'],
  points: ChartPoint[],
  counts: Map<ExclusionReason, number>,
): Dataset {
  const order = Object.keys(EXCLUSION_TEXT) as ExclusionReason[];
  return {
    chartType,
    subgroupSize,
    unitCode,
    spec,
    points,
    excluded: order.filter((r) => counts.get(r)).map((reason) => ({ reason, text: EXCLUSION_TEXT[reason], count: counts.get(reason) as number })),
  };
}

export interface BaselineLimits extends Limits {
  id: string;
}

export interface ChartResult {
  /** 'baseline': saved limits; 'trial': calculated from the points shown (always provisional); 'none': not enough data. */
  limitsSource: 'baseline' | 'trial' | 'none';
  limits: Limits | null;
  provisional: boolean;
  signals: (Signal & { text: string })[];
  dispersionSignals: number[];
  noVariation: boolean;
  warnings: string[];
}

/** Limits (saved baseline, else trial limits from these points) and the signals for the chosen rules. */
export function evaluate(data: Dataset, baseline: Limits | null, rules: readonly Rule[]): ChartResult {
  const warnings: string[] = [];
  const type = data.chartType;
  if (!type || data.points.length === 0) {
    return { limitsSource: 'none', limits: null, provisional: true, signals: [], dispersionSignals: [], noVariation: false, warnings: ['There are no chartable readings for these filters.'] };
  }
  let limits: Limits | null = baseline;
  let source: ChartResult['limitsSource'] = baseline ? 'baseline' : 'none';
  if (!limits) {
    if (data.points.length < MINIMUM_POINTS) {
      warnings.push(`At least ${MINIMUM_POINTS} ${type === 'imr' ? 'readings' : 'complete subgroups'} are needed before limits can be shown; there ${data.points.length === 1 ? 'is' : 'are'} ${data.points.length}.`);
      return { limitsSource: 'none', limits: null, provisional: true, signals: [], dispersionSignals: [], noVariation: false, warnings };
    }
    limits = controlLimits(type, data.points.map((p) => p.readings.map((r) => Number(r.value))));
    source = 'trial';
  }
  const provisional = source === 'trial' || isProvisional(type, data.points.length);
  if (source === 'trial') warnings.push('Trial limits: calculated from the points shown, not a saved baseline. Save a baseline to fix them.');
  else if (provisional) warnings.push(`Only ${data.points.length} ${type === 'imr' ? 'readings' : 'subgroups'} so far: treat the limits as provisional.`);
  const noVariation = limits.ucl === limits.lcl;
  if (noVariation) warnings.push('The data shows no variation, so the zone rules cannot be applied.');
  const sig = detectSignals(data.points.map((p) => p.value), limits, rules).map((s) => ({ ...s, text: RULE_TEXT[s.rule] }));
  return {
    limitsSource: source,
    limits,
    provisional,
    signals: sig,
    dispersionSignals: dispersionSignals(data.points.map((p) => p.dispersion), limits),
    noVariation,
    warnings,
  };
}

export const parseRules = (v: string | undefined): Rule[] =>
  v === undefined ? [...RULES] : v.split(',').map((x) => x.trim()).filter((x): x is Rule => (RULES as readonly string[]).includes(x));
