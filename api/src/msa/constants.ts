/**
 * Constants for the range of m standard normal readings: d2 = E[W] (the mean range) and d3 = sd(W), for m = 2 … 25.
 *
 * Worked out by numerical integration of the density of the range (api/src/msa/reference/generate.py, scipy quadrature to about
 * 1e-12) rather than copied from a printed table, and checked in constants.spec.ts against the printed SPC tables (d2, d3, D4, A2) and
 * against the printed AIAG MSA 4th edition K1, K2, K3 constants.
 *
 *   d2* (one subgroup, g = 1) = √(d2² + d3²)   -- the RMS range; the AIAG K2 and K3 are 1/d2* for 2–3 appraisers and 2–10 parts
 *   K1 (repeatability, many subgroups)  = 1/d2(trials)
 *   D4 = 1 + 3·d3/d2     D3 = max(0, 1 − 3·d3/d2)     A2 = 3 / (d2·√n)
 */
export const RANGE_CONSTANTS: Readonly<Record<number, { d2: number; d3: number }>> = {
  2: { d2: 1.128379167096, d3: 0.852502466427 },
  3: { d2: 1.692568750643, d3: 0.888368004045 },
  4: { d2: 2.058750746008, d3: 0.879808202825 },
  5: { d2: 2.325928947281, d3: 0.864081941100 },
  6: { d2: 2.534412721223, d3: 0.848039686117 },
  7: { d2: 2.704356751214, d3: 0.833205335622 },
  8: { d2: 2.847200612091, d3: 0.819831489792 },
  9: { d2: 2.970026324418, d3: 0.807834274553 },
  10: { d2: 3.077505461670, d3: 0.797050673519 },
  11: { d2: 3.172872703816, d3: 0.787314620550 },
  12: { d2: 3.258455279744, d3: 0.778478341203 },
  13: { d2: 3.335980354098, d3: 0.770416202064 },
  14: { d2: 3.406763108200, d3: 0.763023095625 },
  15: { d2: 3.471826889882, d3: 0.756211429728 },
  16: { d2: 3.531982786110, d3: 0.749908089410 },
  17: { d2: 3.587883961765, d3: 0.744051783961 },
  18: { d2: 3.640063757938, d3: 0.738590853378 },
  19: { d2: 3.688963023208, d3: 0.733481495519 },
  20: { d2: 3.734950119597, d3: 0.728686345707 },
  21: { d2: 3.778335829843, d3: 0.724173340717 },
  22: { d2: 3.819384643363, d3: 0.719914808434 },
  23: { d2: 3.858323423285, d3: 0.715886735491 },
  24: { d2: 3.895348148452, d3: 0.712068175147 },
  25: { d2: 3.930629219507, d3: 0.708440765888 },
};

export const MAX_RANGE_GROUP = 25;

const need = (m: number) => {
  const c = RANGE_CONSTANTS[m];
  if (!c) throw new RangeError(`No range constants for a group of ${m}`);
  return c;
};

export const d2 = (m: number) => need(m).d2;
export const d3 = (m: number) => need(m).d3;
/** d2* for a single range (g = 1): the root mean square of the range. */
export const d2Star1 = (m: number) => Math.hypot(need(m).d2, need(m).d3);
export const controlD4 = (m: number) => 1 + (3 * need(m).d3) / need(m).d2;
export const controlD3 = (m: number) => Math.max(0, 1 - (3 * need(m).d3) / need(m).d2);
export const controlA2 = (m: number) => 3 / (need(m).d2 * Math.sqrt(m));
