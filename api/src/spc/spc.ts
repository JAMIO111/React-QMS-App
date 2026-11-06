/**
 * Statistical process control: control limits and run rules. Pure functions, no database.
 *
 * Constants are the standard tables (Montgomery, Introduction to Statistical Quality Control).
 * Control limits describe what the process does; they are NOT specification limits and the two are
 * never mixed (the API and the screens carry them separately).
 */

export type ChartType = 'imr' | 'xbar_r';
export const RULES = ['we1', 'we2', 'we3', 'we4'] as const;
export type Rule = (typeof RULES)[number];

export const RULE_TEXT: Record<Rule, string> = {
  we1: 'One point beyond 3σ (outside the control limits)',
  we2: 'Two of three points beyond 2σ on the same side of the centre line',
  we3: 'Four of five points beyond 1σ on the same side of the centre line',
  we4: 'Eight points in a row on the same side of the centre line',
};

/** n: A2, D3, D4, d2 (subgroup sizes 2–10). */
const TABLE: Record<number, { a2: number; d3: number; d4: number; d2: number }> = {
  2: { a2: 1.88, d3: 0, d4: 3.267, d2: 1.128 },
  3: { a2: 1.023, d3: 0, d4: 2.574, d2: 1.693 },
  4: { a2: 0.729, d3: 0, d4: 2.282, d2: 2.059 },
  5: { a2: 0.577, d3: 0, d4: 2.114, d2: 2.326 },
  6: { a2: 0.483, d3: 0, d4: 2.004, d2: 2.534 },
  7: { a2: 0.419, d3: 0.076, d4: 1.924, d2: 2.704 },
  8: { a2: 0.373, d3: 0.136, d4: 1.864, d2: 2.847 },
  9: { a2: 0.337, d3: 0.184, d4: 1.816, d2: 2.97 },
  10: { a2: 0.308, d3: 0.223, d4: 1.777, d2: 3.078 },
};
const IMR = { d2: 1.128, d3: 0, d4: 3.267 };

/** Fewer than this many individuals / subgroups: limits are labelled provisional. */
export const PROVISIONAL_BELOW = { imr: 25, xbar_r: 20 } as const;
/** Fewer than this many individuals / subgroups: no limits are calculated at all. */
export const MINIMUM_POINTS = 5;

