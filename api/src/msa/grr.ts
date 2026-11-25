import { crossedAnova, type AnovaResult, type ComponentName, type Cube, type Design } from './anova';
import { controlA2, controlD3, controlD4 } from './constants';
import { CRITERIA_ID, distinctCategories, grrVerdict, type GrrVerdict } from './criteria';
import { MsaInputError, type MsaWarning } from './errors';
import { rangeMethod, type RangeMethodResult, type RangeMethodUnavailable } from './range-method';

/**
 * A crossed gauge R&R study end to end: the ANOVA, the variation table, the average-and-range method beside it, the control-chart
 * summaries, warnings and the verdict. Pure: the same readings always give the same answer, and nothing here reads or writes anything.
 * The numbers are spelled out in anova.ts and range-method.ts; every figure is checked against published examples and an independent
 * implementation in the specs. ALGORITHM_VERSION goes into every frozen result so a result can be traced to the code that made it.
 */
export const ALGORITHM_VERSION = 'msa-1';

export interface GrrOptions {
  /** Study-variation multiplier: 6 (99.73%, the default) or 5.15 (99%, older AIAG). */
  sigma?: 6 | 5.15;
  /** Significance level for keeping the part × appraiser interaction (0.05 default; the AIAG manual used 0.25). */
  alpha?: number;
  lower?: number | null;
  upper?: number | null;
  /** The gauge's resolution, for the resolution warnings. */
  resolution?: number | null;
}

export interface VariationRow {
  name: ComponentName | 'reproducibility' | 'grr' | 'total';
  variance: number;
  sd: number;
  /** multiplier × sd */
  studyVariation: number;
  pctContribution: number | null;
  pctStudyVar: number | null;
  /** Needs both limits. */
  pctTolerance: number | null;
}

export interface ChartPoint {
  appraiser: number;
  part: number;
  value: number;
}

export interface GrrAnalysis {
  algorithm: typeof ALGORITHM_VERSION;
  criteria: typeof CRITERIA_ID;
  design: Design;
  options: { sigma: 6 | 5.15; alpha: number; lower: number | null; upper: number | null; tolerance: number | null; resolution: number | null };
  anova: AnovaResult;
  /** Repeatability, appraiser, interaction (reproducibility = appraiser + interaction), grr, part, total. */
  variation: VariationRow[];
  ndc: number | null;
  rangeMethod: (RangeMethodResult & { pctStudyVar: number | null; pctTolerance: number | null; pctRepeatability: number | null; pctReproducibility: number | null }) | RangeMethodUnavailable;
  charts: {
    cellMeans: number[][];
    appraiserMeans: number[];
    partMeans: number[];
    range: { centre: number; ucl: number; lcl: number; points: ChartPoint[]; outside: ChartPoint[] };
    average: { centre: number; ucl: number; lcl: number; points: ChartPoint[]; fractionOutside: number };
  };
  verdict: GrrVerdict;
  warnings: MsaWarning[];
}

const sd = (variance: number) => Math.sqrt(variance);

