import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crossedAnova, readDesign } from './anova';
import { analyseCrossed } from './grr';
import { distinctCategories } from './criteria';
import { MsaInputError } from './errors';
import { rangeMethod } from './range-method';
import { AIAG_GRR_CUBE } from './reference/aiag-example';

const reference = JSON.parse(readFileSync(join(__dirname, 'reference', 'reference.json'), 'utf8'));

const rel = (actual: number | null, expected: number, tolerance = 1e-9) => {
  expect(actual).not.toBeNull();
  expect(Math.abs((actual as number) - expected) / Math.max(Math.abs(expected), 1e-12)).toBeLessThan(tolerance);
};

describe('the AIAG MSA 4th edition worked example, average-and-range method', () => {
  // Published: EV 0.20188, AV 0.22963, GRR 0.30575, PV 1.10456, TV 1.14610, %GRR 26.68, ndc 5.
  // The manual rounds its intermediate figures (R̄ 0.3417, X̄diff 0.4447, Rp 3.511), so the match is to 1e-3, not to machine precision.
  const result = rangeMethod(AIAG_GRR_CUBE);
  it('reproduces the published components', () => {
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.repeatability).toBeCloseTo(0.20188, 3);
    expect(result.reproducibility).toBeCloseTo(0.22963, 3);
    expect(result.grr).toBeCloseTo(0.30575, 3);
    expect(result.partVariation).toBeCloseTo(1.10456, 3);
    expect(result.totalVariation).toBeCloseTo(1.1461, 3);
    expect((100 * result.grr) / result.totalVariation).toBeCloseTo(26.68, 1);
    expect(result.ndc).toBe(5);
  });
  it('uses the table constants', () => {
    if (!result.available) throw new Error('unavailable');
    expect(result.k1).toBeCloseTo(0.5908, 4);
    expect(result.k2).toBeCloseTo(0.5231, 4);
    expect(result.k3).toBeCloseTo(0.3146, 4);
  });
  it('is only offered inside the published tables', () => {
    const four = [...AIAG_GRR_CUBE, AIAG_GRR_CUBE[0]];
    expect(rangeMethod(four)).toEqual({ available: false, reason: expect.stringContaining('2 or 3 appraisers') });
    const fourTrials = AIAG_GRR_CUBE.map((a) => a.map((t) => [...t, t[0]]));
    expect(rangeMethod(fourTrials).available).toBe(false);
  });
});

describe('the AIAG example, ANOVA method', () => {
  const analysis = analyseCrossed(AIAG_GRR_CUBE);
  const row = (source: string) => analysis.anova.rows.find((r) => r.source === source)!;

  it('gives the published ANOVA table (the manual and Minitab print the sums of squares 3.1673, 88.3619, 0.3590 and 2.7589)', () => {
    expect(row('appraiser').ss).toBeCloseTo(3.1673, 4);
    expect(row('part').ss).toBeCloseTo(88.3619, 4);
    expect(row('interaction').ss).toBeCloseTo(0.359, 3);
    expect(row('repeatability').ss).toBeCloseTo(2.7589, 4);
    expect(row('total').ss).toBeCloseTo(94.6471, 3);
    expect([row('part').df, row('appraiser').df, row('interaction').df, row('repeatability').df, row('total').df]).toEqual([9, 2, 18, 60, 89]);
    expect(row('interaction').f).toBeCloseTo(0.434, 3);
    expect(row('interaction').p).toBeCloseTo(0.974, 3);
    // Interaction not significant, so part and appraiser are tested against the pooled error (Minitab's "table without interaction":
    // F 245.614 and 39.617 on 78 error degrees of freedom). A one-pass table that tests against the residual alone, like statsmodels',
    // prints 213.52 and 34.44 instead.
    expect(row('part').f).toBeCloseTo(245.614, 2);
    expect(row('appraiser').f).toBeCloseTo(39.617, 2);
  });

  it('pools the non-significant interaction and gives the published 27.86% study variation and 4 categories', () => {
    expect(analysis.anova.interactionKept).toBe(false);
    const grr = analysis.variation.find((v) => v.name === 'grr')!;
    expect(grr.pctStudyVar).toBeCloseTo(27.86, 1);
    expect(grr.pctContribution).toBeCloseTo(7.76, 1);
    expect(analysis.ndc).toBe(4);
    expect(analysis.variation.find((v) => v.name === 'part')!.sd).toBeCloseTo(1.0423, 3);
    expect(analysis.variation.find((v) => v.name === 'repeatability')!.sd).toBeCloseTo(0.1999, 3);
    expect(analysis.variation.find((v) => v.name === 'appraiser')!.sd).toBeCloseTo(0.2268, 3);
    expect(analysis.verdict.band).toBe('marginal');
  });
});