export interface Limits {
  /** Location chart: the individual value (I-MR) or the subgroup mean (X-bar/R). */
  centre: number;
  ucl: number;
  lcl: number;
  /** Dispersion chart: the moving range (I-MR) or the subgroup range (X-bar/R). */
  dispersionCentre: number;
  dispersionUcl: number;
  dispersionLcl: number;
  /** Estimated standard deviation of the individual values (within-subgroup / short-term). */
  sigma: number;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export const isProvisional = (type: ChartType, points: number) => points < PROVISIONAL_BELOW[type];

/** Statistics plotted for each point: the location value and the dispersion (null for the first I-MR point). */
export function plotted(type: ChartType, groups: number[][]): { location: number[]; dispersion: (number | null)[] } {
  if (type === 'imr') {
    const x = groups.map((g) => g[0]);
    return { location: x, dispersion: x.map((v, i) => (i === 0 ? null : Math.abs(v - x[i - 1]))) };
  }
  return { location: groups.map(mean), dispersion: groups.map((g) => Math.max(...g) - Math.min(...g)) };
}

/**
 * Control limits from the given points (each a group of readings: one reading for I-MR, n for X-bar/R).
 * Throws when there are fewer than MINIMUM_POINTS points or the subgroup sizes are not all the same.
 */
export function controlLimits(type: ChartType, groups: number[][]): Limits {
  if (groups.length < MINIMUM_POINTS) throw new RangeError(`At least ${MINIMUM_POINTS} points are needed to calculate limits`);
  const { location, dispersion } = plotted(type, groups);
  if (type === 'imr') {
    if (groups.some((g) => g.length !== 1)) throw new RangeError('I-MR uses individual values');
    const mrs = dispersion.filter((d): d is number => d !== null);
    const mrBar = mean(mrs);
    const centre = mean(location);
    const e2 = 3 / IMR.d2;
    return {
      centre,
      ucl: centre + e2 * mrBar,
      lcl: centre - e2 * mrBar,
      dispersionCentre: mrBar,
      dispersionUcl: IMR.d4 * mrBar,
      dispersionLcl: IMR.d3 * mrBar,
      sigma: mrBar / IMR.d2,
    };
  }
  const n = groups[0].length;
  const k = TABLE[n];
  if (!k) throw new RangeError('X-bar/R needs a subgroup size from 2 to 10');
  if (groups.some((g) => g.length !== n)) throw new RangeError('Every subgroup must have the same size');
  const rBar = mean(dispersion as number[]);
  const centre = mean(location);
  return {
    centre,
    ucl: centre + k.a2 * rBar,
    lcl: centre - k.a2 * rBar,
    dispersionCentre: rBar,
    dispersionUcl: k.d4 * rBar,
    dispersionLcl: k.d3 * rBar,
    sigma: rBar / k.d2,
  };
}

export interface Signal {
  rule: Rule;
  /** The point that completes the pattern (its position in the series). */
  index: number;
  /** Every point that is part of the pattern, including `index`. */
  involved: number[];
  side: 'above' | 'below';
}

/**
 * Western Electric rules 2–4 on points expressed in zone units (z > 0 above the centre line, 1σ = 1). Shared by the
 * location charts and the P chart, whose points each have their own σ.
 */
export function zoneRules(zs: number[], on: ReadonlySet<Rule>, out: Signal[]): void {
  for (let i = 0; i < zs.length; i++) {
    if (on.has('we2') && i >= 1) {
      for (const side of ['above', 'below'] as const) {
        const s = side === 'above' ? 1 : -1;
        const win = [i - 2, i - 1, i].filter((j) => j >= 0);
        const beyond = win.filter((j) => zs[j] * s > 2);
        if (beyond.length >= 2 && zs[i] * s > 2) out.push({ rule: 'we2', index: i, involved: beyond, side });
      }
    }
    if (on.has('we3') && i >= 3) {
      for (const side of ['above', 'below'] as const) {
        const s = side === 'above' ? 1 : -1;
        const win = [i - 4, i - 3, i - 2, i - 1, i].filter((j) => j >= 0);
        const beyond = win.filter((j) => zs[j] * s > 1);
        if (beyond.length >= 4 && zs[i] * s > 1) out.push({ rule: 'we3', index: i, involved: beyond, side });
      }
    }
    if (on.has('we4') && i >= 7) {
      const win = Array.from({ length: 8 }, (_, k) => i - 7 + k);
      if (win.every((j) => zs[j] > 0)) out.push({ rule: 'we4', index: i, involved: win, side: 'above' });
      else if (win.every((j) => zs[j] < 0)) out.push({ rule: 'we4', index: i, involved: win, side: 'below' });
    }
  }
}

/**
 * Western Electric rules on the location chart. Zones are thirds of the distance from the centre line to
 * the control limits, so they always agree with the limits drawn. A flag is raised at every point at which
 * the pattern holds (a run of nine flags the 8th and the 9th point).
 */
export function detectSignals(location: number[], limits: Pick<Limits, 'centre' | 'ucl' | 'lcl'>, enabled: readonly Rule[] = RULES): Signal[] {
  const on = new Set(enabled);
  const out: Signal[] = [];
  const up = (limits.ucl - limits.centre) / 3;
  const down = (limits.centre - limits.lcl) / 3;
  // Signed distance in zone units: > 0 above the centre line.
  const z = (x: number) => (x >= limits.centre ? (up > 0 ? (x - limits.centre) / up : 0) : down > 0 ? (x - limits.centre) / down : 0);
  const zs = location.map(z);

  for (let i = 0; i < location.length; i++) {
    if (on.has('we1') && (location[i] > limits.ucl || location[i] < limits.lcl)) {
      out.push({ rule: 'we1', index: i, involved: [i], side: location[i] > limits.centre ? 'above' : 'below' });
    }
  }
  // With no variation every z is 0, so the zone rules cannot fire.
  zoneRules(zs, on, out);
  return out.sort((a, b) => a.index - b.index || RULES.indexOf(a.rule) - RULES.indexOf(b.rule));
}

/** Points of the dispersion chart above its upper control limit (the only range rule used). */
export function dispersionSignals(dispersion: (number | null)[], limits: Pick<Limits, 'dispersionUcl'>): number[] {
  return dispersion.flatMap((d, i) => (d !== null && d > limits.dispersionUcl ? [i] : []));
}

// ---- P chart: proportion of failed checks ----------------------------------------------------------

export interface PGroup {
  /** Checks in the subgroup. */
  n: number;
  /** How many of them failed. */
  d: number;
}

export interface PPoint extends PGroup {
  /** Proportion failed, d / n. */
  p: number;
  /** Control limits for this subgroup size, clipped to 0…1 (what is drawn). */
  ucl: number;
  lcl: number;
  /** Distance from the centre line in σ of this subgroup (±Infinity when p̄ is 0 or 1 and p differs). */
  z: number;
}

/** Centre line: all failures over all checks. */
export const pBar = (groups: readonly PGroup[]) => {
  const n = groups.reduce((t, g) => t + g.n, 0);
  return n > 0 ? groups.reduce((t, g) => t + g.d, 0) / n : 0;
};

/** σ of the proportion for a subgroup of n checks. */
export const pSigma = (centre: number, n: number) => Math.sqrt((centre * (1 - centre)) / n);

/** Control limits at one subgroup size, clipped to 0…1. */
export const pLimitsAt = (centre: number, n: number) => {
  const s = pSigma(centre, n);
  return { ucl: Math.min(1, centre + 3 * s), lcl: Math.max(0, centre - 3 * s) };
};

/** Every subgroup against the centre line, each with the limits of its own size. */
export function pSeries(groups: readonly PGroup[], centre: number): PPoint[] {
  return groups.map((g) => {
    const p = g.d / g.n;
    const s = pSigma(centre, g.n);
    const z = s > 0 ? (p - centre) / s : p === centre ? 0 : p > centre ? Infinity : -Infinity;
    return { ...g, p, ...pLimitsAt(centre, g.n), z };
  });
}

/**
 * The normal approximation behind the limits needs about five expected failures (and five expected passes) per
 * subgroup; below that the limits are unreliable and the chart says so.
 */
export function pReliability(groups: readonly PGroup[], centre: number) {
  const meanN = groups.length ? groups.reduce((t, g) => t + g.n, 0) / groups.length : 0;
  return { meanN, expectedFailures: meanN * centre, expectedPasses: meanN * (1 - centre), reliable: meanN * centre >= 5 && meanN * (1 - centre) >= 5 };
}

/** Western Electric rules 1–4 in each point's own σ units. */
export function detectPSignals(points: readonly PPoint[], enabled: readonly Rule[] = RULES): Signal[] {
  const on = new Set(enabled);
  const out: Signal[] = [];
  if (on.has('we1')) {
    points.forEach((pt, i) => {
      if (pt.z > 3 || pt.z < -3) out.push({ rule: 'we1', index: i, involved: [i], side: pt.z > 0 ? 'above' : 'below' });
    });
  }
  zoneRules(points.map((pt) => pt.z), on, out);
  return out.sort((a, b) => a.index - b.index || RULES.indexOf(a.rule) - RULES.indexOf(b.rule));
}
