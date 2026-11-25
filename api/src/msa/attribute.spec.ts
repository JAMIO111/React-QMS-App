import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyseAttribute, cohenKappa, fleissKappa } from './attribute';
import { MsaInputError } from './errors';
import { effectivenessBand, falseAlarmBand, grrBand, kappaBand, missRateBand, worstBand } from './criteria';

const reference = JSON.parse(readFileSync(join(__dirname, 'reference', 'reference.json'), 'utf8'));

type Case = {
  standard: boolean[];
  ratings: boolean[][][];
  appraisers: { withinMatched: number; vsStandardMatched: number; goodRejected: number; badAccepted: number; effectiveness: number; miss: number | null; falseAlarm: number | null; kappaWithin: number | null; kappaVsStandard: number }[];
  betweenMatched: number;
  allVsStandardMatched: number;
  kappaBetween: number;
};

describe('attribute agreement against an independent calculation and statsmodels kappa (reference/generate.py)', () => {
  it.each(reference.attributeCases as Case[])('$standard.length samples, $appraisers.length appraisers', (c) => {
    const r = analyseAttribute({ standard: c.standard, ratings: c.ratings });
    c.appraisers.forEach((expected, a) => {
      const got = r.appraisers[a];
      expect(got.within.matched).toBe(expected.withinMatched);
      expect(got.vsStandard.matched).toBe(expected.vsStandardMatched);
      expect(got.goodRejected).toBe(expected.goodRejected);
      expect(got.badAccepted).toBe(expected.badAccepted);
      expect(got.effectiveness).toBeCloseTo(expected.effectiveness, 12);
      if (expected.miss !== null) expect(got.missRate).toBeCloseTo(expected.miss, 12);
      if (expected.falseAlarm !== null) expect(got.falseAlarmRate).toBeCloseTo(expected.falseAlarm, 12);
      if (expected.kappaWithin !== null && got.kappaWithin !== null) expect(got.kappaWithin).toBeCloseTo(expected.kappaWithin, 9);
      expect(got.kappaVsStandard).toBeCloseTo(expected.kappaVsStandard, 9);
    });
    expect(r.between.matched).toBe(c.betweenMatched);
    expect(r.allVsStandard.matched).toBe(c.allVsStandardMatched);
    expect(r.kappaBetween).toBeCloseTo(c.kappaBetween, 9);
  });
});

const make = (n: number, appraisers: number, trials: number, f: (a: number, s: number, t: number) => boolean | undefined, standard?: boolean[]) => {
  const std = standard ?? Array.from({ length: n }, (_, s) => s % 2 === 0);
  return { standard: std, ratings: Array.from({ length: appraisers }, (_, a) => Array.from({ length: n }, (_, s) => Array.from({ length: trials }, (_, t) => f(a, s, t) ?? std[s]))) };
};

