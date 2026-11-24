/**
 * Gauge R&R coverage (docs/gauge-rr-plan.md §6): for every critical or major characteristic of an effective control plan revision, each gauge that recorded readings
 * for it in the last twelve months, and what the latest completed study of that gauge and characteristic says. Information only: nothing here changes anything.
 */
export const COVERAGE_STATES = ['no_readings', 'no_study', 'expired', 'not_accepted', 'not_judged', 'marginal', 'acceptable'] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];

/** States a person should look at (everything but an acceptable study). */
export const NEEDS_ATTENTION: readonly CoverageState[] = ['no_study', 'expired', 'not_accepted', 'not_judged', 'marginal'];

export interface StudyFacts {
  validUntil: string | null;
  conclusion: string | null;
  verdict: string | null;
}

/**
 * The state of one gauge and characteristic. An expired study no longer counts, so it is "expired" whatever it said. A study the person concluded "not accepted",
 * or whose result is unacceptable, is "not accepted"; a result that could not be judged (for example one limit missing) is "not judged"; the rest follow the verdict.
 * `today` is the caller's day (YYYY-MM-DD); a study is valid through its valid-until date.
 */
export function coverageState(hasGauge: boolean, study: StudyFacts | null, today: string): CoverageState {
  if (!hasGauge) return 'no_readings';
  if (!study) return 'no_study';
  if (study.validUntil && study.validUntil < today) return 'expired';
  if (study.conclusion === 'not_accepted' || study.verdict === 'unacceptable') return 'not_accepted';
  if (study.verdict === 'marginal') return 'marginal';
  if (study.verdict === 'acceptable') return 'acceptable';
  return 'not_judged';
}

/** The worst state among several (for a badge that stands for every gauge of one characteristic): the first of COVERAGE_STATES' badness order. */
const BADNESS: CoverageState[] = ['not_accepted', 'expired', 'no_study', 'not_judged', 'marginal', 'no_readings', 'acceptable'];
export const worstState = (states: readonly CoverageState[]): CoverageState | null => (states.length === 0 ? null : BADNESS.find((s) => states.includes(s)) ?? null);
