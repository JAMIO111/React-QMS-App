/**
 * Process capability: how well the process fits the specification (not the control limits).
 *
 *   Cp  = (USL − LSL) / 6σw        Cpk = min(USL − x̄, x̄ − LSL) / 3σw      σw: within (short-term) σ from the control chart
 *   Pp  = (USL − LSL) / 6σo        Ppk = min(USL − x̄, x̄ − LSL) / 3σo      σo: overall (long-term) sample standard deviation
 *
 * One-sided specifications have only the one-sided index (Cpu/Cpl, Ppu/Ppl) and so Cpk/Ppk; Cp and Pp need both limits.
 * The indices assume a stable, roughly normal process: the caller reports when signals or too little data say otherwise.
 */

export const MIN_CAPABILITY_READINGS = 10;
export const RELIABLE_READINGS = 30;

export interface Spec {
  lower: number | null;
  upper: number | null;
}

export interface Indices {
  /** Both limits needed. */
  ratio: number | null;
  /** Upper and lower one-sided indices; null when that limit is not set. */
  upper: number | null;
  lower: number | null;
  /** min of the one-sided indices: the one that counts. */
  k: number | null;
}

export const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Sample standard deviation (n − 1). */
export const sampleSd = (xs: readonly number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((t, x) => t + (x - m) ** 2, 0) / (xs.length - 1));
};

export function indices(avg: number, sigma: number, spec: Spec): Indices {
  if (!(sigma > 0)) return { ratio: null, upper: null, lower: null, k: null };
  const upper = spec.upper === null ? null : (spec.upper - avg) / (3 * sigma);
  const lower = spec.lower === null ? null : (avg - spec.lower) / (3 * sigma);
  const ratio = spec.upper !== null && spec.lower !== null ? (spec.upper - spec.lower) / (6 * sigma) : null;
  const sides = [upper, lower].filter((v): v is number => v !== null);
  return { ratio, upper, lower, k: sides.length ? Math.min(...sides) : null };
}

/** Standard normal cumulative distribution (Abramowitz & Stegun 7.1.26 via erf; error < 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Verdict on an index, using the usual 1.00 / 1.33 / 1.67 bands. */
export const verdict = (v: number | null): 'excellent' | 'capable' | 'marginal' | 'not_capable' | null =>
  v === null ? null : v >= 1.67 ? 'excellent' : v >= 1.33 ? 'capable' : v >= 1 ? 'marginal' : 'not_capable';

export interface Histogram {
  binWidth: number;
  bins: { from: number; to: number; count: number }[];
  /** Expected readings per bin for a normal distribution with the mean and overall σ, at the bin centres and the ends. */
  curve: { x: number; y: number }[];
}

/**
 * Histogram of the readings over a range that also holds the specification limits (so a process drifting towards a limit
 * shows it), with a normal curve scaled to the same counts. About √n bins, at least 8 and at most 20.
 */
export function histogram(readings: readonly number[], spec: Spec, avg: number, sigma: number): Histogram {
  const lows = [Math.min(...readings), ...(spec.lower === null ? [] : [spec.lower])];
  const highs = [Math.max(...readings), ...(spec.upper === null ? [] : [spec.upper])];
  let lo = Math.min(...lows);
  let hi = Math.max(...highs);
  if (sigma > 0) {
    lo = Math.min(lo, avg - 3.5 * sigma);
    hi = Math.max(hi, avg + 3.5 * sigma);
  }
  const span = hi - lo || 1;
  lo -= span * 0.03;
  hi += span * 0.03;
  const n = Math.min(20, Math.max(8, Math.ceil(Math.sqrt(readings.length))));
  const width = (hi - lo) / n;
  const bins = Array.from({ length: n }, (_, i) => ({ from: lo + i * width, to: lo + (i + 1) * width, count: 0 }));
  for (const x of readings) bins[Math.min(n - 1, Math.max(0, Math.floor((x - lo) / width)))].count += 1;
  const pdf = (x: number) => (sigma > 0 ? Math.exp(-0.5 * ((x - avg) / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI)) : 0);
  const steps = 60;
  const curve = Array.from({ length: steps + 1 }, (_, i) => {
    const x = lo + ((hi - lo) * i) / steps;
    return { x, y: readings.length * width * pdf(x) };
  });
  return { binWidth: width, bins, curve };
}

export interface Capability {
  n: number;
  mean: number;
  sigmaWithin: number;
  sigmaOverall: number;
  within: Indices;
  overall: Indices;
  /** Share of readings outside the specification, and the share expected from a normal process with the overall σ (parts per million). */
  observedPpm: number;
  expectedPpm: number | null;
  histogram: Histogram | null;
  verdict: ReturnType<typeof verdict>;
  warnings: string[];
}

/**
 * Capability of the readings shown. `sigmaWithin` is the control chart's σ (saved baseline, else trial limits).
 * Returns null when there is nothing to judge against (no limit) or too few readings.
 */
export function capability(readings: readonly number[], sigmaWithin: number | null, spec: Spec, signalCount: number): Capability | null {
  if (spec.lower === null && spec.upper === null) return null;
  if (readings.length < MIN_CAPABILITY_READINGS || sigmaWithin === null) return null;
  const avg = mean(readings);
  const sigmaOverall = sampleSd(readings);
  const warnings: string[] = [];
  if (!(sigmaOverall > 0)) return { n: readings.length, mean: avg, sigmaWithin, sigmaOverall, within: indices(avg, sigmaWithin, spec), overall: indices(avg, 0, spec), observedPpm: 0, expectedPpm: null, histogram: null, verdict: null, warnings: ['Every reading is the same, so there is no variation to judge.'] };
  if (readings.length < RELIABLE_READINGS) warnings.push(`Only ${readings.length} readings: capability needs about ${RELIABLE_READINGS} or more to be trusted.`);
  if (signalCount > 0) warnings.push('The control chart shows signals, so the process is not stable: capability indices describe a stable process and may mislead.');
  const out = readings.filter((x) => (spec.upper !== null && x > spec.upper) || (spec.lower !== null && x < spec.lower)).length;
  const within = indices(avg, sigmaWithin, spec);
  const overall = indices(avg, sigmaOverall, spec);
  const tail = (limit: number | null, above: boolean) => (limit === null ? 0 : 1 - normalCdf(above ? (limit - avg) / sigmaOverall : (avg - limit) / sigmaOverall));
  const expectedPpm = (tail(spec.upper, true) + tail(spec.lower, false)) * 1e6;
  return { n: readings.length, mean: avg, sigmaWithin, sigmaOverall, within, overall, observedPpm: (out / readings.length) * 1e6, expectedPpm, histogram: histogram(readings, spec, avg, sigmaOverall), verdict: verdict(within.k), warnings };
}
