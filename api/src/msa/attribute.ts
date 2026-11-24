import { CRITERIA_ID, effectivenessBand, falseAlarmBand, kappaBand, missRateBand, worstBand, type Band } from './criteria';
import { MsaInputError, type MsaWarning } from './errors';

/**
 * Attribute agreement analysis for accept / reject decisions.
 *
 *   standard[sample]                 true = the sample is good (the reference says accept)
 *   ratings[appraiser][sample][trial] true = the appraiser accepted it
 *
 * Per appraiser (AIAG MSA 4th edition, attribute study; every decision counts, n × trials opportunities):
 *   effectiveness = correct decisions ÷ opportunities
 *   miss rate = bad samples accepted ÷ opportunities on bad samples          false-alarm rate = good samples rejected ÷ opportunities on good samples
 * and, as Minitab's attribute agreement analysis reports them (a whole sample must agree, so a mixed sample counts as a disagreement):
 *   within appraiser = samples where all of the appraiser's trials agree ÷ n
 *   vs standard      = samples where all trials equal the standard ÷ n
 *   between appraisers = samples where every appraiser's every trial agrees ÷ n       all vs standard = … equals the standard ÷ n
 * Kappa: Fleiss' kappa across an appraiser's trials (within), across every appraiser's trials (between), and, as Minitab defines it, the mean over the
 * appraiser's trials of Fleiss' kappa between that trial and the standard (the standard treated as a second rater). Kappa is not defined when every rating falls in one category (null, with a warning).
 * The verdict is the worst band of effectiveness, miss rate and false-alarm rate over the appraisers (kappa is given its own band).
 */
export const ALGORITHM_VERSION = 'msa-1';
export const RECOMMENDED_SAMPLES = 30;

export interface AttributeInput {
  standard: readonly boolean[];
  ratings: readonly (readonly (readonly boolean[])[])[];
}

export interface Fraction {
  matched: number;
  total: number;
  rate: number | null;
}

export interface AppraiserResult {
  appraiser: number;
  within: Fraction;
  vsStandard: Fraction;
  /** Decision-level counts behind the rates. */
  goodAccepted: number;
  goodRejected: number;
  badAccepted: number;
  badRejected: number;
  effectiveness: number;
  missRate: number | null;
  falseAlarmRate: number | null;
  kappaWithin: number | null;
  kappaVsStandard: number | null;
  bands: { effectiveness: Band; missRate: Band | null; falseAlarmRate: Band | null; kappaVsStandard: Band | null };
  verdict: Band;
}

export interface AttributeResult {
  algorithm: typeof ALGORITHM_VERSION;
  criteria: typeof CRITERIA_ID;
  design: { samples: number; appraisers: number; trials: number; goodSamples: number; badSamples: number };
  appraisers: AppraiserResult[];
  between: Fraction;
  kappaBetween: number | null;
  allVsStandard: Fraction;
  overall: { effectiveness: number; missRate: number | null; falseAlarmRate: number | null };
  verdict: { band: Band; reasons: string[] };
  warnings: MsaWarning[];
}

const fraction = (matched: number, total: number): Fraction => ({ matched, total, rate: total > 0 ? matched / total : null });

/** Fleiss' kappa for two categories; `accepts[i]` = how many of `raters` accepted subject i. Null when undefined. */
export function fleissKappa(accepts: readonly number[], raters: number): number | null {
  const n = accepts.length;
  if (n === 0 || raters < 2) return null;
  let agreement = 0;
  let accepted = 0;
  for (const a of accepts) {
    const rejected = raters - a;
    agreement += (a * a + rejected * rejected - raters) / (raters * (raters - 1));
    accepted += a;
  }
  const meanAgreement = agreement / n;
  const pAccept = accepted / (n * raters);
  const expected = pAccept ** 2 + (1 - pAccept) ** 2;
  return expected === 1 ? null : (meanAgreement - expected) / (1 - expected);
}

/** Cohen's kappa for pairs of decisions. Null when undefined. */
export function cohenKappa(pairs: readonly (readonly [boolean, boolean])[]): number | null {
  const n = pairs.length;
  if (n === 0) return null;
  let agree = 0;
  let firstYes = 0;
  let secondYes = 0;
  for (const [a, b] of pairs) {
    if (a === b) agree += 1;
    if (a) firstYes += 1;
    if (b) secondYes += 1;
  }
  const observed = agree / n;
  const expected = (firstYes / n) * (secondYes / n) + (1 - firstYes / n) * (1 - secondYes / n);
  return expected === 1 ? null : (observed - expected) / (1 - expected);
}