describe('known cases', () => {
  it('perfect agreement: everything 100%, kappa 1, acceptable', () => {
    const r = analyseAttribute(make(30, 3, 3, () => undefined));
    expect(r.appraisers.every((a) => a.effectiveness === 1 && a.missRate === 0 && a.falseAlarmRate === 0 && a.kappaVsStandard === 1 && a.kappaWithin === 1)).toBe(true);
    expect(r.between.rate).toBe(1);
    expect(r.allVsStandard.rate).toBe(1);
    expect(r.kappaBetween).toBe(1);
    expect(r.verdict.band).toBe('acceptable');
    expect(r.warnings).toEqual([]);
  });

  it('an appraiser who is always wrong: effectiveness 0, kappa −1, unacceptable', () => {
    const std = Array.from({ length: 20 }, (_, s) => s % 2 === 0);
    const r = analyseAttribute({ standard: std, ratings: [std.map((v) => [!v, !v]), std.map((v) => [v, v])] });
    expect(r.appraisers[0].effectiveness).toBe(0);
    expect(r.appraisers[0].kappaVsStandard).toBe(-1);
    expect(r.appraisers[0].kappaWithin).toBe(1); // consistent with himself, just wrong
    expect(r.appraisers[0].verdict).toBe('unacceptable');
    expect(r.appraisers[1].verdict).toBe('acceptable');
    expect(r.verdict.band).toBe('unacceptable');
    expect(r.between.rate).toBe(0); // the two appraisers never agree
    expect(r.kappaBetween).toBeCloseTo(-1 / 3, 12);
  });

  it('counts misses on bad samples and false alarms on good samples separately', () => {
    // 10 good + 10 bad, one trial each; the appraiser accepts 1 bad (miss 10%) and rejects 2 good (false alarm 20%)
    const std = [...Array(10).fill(true), ...Array(10).fill(false)];
    const decisions = std.map((v, s) => (s === 12 ? true : s === 3 || s === 4 ? false : v));
    const r = analyseAttribute({ standard: std, ratings: [decisions.map((d) => [d, d])] });
    const a = r.appraisers[0];
    expect(a.missRate).toBeCloseTo(0.1, 12);
    expect(a.falseAlarmRate).toBeCloseTo(0.2, 12);
    expect(a.effectiveness).toBeCloseTo(17 / 20, 12);
    expect([a.goodAccepted, a.goodRejected, a.badAccepted, a.badRejected]).toEqual([16, 4, 2, 18]); // decisions, two trials each
    expect(a.bands).toMatchObject({ effectiveness: 'marginal', missRate: 'unacceptable', falseAlarmRate: 'unacceptable' });
  });

  it('a mixed sample counts as a disagreement within the appraiser', () => {
    const r = analyseAttribute(make(10, 2, 3, (a, s, t) => (a === 0 && s === 0 && t === 1 ? false : undefined), Array(10).fill(true)));
    expect(r.appraisers[0].within.matched).toBe(9);
    expect(r.appraisers[0].vsStandard.matched).toBe(9);
    expect(r.appraisers[1].within.matched).toBe(10);
    expect(r.between.matched).toBe(9);
  });

  it('kappa is not defined when every rating is in one category, and says so', () => {
    const r = analyseAttribute(make(10, 2, 2, () => true, Array(10).fill(true)));
    expect(r.kappaBetween).toBeNull();
    expect(r.appraisers[0].kappaVsStandard).toBeNull();
    expect(r.appraisers[0].effectiveness).toBe(1);
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['kappa_undefined', 'no_bad_samples', 'few_samples']));
    expect(r.appraisers[0].missRate).toBeNull();
  });

  it('works with one appraiser and two trials, or two appraisers and one trial', () => {
    expect(analyseAttribute(make(10, 1, 2, () => undefined)).between.rate).toBe(1);
    const one = analyseAttribute(make(10, 2, 1, () => undefined));
    expect(one.appraisers[0].kappaWithin).toBeNull(); // one trial: no within-appraiser agreement to measure
    expect(one.kappaBetween).toBe(1);
  });

  it('refuses data that cannot be analysed', () => {
    expect(() => analyseAttribute({ standard: [true], ratings: [[[true]]] })).toThrow(MsaInputError);
    expect(() => analyseAttribute(make(10, 1, 1, () => undefined))).toThrow('at least 2 appraisers or 2 trials');
    expect(() => analyseAttribute({ standard: [true, false], ratings: [[[true]], [[true]]] })).toThrow('every sample');
    expect(() => analyseAttribute({ standard: [true, false], ratings: [[[true, true], [false]]] })).toThrow('same number of times');
    expect(() => analyseAttribute({ standard: [true, false], ratings: [[[true, 1 as unknown as boolean], [false, false]]] })).toThrow('accept or reject');
    expect(() => analyseAttribute({ standard: [true, 'x' as unknown as boolean], ratings: [[[true, true], [false, false]]] })).toThrow('reference decision');
  });
});

describe('kappa and the acceptance bands', () => {
  it('Fleiss and Cohen agree with hand calculations', () => {
    // 4 subjects, 3 raters accepting 3, 3, 0, 0 times: P̄ = 1, P_e = 0.5 → κ = 1
    expect(fleissKappa([3, 3, 0, 0], 3)).toBeCloseTo(1, 12);
    // every subject split 1–2: P_i = 1/3, P̄ = 1/3, P_e = 1/2 → κ = (1/3 − 1/2) / (1 − 1/2) = −1/3
    expect(fleissKappa([1, 2, 1, 2], 3)).toBeCloseTo(-1 / 3, 12);
    expect(cohenKappa([[true, true], [true, true], [false, false], [false, false]])).toBe(1);
    // classic 2×2: observed 0.7, expected 0.5 → κ = 0.4
    const pairs: [boolean, boolean][] = [...Array(45).fill([true, true]), ...Array(5).fill([true, false]), ...Array(25).fill([false, false]), ...Array(25).fill([false, true])] as [boolean, boolean][];
    expect(cohenKappa(pairs)).toBeCloseTo(0.4, 12);
    expect(fleissKappa([], 3)).toBeNull();
    expect(fleissKappa([1, 0], 1)).toBeNull();
  });

  it('bands sit exactly on the published edges', () => {
    expect([9.99, 10, 30, 30.01].map(grrBand)).toEqual(['acceptable', 'marginal', 'marginal', 'unacceptable']);
    expect([0.9, 0.8999, 0.8, 0.79].map(effectivenessBand)).toEqual(['acceptable', 'marginal', 'marginal', 'unacceptable']);
    expect([0.02, 0.0201, 0.05, 0.0501].map(missRateBand)).toEqual(['acceptable', 'marginal', 'marginal', 'unacceptable']);
    expect([0.05, 0.0501, 0.1, 0.1001].map(falseAlarmBand)).toEqual(['acceptable', 'marginal', 'marginal', 'unacceptable']);
    expect([0.75, 0.74, 0.4, 0.39].map(kappaBand)).toEqual(['acceptable', 'marginal', 'marginal', 'unacceptable']);
    expect(worstBand([null, 'acceptable', 'marginal'])).toBe('marginal');
    expect(worstBand([null, undefined])).toBeNull();
  });
});
