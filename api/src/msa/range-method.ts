import { d2, d2Star1 } from './constants';
import { distinctCategories } from './criteria';
import type { Cube, Design } from './anova';
import { readDesign } from './anova';

/**
 * The average-and-range method (AIAG MSA 4th edition, "Gage R&R study — average and range method"):
 *
 *   R̄  = mean of every appraiser's average range (the range of a part's trials, averaged over parts)
 *   EV = R̄ · K1                       K1 = 1/d2(trials)              (repeatability, equipment variation)
 *   X̄diff = largest − smallest appraiser mean
 *   AV = √( (X̄diff · K2)² − EV²/(parts·trials) )   K2 = 1/d2*(appraisers, g = 1)   (0 when negative; reproducibility)
 *   GRR = √(EV² + AV²)
 *   Rp = largest − smallest part mean (over appraisers and trials)    PV = Rp · K3   K3 = 1/d2*(parts, g = 1)
 *   TV = √(GRR² + PV²)       ndc = ⌊1.41 · PV / GRR⌋ (at least 1)
 *
 * K1, K2 and K3 are the AIAG table constants, worked out in constants.ts. The tables cover 2 or 3 trials, 2 or 3 appraisers and 2 to 10
 * parts, so the method is offered only inside them (`available: false` with the reason otherwise).
 * Each component is a standard deviation; the study variation is multiplied by 6 (or 5.15) by the caller.
 */

export interface RangeMethodResult {
  available: true;
  k1: number;
  k2: number;
  k3: number;
  averageRange: number;
  repeatability: number;
  appraiserMeanSpread: number;
  reproducibility: number;
  grr: number;
  partMeanSpread: number;
  partVariation: number;
  totalVariation: number;
  ndc: number | null;
}

export interface RangeMethodUnavailable {
  available: false;
  reason: string;
}

export function rangeMethod(cube: Cube): RangeMethodResult | RangeMethodUnavailable {
  const design: Design = readDesign(cube);
  const { parts: p, appraisers: k, trials: r } = design;
  if (r < 2 || r > 3 || k < 2 || k > 3 || p < 2 || p > 10) {
    return { available: false, reason: 'The average-and-range tables cover 2 or 3 trials, 2 or 3 appraisers and 2 to 10 parts.' };
  }
  const k1 = 1 / d2(r);
  const k2 = 1 / d2Star1(k);
  const k3 = 1 / d2Star1(p);

  const appraiserAverageRanges = cube.map((byPart) => byPart.reduce((t, trials) => t + (Math.max(...trials) - Math.min(...trials)), 0) / p);
  const averageRange = appraiserAverageRanges.reduce((a, b) => a + b, 0) / k;
  const repeatability = averageRange * k1;

  const appraiserMeans = cube.map((byPart) => byPart.reduce((t, trials) => t + trials.reduce((a, b) => a + b, 0) / r, 0) / p);
  const appraiserMeanSpread = Math.max(...appraiserMeans) - Math.min(...appraiserMeans);
  const reproducibility = Math.sqrt(Math.max(0, (appraiserMeanSpread * k2) ** 2 - repeatability ** 2 / (p * r)));
  const grr = Math.hypot(repeatability, reproducibility);

  const partMeans = Array.from({ length: p }, (_, j) => cube.reduce((t, byPart) => t + byPart[j].reduce((a, b) => a + b, 0) / r, 0) / k);
  const partMeanSpread = Math.max(...partMeans) - Math.min(...partMeans);
  const partVariation = partMeanSpread * k3;
  const totalVariation = Math.hypot(grr, partVariation);
  const ndc = distinctCategories(partVariation, grr);
  return { available: true, k1, k2, k3, averageRange, repeatability, appraiserMeanSpread, reproducibility, grr, partMeanSpread, partVariation, totalVariation, ndc };
}
