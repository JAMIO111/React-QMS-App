import { controlLimits, detectSignals, dispersionSignals, isProvisional, MINIMUM_POINTS, plotted } from './spc';

const close = (a: number, b: number, digits = 3) => expect(a).toBeCloseTo(b, digits);

describe('control limits', () => {
  it('I-MR: x̄ ± 3/d2·MR̄ and MR UCL = D4·MR̄', () => {
    const g = [10, 12, 11, 13, 12].map((x) => [x]);
    const l = controlLimits('imr', g);
    close(l.centre, 11.6);
    close(l.dispersionCentre, 1.5); // MR = 2, 1, 2, 1
    close(l.ucl, 11.6 + (3 / 1.128) * 1.5);
    close(l.lcl, 11.6 - (3 / 1.128) * 1.5);
    close(l.dispersionUcl, 3.267 * 1.5);
    expect(l.dispersionLcl).toBe(0);
    close(l.sigma, 1.5 / 1.128);
  });

  it('X-bar/R (n = 3): x̿ ± A2·R̄, D3/D4 on the range', () => {
    const g = [
      [10, 11, 12],
      [11, 12, 13],
      [9, 10, 11],
      [10, 11, 12],
      [10, 12, 14],
    ];
    const { location, dispersion } = plotted('xbar_r', g);
    expect(location).toEqual([11, 12, 10, 11, 12]);
    expect(dispersion).toEqual([2, 2, 2, 2, 4]);
    const l = controlLimits('xbar_r', g);
    close(l.centre, 11.2);
    close(l.dispersionCentre, 2.4);
    close(l.ucl, 11.2 + 1.023 * 2.4);
    close(l.lcl, 11.2 - 1.023 * 2.4);
    close(l.dispersionUcl, 2.574 * 2.4);
    expect(l.dispersionLcl).toBe(0);
    close(l.sigma, 2.4 / 1.693);
  });

  it('uses D3 for larger subgroups (n = 8)', () => {
    const g = Array.from({ length: 5 }, (_, i) => Array.from({ length: 8 }, (_, j) => 10 + ((i + j) % 4)));
    const l = controlLimits('xbar_r', g);
    close(l.dispersionLcl, 0.136 * l.dispersionCentre);
  });

  it('refuses too little data and mixed subgroup sizes', () => {
    expect(() => controlLimits('imr', [[1], [2], [3], [4]])).toThrow(String(MINIMUM_POINTS));
    expect(() => controlLimits('xbar_r', [[1, 2], [1, 2], [1, 2], [1, 2], [1, 2, 3]])).toThrow('same size');
    expect(() => controlLimits('xbar_r', Array(5).fill([1]))).toThrow('2 to 10');
    expect(() => controlLimits('imr', Array(5).fill([1, 2]))).toThrow('individual');
  });

  it('labels few points as provisional', () => {
    expect(isProvisional('imr', 24)).toBe(true);
    expect(isProvisional('imr', 25)).toBe(false);
    expect(isProvisional('xbar_r', 19)).toBe(true);
    expect(isProvisional('xbar_r', 20)).toBe(false);
  });
});

describe('Western Electric rules', () => {
  // centre 0, 1σ = 1 (UCL 3, LCL -3)
  const limits = { centre: 0, ucl: 3, lcl: -3 };
  const rules = (xs: number[], enabled?: Parameters<typeof detectSignals>[2]) => detectSignals(xs, limits, enabled).map((s) => `${s.rule}@${s.index}`);

  it('rule 1: a point beyond 3σ, either side; on the limit is not beyond', () => {
    expect(rules([0, 3.2, 0, -3.5, 3, 0, -3], ['we1'])).toEqual(['we1@1', 'we1@3'])
    expect(rules([0, 3.2, 0, -3.5, 3, 0, -3])).toEqual(['we1@1', 'we1@3']);
  });

  it('rule 2: two of three beyond 2σ on the same side', () => {
    expect(rules([0, 2.5, 0.5, 2.2])).toEqual(['we2@3']);
    expect(rules([2.5, -2.5, 0, 2.5])).toEqual([]); // opposite sides do not count
    expect(rules([2.5, -2.5, 2.5, 0])).toEqual(['we2@2']); // two of three need not be neighbours
    expect(rules([2.5, 0, 0, 0, 2.5])).toEqual([]); // not within three
    expect(detectSignals([0, 2.5, 0.5, 2.2], limits).find((s) => s.rule === 'we2')?.involved).toEqual([1, 3]);
  });

  it('rule 3: four of five beyond 1σ on the same side', () => {
    expect(rules([1.5, 1.2, 0, 1.4, 1.6])).toEqual(['we3@4']);
    expect(rules([1.5, 1.2, 0, 1.4, 0.9])).toEqual([]);
  });

  it('rule 4: eight in a row on one side; flags every point once the run holds', () => {
    const run = [0.1, 0.2, 0.3, 0.1, 0.2, 0.4, 0.1, 0.2];
    expect(rules(run)).toEqual(['we4@7']);
    expect(rules([...run, 0.3])).toEqual(['we4@7', 'we4@8']);
    expect(rules([...run.slice(0, 7), -0.1, 0.2])).toEqual([]);
    expect(rules(run.map((x) => -x))).toEqual(['we4@7']);
    expect(rules([0, ...run.slice(1)])).toEqual([]); // a point on the centre line breaks the run
  });

  it('each rule can be switched off', () => {
    const xs = [0, 3.5, 2.5, 0.5, 2.2];
    expect(rules(xs).sort()).toContain('we1@1');
    expect(rules(xs, ['we2'])).toEqual(['we2@2', 'we2@4'].filter((s) => rules(xs, ['we2']).includes(s)));
    expect(rules(xs, [])).toEqual([]);
    expect(rules(xs, ['we1'])).toEqual(['we1@1']);
  });

  it('uses the distance to each limit for zones, so asymmetric limits stay consistent', () => {
    // upper 1σ = 1, lower 1σ = 2
    const l = { centre: 0, ucl: 3, lcl: -6 };
    expect(detectSignals([0, 2.5, 0.5, 2.2], l).map((s) => s.rule)).toEqual(['we2']);
    expect(detectSignals([0, -2.5, -0.5, -2.2], l)).toEqual([]);
  });

  it('skips zone rules when there is no variation', () => {
    expect(detectSignals([5, 5, 5, 5, 5, 5, 5, 5, 5], { centre: 5, ucl: 5, lcl: 5 })).toEqual([]);
  });

  it('range chart: points above the upper limit', () => {
    expect(dispersionSignals([null, 1, 5, 2, 4.9], { dispersionUcl: 4.9 })).toEqual([2]);
  });
});

