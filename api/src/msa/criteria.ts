/**
 * Acceptance criteria. v1 uses fixed defaults and records their id inside every frozen result, so making them configurable later
 * cannot rewrite what an earlier study was judged against (docs/gauge-rr-plan.md D9).
 *
 * Gauge R&R and ndc: AIAG MSA 4th edition (under 10% acceptable, 10–30% marginal, over 30% unacceptable; ndc of 5 or more).
 * Type 1: Cg and Cgk of 1.33 or more (VDA 5 / the usual capability convention).
 * Attribute: effectiveness 90% / 80%, miss rate 2% / 5%, false-alarm rate 5% / 10%, kappa 0.75 / 0.40 as published with the AIAG
 * attribute study. The attribute bands are quoted from the commonly printed table and have NOT yet been checked against the manual's
 * text: confirm them there before relying on them in an audit (recorded in docs/gauge-rr-plan.md §7).
 */
export const CRITERIA_ID = 'aiag-msa-4';

export type Band = 'acceptable' | 'marginal' | 'unacceptable';
const ORDER: Band[] = ['acceptable', 'marginal', 'unacceptable'];

/** The worst of the bands given (nulls are ignored); null when there is none. */
export const worstBand = (bands: readonly (Band | null | undefined)[]): Band | null => {
  let worst = -1;
  for (const band of bands) if (band) worst = Math.max(worst, ORDER.indexOf(band));
  return worst < 0 ? null : ORDER[worst];
};

export const GRR_ACCEPTABLE_BELOW = 10;
export const GRR_MARGINAL_UP_TO = 30;
export const NDC_MINIMUM = 5;

/** Number of distinct categories: ⌊1.41 · σ_part / σ_GRR⌋, never below 1; null when the gauge shows no variation at all. */
export const distinctCategories = (partSd: number, grrSd: number): number | null => (grrSd > 0 ? Math.max(1, Math.floor((1.41 * partSd) / grrSd)) : null);
export const CG_MINIMUM = 1.33;

/** Percent of study variation or of tolerance. */
export const grrBand = (percent: number): Band => (percent < GRR_ACCEPTABLE_BELOW ? 'acceptable' : percent <= GRR_MARGINAL_UP_TO ? 'marginal' : 'unacceptable');
export const effectivenessBand = (v: number): Band => (v >= 0.9 ? 'acceptable' : v >= 0.8 ? 'marginal' : 'unacceptable');
export const missRateBand = (v: number): Band => (v <= 0.02 ? 'acceptable' : v <= 0.05 ? 'marginal' : 'unacceptable');
export const falseAlarmBand = (v: number): Band => (v <= 0.05 ? 'acceptable' : v <= 0.1 ? 'marginal' : 'unacceptable');
export const kappaBand = (v: number): Band => (v >= 0.75 ? 'acceptable' : v >= 0.4 ? 'marginal' : 'unacceptable');

const pct = (v: number) => `${(Math.round(v * 10) / 10).toFixed(1)}%`;

export interface GrrVerdict {
  band: Band | null;
  reasons: string[];
}

/** One verdict from %study variation and %tolerance (the worse of the two that exist) and ndc, which can only lower an acceptable result to marginal. */
export function grrVerdict(i: { pctStudyVar: number | null; pctTolerance: number | null; ndc: number | null }): GrrVerdict {
  const reasons: string[] = [];
  const bands: Band[] = [];
  if (i.pctStudyVar !== null) {
    const b = grrBand(i.pctStudyVar);
    bands.push(b);
    reasons.push(`Gauge R&R is ${pct(i.pctStudyVar)} of the study variation (${b}).`);
  }
  if (i.pctTolerance !== null) {
    const b = grrBand(i.pctTolerance);
    bands.push(b);
    reasons.push(`Gauge R&R is ${pct(i.pctTolerance)} of the tolerance (${b}).`);
  }
  let band = worstBand(bands);
  if (band === 'acceptable' && i.ndc !== null && i.ndc < NDC_MINIMUM) {
    band = 'marginal';
    reasons.push(`The measurement system tells only ${i.ndc} distinct categories of part apart; ${NDC_MINIMUM} or more are expected.`);
  } else if (i.ndc !== null) {
    reasons.push(`It tells ${i.ndc} distinct categories of part apart (${NDC_MINIMUM} or more are expected).`);
  }
  return { band, reasons };
}