export function analyseAttribute(input: AttributeInput): AttributeResult {
  const { standard, ratings } = input;
  const n = standard.length;
  const k = ratings.length;
  const r = ratings[0]?.[0]?.length ?? 0;
  if (n < 2 || k < 1 || r < 1) throw new MsaInputError('An attribute study needs at least 2 samples, 1 appraiser and 1 trial.');
  if (k < 2 && r < 2) throw new MsaInputError('An attribute study needs at least 2 appraisers or 2 trials to measure agreement.');
  for (const byAppraiser of ratings) {
    if (byAppraiser.length !== n) throw new MsaInputError('Every appraiser must rate every sample.');
    for (const trials of byAppraiser) {
      if (trials.length !== r) throw new MsaInputError('Every sample must be rated the same number of times.');
      if (trials.some((v) => typeof v !== 'boolean')) throw new MsaInputError('Every rating must be accept or reject.');
    }
  }
  if (standard.some((v) => typeof v !== 'boolean')) throw new MsaInputError('Every reference decision must be accept or reject.');

  const goodSamples = standard.filter(Boolean).length;
  const badSamples = n - goodSamples;
  const warnings: MsaWarning[] = [];

  const appraisers: AppraiserResult[] = ratings.map((byAppraiser, a) => {
    let withinMatched = 0;
    let vsStdMatched = 0;
    let goodAccepted = 0;
    let goodRejected = 0;
    let badAccepted = 0;
    let badRejected = 0;
    const accepts: number[] = [];
    byAppraiser.forEach((trials, s) => {
      if (trials.every((v) => v === trials[0])) withinMatched += 1;
      if (trials.every((v) => v === standard[s])) vsStdMatched += 1;
      accepts.push(trials.filter(Boolean).length);
      for (const v of trials) {
        if (standard[s] && v) goodAccepted += 1;
        else if (standard[s]) goodRejected += 1;
        else if (v) badAccepted += 1;
        else badRejected += 1;
      }
    });
    const effectiveness = (goodAccepted + badRejected) / (n * r);
    const missRate = badSamples > 0 ? badAccepted / (badSamples * r) : null;
    const falseAlarmRate = goodSamples > 0 ? goodRejected / (goodSamples * r) : null;
    const kappaWithin = r >= 2 ? fleissKappa(accepts, r) : null;
    // Minitab: for each trial, Fleiss' kappa of (that trial, the standard) treated as two raters; the appraiser's kappa is the mean over trials.
    const perTrial = Array.from({ length: r }, (_, t) =>
      fleissKappa(byAppraiser.map((trials, s) => Number(trials[t]) + Number(standard[s])), 2),
    );
    const kappaValues = perTrial.filter((v): v is number => v !== null);
    const kappaVsStandard = kappaValues.length < r ? null : kappaValues.reduce((t, v) => t + v, 0) / r;
    const bands = {
      effectiveness: effectivenessBand(effectiveness),
      missRate: missRate === null ? null : missRateBand(missRate),
      falseAlarmRate: falseAlarmRate === null ? null : falseAlarmBand(falseAlarmRate),
      kappaVsStandard: kappaVsStandard === null ? null : kappaBand(kappaVsStandard),
    };
    return {
      appraiser: a,
      within: fraction(withinMatched, n),
      vsStandard: fraction(vsStdMatched, n),
      goodAccepted,
      goodRejected,
      badAccepted,
      badRejected,
      effectiveness,
      missRate,
      falseAlarmRate,
      kappaWithin,
      kappaVsStandard,
      bands,
      verdict: worstBand([bands.effectiveness, bands.missRate, bands.falseAlarmRate])!,
    };
  });

  let betweenMatched = 0;
  let allVsStd = 0;
  const allAccepts: number[] = [];
  for (let s = 0; s < n; s += 1) {
    const all = ratings.flatMap((byAppraiser) => byAppraiser[s]);
    if (all.every((v) => v === all[0])) betweenMatched += 1;
    if (all.every((v) => v === standard[s])) allVsStd += 1;
    allAccepts.push(all.filter(Boolean).length);
  }
  const kappaBetween = k * r >= 2 ? fleissKappa(allAccepts, k * r) : null;

  const sum = (f: (x: AppraiserResult) => number) => appraisers.reduce((t, x) => t + f(x), 0);
  const overall = {
    effectiveness: sum((x) => x.goodAccepted + x.badRejected) / (k * n * r),
    missRate: badSamples > 0 ? sum((x) => x.badAccepted) / (k * badSamples * r) : null,
    falseAlarmRate: goodSamples > 0 ? sum((x) => x.goodRejected) / (k * goodSamples * r) : null,
  };
  const band = worstBand(appraisers.map((x) => x.verdict))!;
  const reasons = appraisers.map((x) => `Appraiser ${x.appraiser + 1}: effectiveness ${(100 * x.effectiveness).toFixed(1)}%${x.missRate === null ? '' : `, miss rate ${(100 * x.missRate).toFixed(1)}%`}${x.falseAlarmRate === null ? '' : `, false-alarm rate ${(100 * x.falseAlarmRate).toFixed(1)}% (${x.verdict})`}.`);

  if (n < RECOMMENDED_SAMPLES) warnings.push({ code: 'few_samples', level: 'info', text: `${n} samples were rated; ${RECOMMENDED_SAMPLES} to 50 are recommended.` });
  if (badSamples === 0) warnings.push({ code: 'no_bad_samples', level: 'warning', text: 'No sample is a known reject, so the miss rate cannot be judged.' });
  if (goodSamples === 0) warnings.push({ code: 'no_good_samples', level: 'warning', text: 'No sample is a known accept, so the false-alarm rate cannot be judged.' });
  else if (badSamples > 0 && Math.min(goodSamples, badSamples) / n < 0.25) warnings.push({ code: 'unbalanced_samples', level: 'info', text: 'Fewer than a quarter of the samples are on one side of the line; a mix of clearly good, clearly bad and borderline samples gives a better test.' });
  if (appraisers.some((x) => x.kappaVsStandard === null) || kappaBetween === null) warnings.push({ code: 'kappa_undefined', level: 'info', text: 'Kappa is not defined where every rating fell in one category.' });

  return {
    algorithm: ALGORITHM_VERSION,
    criteria: CRITERIA_ID,
    design: { samples: n, appraisers: k, trials: r, goodSamples, badSamples },
    appraisers,
    between: fraction(betweenMatched, n),
    kappaBetween,
    allVsStandard: fraction(allVsStd, n),
    overall,
    verdict: { band, reasons },
    warnings,
  };
}