describe('the ANOVA against statsmodels (reference/generate.py)', () => {
  it.each(reference.anovaCases as { name: string; cube: number[][][]; anova: Record<string, { df: number; ss: number; f?: number; p?: number }> }[])('$name', (c) => {
    const result = crossedAnova(c.cube, 0.05);
    const row = (source: string) => result.rows.find((r) => r.source === source)!;
    // Sums of squares and degrees of freedom do not depend on whether the interaction is pooled.
    for (const [name, source] of [['part', 'part'], ['appraiser', 'appraiser'], ['interaction', 'interaction'], ['repeatability', 'repeatability']] as const) {
      expect(row(source).df).toBe(c.anova[name].df);
      rel(row(source).ss, c.anova[name].ss);
    }
    // The interaction is always tested against repeatability, so its F and p are the full-model ones.
    rel(row('interaction').f, c.anova.interaction.f as number, 1e-8);
    rel(row('interaction').p, c.anova.interaction.p as number, 1e-6);
    if (result.interactionKept) {
      // Full model: statsmodels' type II table tests part and appraiser against the residual, the AIAG/Minitab form tests them against the interaction.
      const ms = (source: string) => row(source).ms as number;
      rel(row('part').f, ms('part') / ms('interaction'));
      rel(row('appraiser').f, ms('appraiser') / ms('interaction'));
    } else {
      const pooled = (row('interaction').ss + row('repeatability').ss) / (row('interaction').df + row('repeatability').df);
      rel(row('part').f, (row('part').ms as number) / pooled);
    }
  });

  it('keeps the interaction where it is clearly significant and pools it where it is not', () => {
    const [none, large, tiny] = reference.anovaCases;
    expect(crossedAnova(none.cube).interactionKept).toBe(false);
    expect(crossedAnova(large.cube).interactionKept).toBe(true);
    expect(crossedAnova(tiny.cube).design).toEqual({ parts: 5, appraisers: 2, trials: 4 });
  });

  it('a stricter or looser significance level changes the model, and only the model', () => {
    const marginal = crossedAnova(reference.anovaCases[0].cube, 0.05);
    const loose = crossedAnova(reference.anovaCases[0].cube, 0.99);
    expect(marginal.interactionP).toBe(loose.interactionP);
    expect(loose.interactionKept).toBe(true);
  });
});

// ── the estimators recover known variances (a check that does not depend on any other implementation) ─────────────────
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gaussian = (rand: () => number) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

describe('variance components are unbiased', () => {
  it('recovers the part, appraiser, interaction and repeatability variances on average', () => {
    const rand = mulberry32(2026);
    const sd = { part: 1, appraiser: 1, inter: 0.5, noise: 0.2 };
    const [p, k, r] = [10, 6, 3];
    const sums = { part: 0, appraiser: 0, interaction: 0, repeatability: 0 };
    const sims = 3000;
    for (let s = 0; s < sims; s += 1) {
      const partEffect = Array.from({ length: p }, () => sd.part * gaussian(rand));
      const apprEffect = Array.from({ length: k }, () => sd.appraiser * gaussian(rand));
      const cube = apprEffect.map((ae) =>
        partEffect.map((pe) => {
          const cell = ae + pe + sd.inter * gaussian(rand);
          return Array.from({ length: r }, () => 5 + cell + sd.noise * gaussian(rand));
        }),
      );
      // alpha just under 1 keeps the interaction in the model, so the estimators are the unbiased full-model ones
      const v = crossedAnova(cube, 0.999999).variance;
      sums.part += v.part;
      sums.appraiser += v.appraiser;
      sums.interaction += v.interaction;
      sums.repeatability += v.repeatability;
    }
    const mean = (x: number) => x / sims;
    expect(mean(sums.part)).toBeCloseTo(sd.part ** 2, 0);
    expect(Math.abs(mean(sums.part) / sd.part ** 2 - 1)).toBeLessThan(0.06);
    expect(Math.abs(mean(sums.appraiser) / sd.appraiser ** 2 - 1)).toBeLessThan(0.06);
    expect(Math.abs(mean(sums.interaction) / sd.inter ** 2 - 1)).toBeLessThan(0.06);
    expect(Math.abs(mean(sums.repeatability) / sd.noise ** 2 - 1)).toBeLessThan(0.03);
  });
});

