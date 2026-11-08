import {
  ChartType,
  countRate,
  countReliability,
  countSeries,
  CountKind,
  CountPoint,
  defectsKind,
  controlLimits,
  detectPSignals,
  detectSignals,
  dispersionSignals,
  isProvisional,
  Limits,
  MINIMUM_POINTS,
  pBar,
  pLimitsAt,
  plotted,
  pReliability,
  pSeries,
  Rule,
  RULE_TEXT,
  RULES,
  Signal,
} from './spc';

/** One current (not corrected) numeric reading, with the context it was taken in. */
export interface ReadingRow {
  id: string;
  /** Exactly as stored (empty for a pass/fail reading). */
  value: string;
  /** The result of a pass/fail reading; null for a measured one. */
  valuePass: boolean | null;
  /** Defects counted on one unit (a count reading); null for other kinds. */
  valueCount?: number | null;
  measuredAt: string;
  sampleNumber: number;
  subgroupNumber: number | null;
  isRetest: boolean;
  inspectionId: string;
  inspectionReference: string;
  inspectionStatus: 'in_progress' | 'completed' | 'abandoned';
  unitCode: string | null;
  chartType: ChartType | 'p' | 'defects' | null;
  subgroupSize: number | null;
  nominal: number | null;
  lower: number | null;
  upper: number | null;
  machineId: string | null;
  lot: string | null;
  /** The production order: the linked order's number, else the work order as typed. */
  order?: string | null;
  gaugeOverride: boolean;
}

