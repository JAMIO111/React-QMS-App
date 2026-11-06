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