export function analyseCrossed(cube: Cube, options: GrrOptions = {}): GrrAnalysis {
  const sigma = options.sigma ?? 6;
  if (sigma !== 6 && sigma !== 5.15) throw new MsaInputError('The study variation multiplier must be 6 or 5.15.');
  const alpha = options.alpha ?? 0.05;
  if (!(alpha > 0 && alpha < 1)) throw new MsaInputError('The significance level must be between 0 and 1.');
  const lower = options.lower ?? null;
  const upper = options.upper ?? null;
  if (lower !== null && upper !== null && !(upper > lower)) throw new MsaInputError('The upper limit must be above the lower limit.');
  const tolerance = lower !== null && upper !== null ? upper - lower : null;
  const resolution = options.resolution ?? null;

  const anova = crossedAnova(cube, alpha);
  const { design, variance } = anova;
  const warnings: MsaWarning[] = [];

  const reproducibilityVar = variance.appraiser + variance.interaction;
  const grrVar = variance.repeatability + reproducibilityVar;
  const totalVar = grrVar + variance.part;
  const totalSd = sd(totalVar);
  const makeRow = (name: VariationRow['name'], v: number): VariationRow => ({
    name,
    variance: v,
    sd: sd(v),
    studyVariation: sigma * sd(v),
    pctContribution: totalVar > 0 ? (100 * v) / totalVar : null,
    pctStudyVar: totalSd > 0 ? (100 * sd(v)) / totalSd : null,
    pctTolerance: tolerance !== null ? (100 * sigma * sd(v)) / tolerance : null,
  });
  const variation = [
    makeRow('repeatability', variance.repeatability),
    makeRow('reproducibility', reproducibilityVar),
    makeRow('appraiser', variance.appraiser),
    makeRow('interaction', variance.interaction),
    makeRow('grr', grrVar),
    makeRow('part', variance.part),
    makeRow('total', totalVar),
  ];
  const grrRow = variation.find((v) => v.name === 'grr')!;
  const ndc = distinctCategories(sd(variance.part), grrRow.sd);

  // ── the average-and-range method, with its percentages on the same basis ──
  const rm = rangeMethod(cube);
  const rangeOut: GrrAnalysis['rangeMethod'] = rm.available
    ? {
        ...rm,
        pctStudyVar: rm.totalVariation > 0 ? (100 * rm.grr) / rm.totalVariation : null,
        pctRepeatability: rm.totalVariation > 0 ? (100 * rm.repeatability) / rm.totalVariation : null,
        pctReproducibility: rm.totalVariation > 0 ? (100 * rm.reproducibility) / rm.totalVariation : null,
        pctTolerance: tolerance !== null ? (100 * sigma * rm.grr) / tolerance : null,
      }
    : rm;

  // ── control-chart summaries (AIAG: ranges show repeatability consistency; averages show the system can see part differences) ──
  const { parts: p, appraisers: k, trials: r } = design;
  const rangePoints: ChartPoint[] = [];
  const averagePoints: ChartPoint[] = [];
  let rangeSum = 0;
  for (let a = 0; a < k; a += 1) {
    for (let j = 0; j < p; j += 1) {
      const trials = cube[a][j];
      const range = Math.max(...trials) - Math.min(...trials);
      rangeSum += range;
      rangePoints.push({ appraiser: a, part: j, value: range });
      averagePoints.push({ appraiser: a, part: j, value: anova.cellMeans[a][j] });
    }
  }
  const averageRange = rangeSum / (k * p);
  const rangeUcl = controlD4(r) * averageRange;
  const rangeLcl = controlD3(r) * averageRange;
  const half = controlA2(r) * averageRange;
  const averageUcl = anova.grandMean + half;
  const averageLcl = anova.grandMean - half;
  const outsideRange = rangePoints.filter((pt) => pt.value > rangeUcl || pt.value < rangeLcl);
  const outsideAverage = averagePoints.filter((pt) => pt.value > averageUcl || pt.value < averageLcl);

  // ── warnings ──
  if (p < 10) warnings.push({ code: 'few_parts', level: 'info', text: `${p} parts were measured; 10 are recommended so the parts cover the range the process makes.` });
  if (k < 3) warnings.push({ code: 'few_appraisers', level: 'info', text: `${k} appraisers took part; 3 are recommended.` });
  if (r < 3) warnings.push({ code: 'few_trials', level: 'info', text: `${r} trials were run; 3 are recommended for a better estimate of repeatability.` });
  if (tolerance === null) warnings.push({ code: 'no_tolerance', level: 'info', text: 'Both specification limits are needed to judge the result against the tolerance, so only the study variation is judged.' });
  if (anova.interactionKept) warnings.push({ code: 'interaction_significant', level: 'warning', text: 'The appraisers measure some parts differently from others (a significant appraiser × part interaction). Look at the interaction chart before trusting the totals.' });
  if (anova.clamped.length) warnings.push({ code: 'negative_variance', level: 'info', text: `The estimate for ${anova.clamped.join(' and ')} came out negative and was set to zero.` });
  if (totalVar === 0) warnings.push({ code: 'no_variation', level: 'warning', text: 'Every reading is identical, so there is no variation to analyse.' });
  if (outsideRange.length) warnings.push({ code: 'range_outside', level: 'warning', text: `${outsideRange.length} range${outsideRange.length === 1 ? '' : 's'} are above the control limit: those readings are less repeatable than the rest. Check them for a recording error or a different method.` });
  if (resolution !== null && resolution > 0) {
    if (tolerance !== null && resolution / tolerance > 0.05) warnings.push({ code: 'resolution_tolerance', level: 'warning', text: `The gauge's resolution is ${((100 * resolution) / tolerance).toFixed(1)}% of the tolerance; 5% or less is expected.` });
    if (totalSd > 0 && resolution > 0.1 * sigma * totalSd) warnings.push({ code: 'resolution_variation', level: 'warning', text: 'The gauge reads in steps larger than a tenth of the total variation, so it may not tell the parts apart.' });
  }

  const verdict = grrVerdict({ pctStudyVar: grrRow.pctStudyVar, pctTolerance: grrRow.pctTolerance, ndc });
  return {
    algorithm: ALGORITHM_VERSION,
    criteria: CRITERIA_ID,
    design,
    options: { sigma, alpha, lower, upper, tolerance, resolution },
    anova,
    variation,
    ndc,
    rangeMethod: rangeOut,
    charts: {
      cellMeans: anova.cellMeans,
      appraiserMeans: anova.appraiserMeans,
      partMeans: anova.partMeans,
      range: { centre: averageRange, ucl: rangeUcl, lcl: rangeLcl, points: rangePoints, outside: outsideRange },
      average: { centre: anova.grandMean, ucl: averageUcl, lcl: averageLcl, points: averagePoints, fractionOutside: outsideAverage.length / averagePoints.length },
    },
    verdict,
    warnings,
  };
}