export type ExclusionReason = 'retest' | 'abandoned' | 'unit' | 'chart_type' | 'specification' | 'no_subgroup' | 'incomplete_subgroup' | 'no_lot' | 'no_order' | 'size';
export const EXCLUSION_TEXT: Record<ExclusionReason, string> = {
  retest: 'Retests (they re-measure a failed reading)',
  abandoned: 'Abandoned inspections',
  unit: 'Recorded in a different unit',
  chart_type: 'Taken under a different chart type or subgroup size',
  specification: 'Measured against a different specification (nominal or limits)',
  no_subgroup: 'No subgroup recorded (taken before subgroups existed)',
  incomplete_subgroup: 'Incomplete subgroup (fewer readings than the subgroup size)',
  no_lot: 'Checks of an inspection without a lot number (subgroups by lot)',
  no_order: 'Checks of an inspection without a production order or work order (subgroups by order)',
  size: 'Subgroups of a different size than the NP chart uses',
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
  order?: string | null;
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
  const sorted = rows.filter((r) => r.valuePass === null).sort(byTime); // pass/fail readings belong to P charts

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
    order: g[g.length - 1].order ?? null,
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


// ---- P chart ---------------------------------------------------------------------------------------

export type SubgroupBasis = 'inspection' | 'day' | 'lot' | 'order';
export const SUBGROUP_BASES: readonly SubgroupBasis[] = ['inspection', 'day', 'lot', 'order'];
export const BASIS_TEXT: Record<SubgroupBasis, string> = { inspection: 'one inspection', day: 'one day', lot: 'one lot', order: 'one production order' };

/** Which subgroup a reading belongs to, or null when the basis needs something it does not have (a lot number, an order). Orders match in any case. */
export const subgroupKey = (basis: SubgroupBasis, r: ReadingRow): string | null =>
  basis === 'inspection' ? r.inspectionId : basis === 'day' ? r.measuredAt.slice(0, 10) : basis === 'lot' ? (r.lot ?? null) : r.order ? r.order.toUpperCase() : null;

export interface PGroupRow {
  at: string;
  n: number;
  d: number;
  inspections: { id: string; reference: string }[];
  lot: string | null;
  /** The order (the first one named, whatever its case). */
  order?: string | null;
}

export interface PDataset {
  basis: SubgroupBasis;
  groups: PGroupRow[];
  excluded: { reason: ExclusionReason; text: string; count: number }[];
}

/**
 * Pass/fail readings of one characteristic, grouped into subgroups: one inspection, one calendar day (UTC) or one lot.
 * Retests, abandoned inspections and readings not taken under a P chart are left out and counted; with lots as the
 * basis, checks of inspections without a lot number are left out too.
 */
export function assembleP(rows: ReadingRow[], basis: SubgroupBasis): PDataset {
  const counts = new Map<ExclusionReason, number>();
  const skip = (reason: ExclusionReason) => counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const buckets = new Map<string, ReadingRow[]>();
  for (const r of [...rows].filter((x) => x.valuePass !== null).sort(byTime)) {
    if (r.inspectionStatus === 'abandoned') skip('abandoned');
    else if (r.isRetest) skip('retest');
    else if (r.chartType !== 'p') skip('chart_type');
    else if (basis === 'lot' && !r.lot) skip('no_lot');
    else if (basis === 'order' && !r.order) skip('no_order');
    else {
      const key = subgroupKey(basis, r) as string;
      buckets.set(key, [...(buckets.get(key) ?? []), r]);
    }
  }
  const groups: PGroupRow[] = [...buckets.values()]
    .map((g) => ({
      at: g[g.length - 1].measuredAt,
      n: g.length,
      d: g.filter((r) => r.valuePass === false).length,
      inspections: [...new Map(g.map((r) => [r.inspectionId, { id: r.inspectionId, reference: r.inspectionReference }])).values()],
      lot: [...new Set(g.map((r) => r.lot).filter(Boolean))].join(', ') || null,
      order: g.map((r) => r.order).find(Boolean) ?? null,
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const order = Object.keys(EXCLUSION_TEXT) as ExclusionReason[];
  return { basis, groups, excluded: order.filter((r) => counts.get(r)).map((reason) => ({ reason, text: EXCLUSION_TEXT[reason], count: counts.get(reason) as number })) };
}

export interface PChartResult {
  limitsSource: 'baseline' | 'trial' | 'none';
  /** p̄. */
  centre: number | null;
  /** Limits at the mean subgroup size, for reference; each point has its own. */
  atMeanSize: { ucl: number; lcl: number; sigma: number; meanSize: number } | null;
  points: (PGroupRow & { index: number; p: number; ucl: number; lcl: number; z: number | null })[];
  signals: (Signal & { text: string })[];
  provisional: boolean;
  noVariation: boolean;
  reliability: { meanSize: number; expectedFailures: number; reliable: boolean } | null;
  warnings: string[];
}

/** Limits (a saved baseline's p̄, else trial limits from these subgroups) and signals for the chosen rules. */
export function evaluateP(data: PDataset, baselineCentre: number | null, rules: readonly Rule[]): PChartResult {
  const warnings: string[] = [];
  const empty = (w: string): PChartResult => ({ limitsSource: 'none', centre: null, atMeanSize: null, points: [], signals: [], provisional: true, noVariation: false, reliability: null, warnings: [w] });
  if (!data.groups.length) return empty('There are no pass/fail readings for these filters.');
  let centre = baselineCentre;
  let source: PChartResult['limitsSource'] = baselineCentre === null ? 'none' : 'baseline';
  if (centre === null) {
    if (data.groups.length < MINIMUM_POINTS) {
      const r = empty(`At least ${MINIMUM_POINTS} subgroups are needed before limits can be shown; there ${data.groups.length === 1 ? 'is' : 'are'} ${data.groups.length}.`);
      // Still show the proportions, without limits.
      r.points = data.groups.map((g, index) => ({ ...g, index, p: g.d / g.n, ucl: NaN, lcl: NaN, z: null }));
      return r;
    }
    centre = pBar(data.groups);
    source = 'trial';
  }
  const series = pSeries(data.groups, centre);
  const rel = pReliability(data.groups, centre);
  const provisional = source === 'trial' || data.groups.length < 20;
  if (source === 'trial') warnings.push('Trial limits: calculated from the subgroups shown, not a saved baseline. Save a baseline to fix them.');
  else if (provisional) warnings.push(`Only ${data.groups.length} subgroups so far: treat the limits as provisional.`);
  const noVariation = centre === 0 || centre === 1;
  if (centre === 0) warnings.push('No failures in the baseline: any failure will be a signal. Limits at zero are not informative until failures have been seen.');
  else if (centre === 1) warnings.push('Every check failed, so there is no variation to chart.');
  else if (!rel.reliable) warnings.push(`Subgroups average ${Math.round(rel.meanN * 10) / 10} checks with ${Math.round(rel.expectedFailures * 100) / 100} failures expected: too few for the limits to be reliable (about 5 expected failures and 5 expected passes are needed). Use larger subgroups, for example by day or lot.`);
  const at = pLimitsAt(centre, rel.meanN);
  return {
    limitsSource: source,
    centre,
    atMeanSize: { ucl: at.ucl, lcl: at.lcl, sigma: Math.sqrt((centre * (1 - centre)) / rel.meanN), meanSize: rel.meanN },
    points: data.groups.map((g, index) => ({ ...g, index, p: series[index].p, ucl: series[index].ucl, lcl: series[index].lcl, z: Number.isFinite(series[index].z) ? series[index].z : null })),
    signals: detectPSignals(series, rules).map((sg) => ({ ...sg, text: RULE_TEXT[sg.rule] })),
    provisional,
    noVariation,
    reliability: { meanSize: rel.meanN, expectedFailures: rel.expectedFailures, reliable: rel.reliable },
    warnings,
  };
}


// ---- NP, C and U charts ----------------------------------------------------------------------------

/**
 * Count readings (defects found on one unit) of one characteristic grouped like the P chart's subgroups: one reading is
 * one unit, so a subgroup's n is its units and d its defects. Retests, abandoned inspections and readings taken under
 * another chart type are left out and counted.
 */
export function assembleDefects(rows: ReadingRow[], basis: SubgroupBasis): PDataset {
  const counts = new Map<ExclusionReason, number>();
  const skip = (reason: ExclusionReason) => counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const buckets = new Map<string, ReadingRow[]>();
  for (const r of [...rows].filter((x) => x.valueCount !== null && x.valueCount !== undefined).sort(byTime)) {
    if (r.inspectionStatus === 'abandoned') skip('abandoned');
    else if (r.isRetest) skip('retest');
    else if (r.chartType !== 'defects') skip('chart_type');
    else if (basis === 'lot' && !r.lot) skip('no_lot');
    else if (basis === 'order' && !r.order) skip('no_order');
    else {
      const key = subgroupKey(basis, r) as string;
      buckets.set(key, [...(buckets.get(key) ?? []), r]);
    }
  }
  const groups: PGroupRow[] = [...buckets.values()]
    .map((g) => ({
      at: g[g.length - 1].measuredAt,
      n: g.length,
      d: g.reduce((t, r) => t + (r.valueCount as number), 0),
      inspections: [...new Map(g.map((r) => [r.inspectionId, { id: r.inspectionId, reference: r.inspectionReference }])).values()],
      lot: [...new Set(g.map((r) => r.lot).filter(Boolean))].join(', ') || null,
      order: g.map((r) => r.order).find(Boolean) ?? null,
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const order = Object.keys(EXCLUSION_TEXT) as ExclusionReason[];
  return { basis, groups, excluded: order.filter((r) => counts.get(r)).map((reason) => ({ reason, text: EXCLUSION_TEXT[reason], count: counts.get(reason) as number })) };
}

/** The size most subgroups have (the larger on a tie): what an NP chart uses when it is left to calculate. */
export function commonSize(groups: readonly { n: number }[]): number | null {
  const tally = new Map<number, number>();
  for (const g of groups) tally.set(g.n, (tally.get(g.n) ?? 0) + 1);
  let best: number | null = null;
  for (const [n, c] of tally) if (best === null || c > (tally.get(best) as number) || (c === tally.get(best) && n > best)) best = n;
  return best;
}

/** Keeps the subgroups of one size (a number, or the most common one for 'auto'); the others are counted as excluded. */
export function applySubgroupSize(data: PDataset, size: 'auto' | number): { data: PDataset; size: number | null } {
  const chosen = size === 'auto' ? commonSize(data.groups) : size;
  const kept = data.groups.filter((g) => g.n === chosen);
  const dropped = data.groups.length - kept.length;
  const excluded = dropped ? [...data.excluded, { reason: 'size' as const, text: `${EXCLUSION_TEXT.size} (${chosen})`, count: dropped }] : data.excluded;
  return { data: { ...data, groups: kept, excluded }, size: chosen };
}

export interface CountChartResult {
  kind: CountKind;
  limitsSource: 'baseline' | 'trial' | 'none';
  /** ū (defects per unit) for c and u, p̄ for np. */
  rate: number | null;
  /** Subgroup size of an np or c chart (the same for every point); null for u. */
  size: number | null;
  /** Centre and limits at the mean subgroup size, for reference; each point has its own. */
  atMeanSize: { centre: number; ucl: number; lcl: number; sigma: number; meanSize: number } | null;
  points: (PGroupRow & { index: number; y: number; centre: number; ucl: number; lcl: number; z: number | null })[];
  signals: (Signal & { text: string })[];
  provisional: boolean;
  noVariation: boolean;
  reliability: { meanSize: number; expected: number; reliable: boolean } | null;
  warnings: string[];
}

/**
 * Limits (a saved baseline's rate, else trial limits from these subgroups) and signals for an NP, C or U chart.
 * The groups must already be of one size for np; c is chosen by the caller (kind) when sizes are equal.
 */
export function evaluateCount(kind: CountKind, groups: PGroupRow[], baselineRate: number | null, rules: readonly Rule[], unit: 'checks' | 'units' = 'units'): CountChartResult {
  const warnings: string[] = [];
  const noun = kind === 'np' ? 'failures' : 'defects';
  const size = kind === 'u' ? null : (groups[0]?.n ?? null);
  const empty = (w: string): CountChartResult => ({ kind, limitsSource: 'none', rate: null, size, atMeanSize: null, points: [], signals: [], provisional: true, noVariation: false, reliability: null, warnings: [w] });
  if (!groups.length) return empty(`There are no ${kind === 'np' ? 'pass/fail' : 'count'} readings for these filters.`);
  let rate = baselineRate;
  let source: CountChartResult['limitsSource'] = baselineRate === null ? 'none' : 'baseline';
  if (rate === null) {
    if (groups.length < MINIMUM_POINTS) {
      const r = empty(`At least ${MINIMUM_POINTS} subgroups are needed before limits can be shown; there ${groups.length === 1 ? 'is' : 'are'} ${groups.length}.`);
      r.points = groups.map((g, index) => ({ ...g, index, y: kind === 'u' ? g.d / g.n : g.d, centre: NaN, ucl: NaN, lcl: NaN, z: null }));
      return r;
    }
    rate = countRate(groups);
    source = 'trial';
  }
  const series: CountPoint[] = countSeries(kind, groups, rate, size ?? 1);
  const rel = countReliability(kind, groups, rate);
  const provisional = source === 'trial' || groups.length < 20;
  if (source === 'trial') warnings.push('Trial limits: calculated from the subgroups shown, not a saved baseline. Save a baseline to fix them.');
  else if (provisional) warnings.push(`Only ${groups.length} subgroups so far: treat the limits as provisional.`);
  const noVariation = rate === 0 || (kind === 'np' && rate === 1);
  if (rate === 0) warnings.push(`No ${noun} in the baseline: any ${kind === 'np' ? 'failure' : 'defect'} will be a signal. Limits at zero are not informative until some have been seen.`);
  else if (kind === 'np' && rate === 1) warnings.push('Every check failed, so there is no variation to chart.');
  else if (!rel.reliable) warnings.push(`Subgroups average ${Math.round(rel.meanN * 10) / 10} ${unit} with ${Math.round(rel.expected * 100) / 100} ${noun} expected: too few for the limits to be reliable (about 5 expected${kind === 'np' ? ' failures and 5 expected passes' : ' defects'} are needed). Use larger subgroups, for example by day or lot.`);
  const mid = countSeries(kind, [{ n: kind === 'u' ? rel.meanN : (size as number), d: 0 }], rate, size ?? 1)[0];
  return {
    kind,
    limitsSource: source,
    rate,
    size,
    atMeanSize: { centre: mid.centre, ucl: mid.ucl, lcl: mid.lcl, sigma: kind === 'u' ? Math.sqrt(rate / rel.meanN) : kind === 'c' ? Math.sqrt(mid.centre) : Math.sqrt((size as number) * rate * (1 - rate)), meanSize: rel.meanN },
    points: groups.map((g, index) => ({ ...g, index, y: series[index].y, centre: series[index].centre, ucl: series[index].ucl, lcl: series[index].lcl, z: Number.isFinite(series[index].z) ? series[index].z : null })),
    signals: detectPSignals(series, rules).map((sg) => ({ ...sg, text: RULE_TEXT[sg.rule] })),
    provisional,
    noVariation,
    reliability: { meanSize: rel.meanN, expected: rel.expected, reliable: rel.reliable },
    warnings,
  };
}

export { defectsKind };
