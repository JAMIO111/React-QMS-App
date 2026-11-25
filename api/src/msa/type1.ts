import { tTwoSidedP } from './distributions';
import { CG_MINIMUM, CRITERIA_ID, type Band } from './criteria';
import { MsaInputError, type MsaWarning } from './errors';

/**
 * The Type 1 study: one reference part with a known value measured n times by one appraiser with one gauge.
 *
 *   bias = mean − reference        s = sample standard deviation        t = bias / (s/√n)  (n − 1 degrees of freedom, two-sided p)
 *   Cg  = (K/100 · T) / (L · s)                    Cgk = (K/200 · T − |bias|) / (L/2 · s)
 *   %Var(repeatability) = K / Cg        %Var(repeatability and bias) = K / Cgk      (percent of the tolerance T = USL − LSL)
 *
 * K is the share of the tolerance the gauge may use (20% by default) and L the number of standard deviations that count as the
 * gauge's spread (6 by default; some customers use 4): VDA 5 and Minitab's Type 1 gage study use the same definitions.
 * Cg and Cgk of 1.33 or more are acceptable. A resolution above 5% of the tolerance (RE%) is warned about.
 * Both limits are needed; without them the statistics that do not need a tolerance are still given and nothing is judged.
 */
export const ALGORITHM_VERSION = 'msa-1';
export const MIN_RECOMMENDED_READINGS = 25;

export interface Type1Input {
  values: readonly number[];
  reference: number;
  lower: number | null;
  upper: number | null;
  /** Percent of the tolerance the gauge may use (default 20). */
  k?: number;
  /** Standard deviations counted as the gauge's spread (default 6). */
  l?: number;
  resolution?: number | null;
}

export interface Type1Result {
  algorithm: typeof ALGORITHM_VERSION;
  criteria: typeof CRITERIA_ID;
  n: number;
  reference: number;
  tolerance: number | null;
  k: number;
  l: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
  bias: number;
  biasT: number | null;
  biasP: number | null;
  cg: number | null;
  cgk: number | null;
  pctRepeatability: number | null;
  pctRepeatabilityAndBias: number | null;
  /** 100 × resolution ÷ tolerance. */
  resolutionPct: number | null;
  verdict: { band: Band | null; reasons: string[] };
  warnings: MsaWarning[];
}

export function analyseType1(input: Type1Input): Type1Result {
  const { values, reference, lower, upper } = input;
  const k = input.k ?? 20;
  const l = input.l ?? 6;
  if (!(k > 0 && k <= 100)) throw new MsaInputError('K must be between 0 and 100 percent.');
  if (!(l > 0)) throw new MsaInputError('L must be positive.');
  if (!Number.isFinite(reference)) throw new MsaInputError('The reference value must be a number.');
  if (values.length < 2) throw new MsaInputError('A Type 1 study needs at least 2 readings.');
  if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw new MsaInputError('Every reading must be a number.');
  if (lower !== null && upper !== null && !(upper > lower)) throw new MsaInputError('The upper limit must be above the lower limit.');
  const tolerance = lower !== null && upper !== null ? upper - lower : null;
  const resolution = input.resolution ?? null;
  const warnings: MsaWarning[] = [];

  const n = values.length;
  // Identical readings have exactly no spread: summing and dividing them would leave a rounding residue of about 1e-14, which would
  // read as a huge Cg instead of "no variation".
  const identical = values.every((v) => v === values[0]);
  const mean = identical ? values[0] : values.reduce((a, b) => a + b, 0) / n;
  const sd = identical ? 0 : Math.sqrt(values.reduce((t, v) => t + (v - mean) ** 2, 0) / (n - 1));
  const bias = mean - reference;
  const biasT = sd > 0 ? bias / (sd / Math.sqrt(n)) : null;
  const biasP = biasT !== null ? tTwoSidedP(biasT, n - 1) : null;

  let cg: number | null = null;
  let cgk: number | null = null;
  if (tolerance !== null && sd > 0) {
    cg = ((k / 100) * tolerance) / (l * sd);
    cgk = ((k / 200) * tolerance - Math.abs(bias)) / ((l / 2) * sd);
  }
  const reasons: string[] = [];
  let band: Band | null = null;
  if (cg !== null && cgk !== null) {
    band = cg >= CG_MINIMUM && cgk >= CG_MINIMUM ? 'acceptable' : 'unacceptable';
    reasons.push(`Cg is ${cg.toFixed(2)} and Cgk is ${cgk.toFixed(2)} (${CG_MINIMUM} or more is expected).`);
  }

  if (n < MIN_RECOMMENDED_READINGS) warnings.push({ code: 'few_readings', level: 'info', text: `${n} readings were taken; at least ${MIN_RECOMMENDED_READINGS} are recommended (50 is typical).` });
  if (tolerance === null) warnings.push({ code: 'no_tolerance', level: 'info', text: 'Both specification limits are needed for Cg and Cgk, so no verdict is given.' });
  if (sd === 0) warnings.push({ code: 'no_variation', level: 'warning', text: 'Every reading is identical, so repeatability cannot be estimated (the gauge may be reading in steps larger than the variation).' });
  if (biasP !== null && biasP < 0.05) warnings.push({ code: 'bias_significant', level: 'info', text: `The bias of ${bias.toPrecision(3)} is significantly different from zero (p = ${biasP.toFixed(4)}).` });
  const resolutionPct = resolution !== null && resolution > 0 && tolerance !== null ? (100 * resolution) / tolerance : null;
  if (resolutionPct !== null && resolutionPct > 5) warnings.push({ code: 'resolution_tolerance', level: 'warning', text: `The gauge's resolution is ${resolutionPct.toFixed(1)}% of the tolerance; 5% or less is expected.` });

  return {
    algorithm: ALGORITHM_VERSION,
    criteria: CRITERIA_ID,
    n,
    reference,
    tolerance,
    k,
    l,
    mean,
    sd,
    min: Math.min(...values),
    max: Math.max(...values),
    bias,
    biasT,
    biasP,
    cg,
    cgk,
    pctRepeatability: cg !== null ? k / cg : null,
    pctRepeatabilityAndBias: cgk !== null ? k / cgk : null,
    resolutionPct,
    verdict: { band, reasons },
    warnings,
  };
}