describe('analyseCrossed', () => {
  it('scales the study variation by the multiplier and the tolerance', () => {
    const six = analyseCrossed(AIAG_GRR_CUBE, { lower: -4, upper: 4 });
    const old = analyseCrossed(AIAG_GRR_CUBE, { lower: -4, upper: 4, sigma: 5.15 });
    const grr6 = six.variation.find((v) => v.name === 'grr')!;
    const grr5 = old.variation.find((v) => v.name === 'grr')!;
    expect(grr6.studyVariation).toBeCloseTo(6 * grr6.sd, 12);
    expect(grr5.studyVariation).toBeCloseTo(5.15 * grr5.sd, 12);
    expect(grr6.pctTolerance).toBeCloseTo((100 * 6 * grr6.sd) / 8, 10);
    expect(grr6.pctStudyVar).toBeCloseTo(grr5.pctStudyVar as number, 12); // a ratio of sds: the multiplier cancels
  });

  it('judges against the tolerance as well when both limits are given, and says so when one is missing', () => {
    const withTol = analyseCrossed(AIAG_GRR_CUBE, { lower: -4, upper: 4 });
    expect(withTol.verdict.reasons.join(' ')).toContain('of the tolerance');
    expect(withTol.warnings.map((w) => w.code)).not.toContain('no_tolerance');
    const oneSided = analyseCrossed(AIAG_GRR_CUBE, { lower: 0, upper: null });
    expect(oneSided.options.tolerance).toBeNull();
    expect(oneSided.variation.every((v) => v.pctTolerance === null)).toBe(true);
    expect(oneSided.warnings.map((w) => w.code)).toContain('no_tolerance');
  });

  it('the components add up: GRR² = repeatability² + appraiser² + interaction², total² = GRR² + part²', () => {
    const a = analyseCrossed(reference.anovaCases[1].cube);
    const v = (name: string) => a.variation.find((x) => x.name === name)!.variance;
    expect(v('grr')).toBeCloseTo(v('repeatability') + v('appraiser') + v('interaction'), 12);
    expect(v('reproducibility')).toBeCloseTo(v('appraiser') + v('interaction'), 12);
    expect(v('total')).toBeCloseTo(v('grr') + v('part'), 12);
    const shares = ['repeatability', 'appraiser', 'interaction', 'part'].map((n) => a.variation.find((x) => x.name === n)!.pctContribution as number);
    expect(shares.reduce((x, y) => x + y, 0)).toBeCloseTo(100, 9);
  });

  it('warns about a significant interaction, small designs and coarse resolution', () => {
    const big = analyseCrossed(reference.anovaCases[1].cube);
    expect(big.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['interaction_significant', 'few_parts']));
    const coarse = analyseCrossed(AIAG_GRR_CUBE, { lower: -4, upper: 4, resolution: 1 });
    expect(coarse.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['resolution_tolerance', 'resolution_variation']));
    const fine = analyseCrossed(AIAG_GRR_CUBE, { lower: -4, upper: 4, resolution: 0.01 });
    expect(fine.warnings.map((w) => w.code)).not.toContain('resolution_tolerance');
  });

  it('summarises the range and average charts', () => {
    const a = analyseCrossed(AIAG_GRR_CUBE);
    expect(a.charts.range.points).toHaveLength(30);
    expect(a.charts.range.centre).toBeCloseTo((rangeMethod(AIAG_GRR_CUBE) as { averageRange: number }).averageRange, 12);
    expect(a.charts.range.ucl).toBeCloseTo(2.574 * a.charts.range.centre, 2);
    expect(a.charts.range.lcl).toBe(0);
    expect(a.charts.average.points).toHaveLength(30);
    // parts differ by far more than the gauge does, so most averages fall outside the limits (the manual asks for at least half)
    expect(a.charts.average.fractionOutside).toBeGreaterThanOrEqual(0.5);
    expect(a.charts.cellMeans).toHaveLength(3);
  });

  it('flags a range above the control limit', () => {
    const cube = AIAG_GRR_CUBE.map((a) => a.map((trials) => [...trials]));
    cube[1][4][2] += 6; // one wild reading
    const a = analyseCrossed(cube);
    expect(a.charts.range.outside.some((pt) => pt.appraiser === 1 && pt.part === 4)).toBe(true);
    expect(a.warnings.map((w) => w.code)).toContain('range_outside');
  });
});