import { detectPSignals, pBar, pLimitsAt, pReliability, pSeries, pSigma } from './spc';

describe('P chart', () => {
  const groups = [4, 6, 5, 3, 7, 5, 4, 6, 5, 5].map((d) => ({ n: 100, d }));

  it('centre line is all failures over all checks', () => {
    expect(pBar(groups)).toBeCloseTo(0.05, 10);
    expect(pBar([{ n: 10, d: 1 }, { n: 90, d: 9 }])).toBeCloseTo(0.1, 10); // weighted by size, not a mean of proportions
    expect(pBar([])).toBe(0);
  });

  it('limits are p̄ ± 3σ for the subgroup size, clipped to 0…1', () => {
    close(pSigma(0.05, 100), 0.0217945, 6);
    const l = pLimitsAt(0.05, 100);
    close(l.ucl, 0.05 + 3 * 0.0217945, 5);
    expect(l.lcl).toBe(0); // 0.05 − 0.0654 < 0
    const wide = pLimitsAt(0.2, 25); // σ = 0.08
    close(wide.ucl, 0.44, 6);
    close(wide.lcl, 0, 6);
    expect(pLimitsAt(0.97, 10).ucl).toBe(1);
    // Bigger subgroups give tighter limits.
    expect(pLimitsAt(0.1, 400).ucl).toBeLessThan(pLimitsAt(0.1, 50).ucl);
  });

  it('each point carries its own limits and z-score', () => {
    const pts = pSeries([{ n: 100, d: 5 }, { n: 25, d: 10 }], 0.05);
    close(pts[0].p, 0.05, 10);
    close(pts[0].z, 0, 10);
    close(pts[1].p, 0.4, 10);
    close(pts[1].z, (0.4 - 0.05) / pSigma(0.05, 25), 8);
    expect(pts[1].ucl).toBeGreaterThan(pts[0].ucl);
  });

  it('with no failures in the baseline any failure is a signal', () => {
    const pts = pSeries([{ n: 20, d: 0 }, { n: 20, d: 1 }], 0);
    expect(pts[0].z).toBe(0);
    expect(pts[1].z).toBe(Infinity);
    expect(detectPSignals(pts).map((s) => `${s.rule}@${s.index}`)).toEqual(['we1@1']);
  });

  it('rule 1: a subgroup beyond 3σ, taking its own size into account', () => {
    // 6 of 25 = 24 % is 5.2σ above 5 % for n = 25, but 6 of 100 is only 0.5σ.
    const pts = pSeries([{ n: 100, d: 6 }, { n: 25, d: 6 }], 0.05);
    expect(detectPSignals(pts, ['we1']).map((s) => s.index)).toEqual([1]);
  });

  it('rules 2–4 use the same zones in σ units', () => {
    const run = pSeries(Array.from({ length: 8 }, () => ({ n: 100, d: 6 })), 0.05); // 8 in a row above the centre
    expect(detectPSignals(run, ['we4']).map((s) => s.index)).toEqual([7]);
    const two = pSeries([{ n: 100, d: 5 }, { n: 100, d: 10 }, { n: 100, d: 5 }, { n: 100, d: 10 }], 0.05); // 2.3σ twice in three
    expect(detectPSignals(two, ['we2']).map((s) => s.index)).toEqual([3]);
    expect(detectPSignals(run, [])).toEqual([]);
  });

  it('warns when the normal approximation is unreliable', () => {
    expect(pReliability(groups, 0.05).reliable).toBe(true); // 5 expected failures at n = 100
    expect(pReliability(groups.map((g) => ({ n: 40, d: g.d })), 0.05)).toMatchObject({ reliable: false, expectedFailures: 2 });
    expect(pReliability([], 0).reliable).toBe(false);
  });
});
