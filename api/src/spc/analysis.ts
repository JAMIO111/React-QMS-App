/**
 * Family and machine analysis: the same characteristic compared between groups — machines, or the parts of a family.
 * Pure functions; the service gathers the readings.
 *
 * Measured readings are also expressed against their own tolerance, u = (x − midpoint) / (half the tolerance), so −1 and +1 are
 * the limits. Capability is unchanged by that rescaling, which lets parts with different nominals share one comparison.
 * Only the overall σ is used (Pp/Ppk): a within-subgroup σ belongs to one control chart and is not defined across groups.
 */
import { indices, mean, MIN_CAPABILITY_READINGS, normalCdf, sampleSd } from './capability';

export type Kind = 'variable' | 'attribute' | 'count';

export interface AnalysisReading {
  kind: Kind;
  /** Measured value, pass/fail result or defect count: exactly one is set. */
  value: number | null;
  pass: boolean | null;
  count: number | null;
  lower: number | null;
  upper: number | null;
  nominal: number | null;
}

export interface GroupStats {
  /** Readings (measured), checks (pass/fail) or units (count). */
  n: number;
  // measured
  mean: number | null;
  sd: number | null;
  min: number | null;
  max: number | null;
  /** Set when every reading of the group shares one specification. */
  spec: { nominal: number | null; lower: number | null; upper: number | null } | null;
  outOfSpec: number | null;
  /** Mean position in the tolerance, % (0 = centre, ±100 = a limit); needs both limits. */
  offsetPct: number | null;
  /** 6σ as % of the tolerance (100 = the spread just fills it); needs both limits. */
  spreadPct: number | null;
  pp: number | null;
  ppk: number | null;
  expectedPpm: number | null;
  // pass/fail and count
  failed: number | null;
  rate: number | null;
  defects: number | null;
  perUnit: number | null;
  /** How far this group is from all the others, in standard errors (null when it cannot be told). */
  z: number | null;
  verdict: 'higher' | 'lower' | 'similar' | null;
}

const empty = (n: number): GroupStats => ({ n, mean: null, sd: null, min: null, max: null, spec: null, outOfSpec: null, offsetPct: null, spreadPct: null, pp: null, ppk: null, expectedPpm: null, failed: null, rate: null, defects: null, perUnit: null, z: null, verdict: null });

const specKey = (r: AnalysisReading) => `${r.nominal}|${r.lower}|${r.upper}`;

/** The value used to compare groups: against the tolerance when both limits are set, else the raw value when the spec is common. */
function comparable(rows: readonly AnalysisReading[]): number[] | null {
  if (rows.every((r) => r.lower !== null && r.upper !== null && (r.upper as number) > (r.lower as number))) {
    return rows.map((r) => ((r.value as number) - ((r.upper as number) + (r.lower as number)) / 2) / (((r.upper as number) - (r.lower as number)) / 2));
  }
  return new Set(rows.map(specKey)).size === 1 ? rows.map((r) => r.value as number) : null;
}

export function groupStats(rows: readonly AnalysisReading[], kind: Kind): GroupStats {
  const s = empty(rows.length);
  if (!rows.length) return s;
  if (kind === 'attribute') {
    s.failed = rows.filter((r) => r.pass === false).length;
    s.rate = s.failed / rows.length;
    return s;
  }
  if (kind === 'count') {
    s.defects = rows.reduce((t, r) => t + (r.count as number), 0);
    s.perUnit = s.defects / rows.length;
    return s;
  }
  const xs = rows.map((r) => r.value as number);
  s.mean = mean(xs);
  s.sd = sampleSd(xs);
  s.min = Math.min(...xs);
  s.max = Math.max(...xs);
  const uniform = new Set(rows.map(specKey)).size === 1;
  if (uniform) s.spec = { nominal: rows[0].nominal, lower: rows[0].lower, upper: rows[0].upper };
  s.outOfSpec = rows.filter((r) => (r.upper !== null && (r.value as number) > r.upper) || (r.lower !== null && (r.value as number) < r.lower)).length;
  const u = rows.every((r) => r.lower !== null && r.upper !== null && (r.upper as number) > (r.lower as number)) ? comparable(rows) : null;
  if (u) {
    const um = mean(u);
    const usd = sampleSd(u);
    s.offsetPct = um * 100;
    s.spreadPct = usd * 300;
    if (rows.length >= MIN_CAPABILITY_READINGS && usd > 0) {
      const i = indices(um, usd, { lower: -1, upper: 1 });
      s.pp = i.ratio;
      s.ppk = i.k;
      s.expectedPpm = ((1 - normalCdf((1 - um) / usd)) + (1 - normalCdf((um + 1) / usd))) * 1e6;
    }
  } else if (uniform && rows.length >= MIN_CAPABILITY_READINGS && s.sd > 0) {
    s.ppk = indices(s.mean, s.sd, { lower: rows[0].lower, upper: rows[0].upper }).k;
  }
  return s;
}

const Z_FLAG = 3;

/**
 * Compares each group with all the others together: rates (pass/fail) and defects per unit by a normal approximation of the
 * difference, measured values by Welch's z on the tolerance-scaled values. |z| above 3 is called higher or lower.
 */
export function compareGroups(groups: { rows: readonly AnalysisReading[]; stats: GroupStats }[], kind: Kind): void {
  if (groups.length < 2) return;
  const all = groups.flatMap((g) => g.rows);
  for (const g of groups) {
    const rest = groups.filter((o) => o !== g).flatMap((o) => o.rows);
    if (!g.rows.length || !rest.length) continue;
    let z: number | null = null;
    if (kind === 'attribute') {
      const [d1, n1] = [g.rows.filter((r) => r.pass === false).length, g.rows.length];
      const [d2, n2] = [rest.filter((r) => r.pass === false).length, rest.length];
      const p = (d1 + d2) / (n1 + n2);
      const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
      z = se > 0 ? (d1 / n1 - d2 / n2) / se : null;
    } else if (kind === 'count') {
      const [d1, n1] = [g.rows.reduce((t, r) => t + (r.count as number), 0), g.rows.length];
      const [d2, n2] = [rest.reduce((t, r) => t + (r.count as number), 0), rest.length];
      const u = (d1 + d2) / (n1 + n2);
      const se = Math.sqrt(u * (1 / n1 + 1 / n2));
      z = se > 0 ? (d1 / n1 - d2 / n2) / se : null;
    } else {
      const a = comparable(g.rows);
      const b = comparable(rest);
      if (a && b && a.length >= 2 && b.length >= 2 && comparable(all)) {
        const se = Math.sqrt(sampleSd(a) ** 2 / a.length + sampleSd(b) ** 2 / b.length);
        z = se > 0 ? (mean(a) - mean(b)) / se : null;
      }
    }
    g.stats.z = z;
    g.stats.verdict = z === null ? null : z > Z_FLAG ? 'higher' : z < -Z_FLAG ? 'lower' : 'similar';
  }
}
