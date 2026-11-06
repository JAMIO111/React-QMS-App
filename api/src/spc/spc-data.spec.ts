import { assemble, evaluate, parseRules, ReadingRow } from './spc-data';

let n = 0;
const row = (value: number, over: Partial<ReadingRow> = {}): ReadingRow => ({
  id: `m${++n}`,
  value: String(value),
  measuredAt: new Date(Date.UTC(2026, 10, 1, 8, n)).toISOString(),
  sampleNumber: n,
  subgroupNumber: n,
  isRetest: false,
  inspectionId: 'i1',
  inspectionReference: 'IPI-26-0001',
  inspectionStatus: 'completed',
  unitCode: 'mm',
  chartType: 'imr',
  subgroupSize: 1,
  nominal: 25,
  lower: 24.95,
  upper: 25.05,
  machineId: null,
  lot: null,
  gaugeOverride: false,
  ...over,
});
beforeEach(() => (n = 0));

describe('assemble (only compatible data is charted)', () => {
  it('I-MR: every current reading is a point, in time order', () => {
    const d = assemble([row(25.01), row(24.99), row(25.0)].reverse());
    expect(d.chartType).toBe('imr');
    expect(d.points.map((p) => p.value)).toEqual([25.01, 24.99, 25]);
    expect(d.points.map((p) => p.dispersion)).toEqual([null, expect.closeTo(0.02, 5), expect.closeTo(0.01, 5)]);
    expect(d.excluded).toEqual([]);
  });

  it('leaves out and counts retests, abandoned inspections, other units and other specifications', () => {
    const d = assemble([
      row(25.0),
      row(25.1, { isRetest: true }),
      row(25.0, { inspectionStatus: 'abandoned' }),
      row(0.98, { unitCode: 'in' }),
      row(25.0, { nominal: 24, lower: 23.95, upper: 24.05 }),
      row(25.02),
    ]);
    expect(d.points.map((p) => p.value)).toEqual([25, 25.02]);
    expect(Object.fromEntries(d.excluded.map((e) => [e.reason, e.count]))).toEqual({ retest: 1, abandoned: 1, unit: 1, specification: 1 });
  });

  it('follows the most recent chart type and subgroup size', () => {
    const d = assemble([row(25), row(25.01), row(25.02, { chartType: 'xbar_r', subgroupSize: 3 })]);
    expect(d.chartType).toBe('xbar_r');
    expect(Object.fromEntries(d.excluded.map((e) => [e.reason, e.count]))).toEqual({ chart_type: 2, incomplete_subgroup: 1 });
  });

  it('X-bar/R: only complete subgroups of the right size, by inspection and subgroup number', () => {
    const x = (value: number, sg: number | null, inspectionId = 'i1') => row(value, { chartType: 'xbar_r', subgroupSize: 3, subgroupNumber: sg, inspectionId });
    const d = assemble([x(10, 1), x(11, 1), x(12, 1), x(20, 2), x(21, 2), x(30, null), x(10, 1, 'i2'), x(12, 1, 'i2'), x(14, 1, 'i2')]);
    expect(d.points.map((p) => p.value)).toEqual([11, 12]);
    expect(d.points.map((p) => p.dispersion)).toEqual([2, 4]);
    expect(d.points[1].inspections).toEqual([{ id: 'i2', reference: 'IPI-26-0001' }]);
    expect(Object.fromEntries(d.excluded.map((e) => [e.reason, e.count]))).toEqual({ no_subgroup: 1, incomplete_subgroup: 2 });
  });

  it('keeps unrounded values and flags gauge overrides', () => {
    const d = assemble([row(25.0049999), row(25, { gaugeOverride: true })]);
    expect(d.points[0].readings[0].value).toBe('25.0049999');
    expect(d.points.map((p) => p.gaugeOverride)).toEqual([false, true]);
  });

  it('nothing usable: no chart type', () => {
    expect(assemble([row(1, { isRetest: true })]).points).toEqual([]);
    expect(assemble([]).chartType).toBeNull();
  });
});

describe('evaluate', () => {
  const series = (xs: number[]) => assemble(xs.map((x) => row(x)));

  it('has no limits until there are enough points', () => {
    const r = evaluate(series([1, 2, 3, 4]), null, parseRules(undefined));
    expect(r.limitsSource).toBe('none');
    expect(r.warnings[0]).toMatch(/At least 5 readings/);
  });

  it('shows trial limits, labelled provisional, and flags a point beyond them', () => {
    const r = evaluate(series([10, 10.1, 9.9, 10, 10.05, 9.95, 10, 10.1, 9.9, 10, 14]), null, ['we1']);
    expect(r.limitsSource).toBe('trial');
    expect(r.provisional).toBe(true);
    expect(r.warnings.some((w) => /Trial limits/.test(w))).toBe(true);
    expect(r.signals.map((s) => `${s.rule}@${s.index}`)).toEqual(['we1@10']);
  });

  it('uses a saved baseline when given, and respects the rule switches', () => {
    const base = { centre: 10, ucl: 10.3, lcl: 9.7, dispersionCentre: 0.1, dispersionUcl: 0.33, dispersionLcl: 0, sigma: 0.1 };
    const d = series([10, 10, 10.22, 10.25, 10, 10, 10, 10, 10]);
    expect(evaluate(d, base, ['we1']).limitsSource).toBe('baseline');
    expect(evaluate(d, base, ['we1']).signals).toEqual([]);
    expect(evaluate(d, base, ['we2']).signals.map((s) => s.index)).toEqual([3]);
  });

  it('warns when the data has no variation', () => {
    const r = evaluate(series([5, 5, 5, 5, 5, 5]), null, parseRules(undefined));
    expect(r.noVariation).toBe(true);
    expect(r.signals).toEqual([]);
  });

  it('parses rule lists: absent = all, unknown names ignored, empty = none', () => {
    expect(parseRules(undefined)).toEqual(['we1', 'we2', 'we3', 'we4']);
    expect(parseRules('we1,we9, we4')).toEqual(['we1', 'we4']);
    expect(parseRules('')).toEqual([]);
  });
});