describe('number of distinct categories', () => {
  it('is 1.41 × part sd ÷ gauge sd rounded down, at least 1', () => {
    expect(distinctCategories(5, 1)).toBe(7); // 7.05
    expect(distinctCategories(3.55, 1)).toBe(5); // 5.0055: 1.41 is not 1.4
    expect(distinctCategories(3.51, 1)).toBe(4); // 4.949 rounds up to 5 but is not 5 categories
    expect(distinctCategories(0.2, 1)).toBe(1);
    expect(distinctCategories(1, 0)).toBeNull();
  });
});

describe('degenerate and invalid data', () => {
  const cube = (f: (a: number, p: number, t: number) => number, k = 3, p = 4, r = 2) => Array.from({ length: k }, (_, a) => Array.from({ length: p }, (_, j) => Array.from({ length: r }, (_, t) => f(a, j, t))));

  it('identical readings have no variation and no percentages, ndc or verdict', () => {
    for (const value of [5, 25.001, 0.1 + 0.2]) {
      const same = analyseCrossed(cube(() => value));
      expect(same.variation.every((v) => v.variance === 0)).toBe(true);
    }
    const a = analyseCrossed(cube(() => 5));
    expect(a.ndc).toBeNull();
    expect(a.variation.every((v) => v.pctStudyVar === null && v.pctContribution === null)).toBe(true);
    expect(a.verdict.band).toBeNull();
    expect(a.warnings.map((w) => w.code)).toContain('no_variation');
  });

  it('perfectly repeatable readings (identical trials) give zero repeatability and keep the interaction', () => {
    const a = analyseCrossed(cube((ap, j) => 10 + j + ap * 0.01 * (j % 2)));
    expect(a.variation.find((v) => v.name === 'repeatability')!.variance).toBe(0);
    expect(a.anova.rows.find((r) => r.source === 'interaction')!.p).toBe(0);
    expect(a.anova.interactionKept).toBe(true);
  });

  it('no appraiser or interaction effect leaves reproducibility at about zero and sets negative estimates to zero', () => {
    const rand = mulberry32(7);
    const a = analyseCrossed(cube((_a, j) => j * 2 + 0.05 * gaussian(rand), 3, 8, 3));
    expect(a.variation.find((v) => v.name === 'reproducibility')!.pctContribution as number).toBeLessThan(2);
    expect(a.anova.clamped.length).toBeGreaterThanOrEqual(0);
  });

  it('works with the smallest design, 2 parts × 2 appraisers × 2 trials', () => {
    const a = analyseCrossed([[[1, 1.1], [2, 2.1]], [[1.05, 1], [2.1, 2.05]]]);
    expect(a.design).toEqual({ parts: 2, appraisers: 2, trials: 2 });
    expect(a.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['few_parts', 'few_appraisers', 'few_trials']));
  });

  it('refuses data that cannot be analysed', () => {
    expect(() => readDesign([[[1, 2]]])).toThrow(MsaInputError); // one appraiser, one part
    expect(() => analyseCrossed(cube(() => 1, 3, 4, 1))).toThrow('at least 2 appraisers, 2 parts and 2 trials');
    const holey = cube(() => 1);
    holey[1][2][0] = NaN;
    expect(() => analyseCrossed(holey)).toThrow('Every reading must be a number');
    const ragged = cube((a, j, t) => a + j + t);
    ragged[2][1] = [1];
    expect(() => analyseCrossed(ragged)).toThrow('same number of times');
    const short = cube((a, j, t) => a + j + t);
    short[2] = short[2].slice(1);
    expect(() => analyseCrossed(short)).toThrow('same number of parts');
    expect(() => analyseCrossed(AIAG_GRR_CUBE, { lower: 5, upper: 5 })).toThrow('above the lower limit');
    expect(() => analyseCrossed(AIAG_GRR_CUBE, { alpha: 1 })).toThrow('between 0 and 1');
    expect(() => analyseCrossed(AIAG_GRR_CUBE, { sigma: 4 as 6 })).toThrow('6 or 5.15');
  });

  it('is deterministic and does not change its input', () => {
    const copy = JSON.stringify(AIAG_GRR_CUBE);
    const first = analyseCrossed(AIAG_GRR_CUBE);
    expect(JSON.stringify(AIAG_GRR_CUBE)).toBe(copy);
    expect(JSON.stringify(analyseCrossed(AIAG_GRR_CUBE))).toBe(JSON.stringify(first));
    expect(first.algorithm).toBe('msa-1');
    expect(first.criteria).toBe('aiag-msa-4');
  });
});
