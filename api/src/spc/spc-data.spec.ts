import { applySubgroupSize, assemble, assembleDefects, assembleP, commonSize, evaluate, evaluateCount, evaluateP, parseRules, ReadingRow } from './spc-data';

let n = 0;
const row = (value: number, over: Partial<ReadingRow> = {}): ReadingRow => ({
  id: `m${++n}`,
  value: String(value),
  valuePass: null,
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


describe('P chart data', () => {
  const att = (pass: boolean, over: Partial<ReadingRow> = {}): ReadingRow => ({ ...row(0, { chartType: 'p', subgroupSize: null, unitCode: null, nominal: null, lower: null, upper: null, ...over }), value: '', valuePass: pass });
  const checks = (inspectionId: string, n: number, failures: number, over: Partial<ReadingRow> = {}) =>
    Array.from({ length: n }, (_, i) => att(i >= failures, { inspectionId, inspectionReference: `IPI-${inspectionId}`, ...over }));

  it('groups by inspection: n checked and d failed per inspection, in time order', () => {
    const d = assembleP([...checks('a', 10, 2), ...checks('b', 20, 1)], 'inspection');
    expect(d.groups.map((g) => [g.n, g.d])).toEqual([[10, 2], [20, 1]]);
    expect(d.groups[1].inspections).toEqual([{ id: 'b', reference: 'IPI-b' }]);
    expect(d.excluded).toEqual([]);
  });

  it('groups by day (UTC) across inspections', () => {
    const day = (iso: string) => ({ measuredAt: iso });
    const rows = [
      ...checks('a', 5, 1, day('2026-11-01T08:00:00Z')),
      ...checks('b', 5, 1, day('2026-11-01T20:00:00Z')),
      ...checks('c', 10, 0, day('2026-11-02T01:00:00Z')),
    ];
    const d = assembleP(rows, 'day');
    expect(d.groups.map((g) => [g.n, g.d])).toEqual([[10, 2], [10, 0]]);
    expect(d.groups[0].inspections.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('groups by lot, leaving out checks of inspections without a lot (counted)', () => {
    const rows = [...checks('a', 4, 1, { lot: 'L1' }), ...checks('b', 4, 2, { lot: 'L1' }), ...checks('c', 6, 0, { lot: 'L2' }), ...checks('d', 3, 3, { lot: null })];
    const d = assembleP(rows, 'lot');
    expect(d.groups.map((g) => [g.lot, g.n, g.d])).toEqual([['L1', 8, 3], ['L2', 6, 0]]);
    expect(d.excluded).toEqual([expect.objectContaining({ reason: 'no_lot', count: 3 })]);
  });

  it('groups by production order (any case), leaving out checks of inspections without one (counted)', () => {
    const rows = [...checks('a', 4, 1, { order: 'WO-1' }), ...checks('b', 4, 2, { order: 'wo-1' }), ...checks('c', 6, 0, { order: 'WO-2' }), ...checks('d', 3, 3, { order: null }), ...checks('e', 2, 0)];
    const d = assembleP(rows, 'order');
    expect(d.groups.map((g) => [g.order?.toUpperCase(), g.n, g.d])).toEqual([['WO-1', 8, 3], ['WO-2', 6, 0]]);
    expect(d.excluded).toEqual([expect.objectContaining({ reason: 'no_order', count: 5 })]);
  });

  it('leaves out retests, abandoned inspections and readings not taken under a P chart, and ignores measured readings', () => {
    const rows = [
      ...checks('a', 10, 1),
      att(false, { isRetest: true }),
      att(false, { inspectionStatus: 'abandoned' }),
      att(true, { chartType: null }),
      row(25.01), // a measured reading of the same characteristic is not a pass/fail check
    ];
    const d = assembleP(rows, 'inspection');
    expect(d.groups.map((g) => [g.n, g.d])).toEqual([[10, 1]]);
    expect(Object.fromEntries(d.excluded.map((e) => [e.reason, e.count]))).toEqual({ retest: 1, abandoned: 1, chart_type: 1 });
  });

  it('the variable chart ignores pass/fail readings', () => {
    expect(assemble([att(false), row(25)]).points.map((p) => p.value)).toEqual([25]);
  });

  const groupsOf = (ds: [number, number][]) => assembleP(ds.flatMap(([n, d], i) => checks(`g${i}`, n, d)), 'inspection');

  it('needs five subgroups before showing limits, but still shows the proportions', () => {
    const r = evaluateP(groupsOf([[50, 2], [50, 3], [50, 1]]), null, ['we1']);
    expect(r.limitsSource).toBe('none');
    expect(r.warnings[0]).toMatch(/At least 5 subgroups/);
    expect(r.points.map((p) => p.p)).toEqual([0.04, 0.06, 0.02]);
  });

  it('trial limits from the subgroups shown: centre p̄, limits for each size, provisional, a high subgroup flagged', () => {
    const r = evaluateP(groupsOf([[100, 5], [100, 4], [100, 6], [100, 5], [100, 4], [100, 5], [100, 22]]), null, ['we1']);
    expect(r.limitsSource).toBe('trial');
    expect(r.provisional).toBe(true);
    expect(r.centre).toBeCloseTo(51 / 700, 10);
    expect(r.warnings.join(' ')).toMatch(/Trial limits/);
    expect(r.signals.map((s) => `${s.rule}@${s.index}`)).toEqual(['we1@6']);
    expect(r.points[0].lcl).toBe(0);
    expect(r.atMeanSize?.meanSize).toBe(100);
  });

  it('limits follow each subgroup size', () => {
    const r = evaluateP(groupsOf([[400, 20], [400, 20], [400, 20], [25, 1], [25, 1], [25, 1]]), 0.05, []);
    expect(r.points[0].ucl).toBeLessThan(r.points[3].ucl); // bigger subgroups, tighter limits
    expect(r.limitsSource).toBe('baseline');
  });

  it('uses a saved baseline’s p̄ rather than the data’s, and flags an unreliable approximation', () => {
    const r = evaluateP(groupsOf([[20, 1], [20, 0], [20, 1], [20, 1], [20, 0], [20, 6]]), 0.02, ['we1']);
    expect(r.centre).toBe(0.02);
    expect(r.limitsSource).toBe('baseline');
    expect(r.warnings.join(' ')).toMatch(/provisional/);
    expect(r.warnings.join(' ')).toMatch(/too few for the limits to be reliable/);
    expect(r.signals.map((s) => s.index)).toEqual([5]);
  });

  it('explains a zero-failure baseline and signals the first failure', () => {
    const r = evaluateP(groupsOf([[30, 0], [30, 0], [30, 0], [30, 0], [30, 0], [30, 1]]), null, ['we1']);
    expect(r.centre).toBeCloseTo(1 / 180, 10);
    const none = evaluateP(groupsOf([[30, 0], [30, 0], [30, 0], [30, 0], [30, 0], [30, 0]]), null, ['we1']);
    expect(none.centre).toBe(0);
    expect(none.noVariation).toBe(true);
    expect(none.warnings.join(' ')).toMatch(/No failures in the baseline/);
    expect(evaluateP(groupsOf([[30, 1]]), 0, ['we1']).signals.map((s) => s.index)).toEqual([0]);
  });

  it('says so when there is nothing to chart', () => {
    expect(evaluateP({ basis: 'day', groups: [], excluded: [] }, null, []).warnings).toEqual(['There are no pass/fail readings for these filters.']);
  });
});

describe('count charts (NP, C, U)', () => {
  const count = (defects: number, inspectionId: string, over: Partial<ReadingRow> = {}) =>
    row(0, { value: '', valueCount: defects, chartType: 'defects', subgroupSize: null, unitCode: null, nominal: null, lower: null, upper: null, inspectionId, inspectionReference: inspectionId, ...over });
  const pf = (pass: boolean, inspectionId: string) => row(0, { value: '', valuePass: pass, chartType: 'p', subgroupSize: null, unitCode: null, nominal: null, lower: null, upper: null, inspectionId });

  it('defects: one reading is one unit; a subgroup sums its defects', () => {
    const d = assembleDefects([count(2, 'a'), count(0, 'a'), count(3, 'b'), count(1, 'b'), count(1, 'b')], 'inspection');
    expect(d.groups.map((g) => [g.n, g.d])).toEqual([[2, 2], [3, 5]]);
  });

  it('leaves out and counts retests, abandoned inspections and other chart types', () => {
    const d = assembleDefects([count(1, 'a'), count(1, 'a', { isRetest: true }), count(1, 'b', { inspectionStatus: 'abandoned' }), count(1, 'c', { chartType: 'p' })], 'inspection');
    expect(d.groups).toHaveLength(1);
    expect(d.excluded.map((e) => [e.reason, e.count])).toEqual([['retest', 1], ['abandoned', 1], ['chart_type', 1]]);
  });

  it('chooses the most common size automatically, the larger on a tie', () => {
    expect(commonSize([{ n: 5 }, { n: 5 }, { n: 8 }])).toBe(5);
    expect(commonSize([{ n: 5 }, { n: 8 }])).toBe(8);
    expect(commonSize([])).toBeNull();
  });

  it('NP: keeps subgroups of the chosen size (auto or fixed) and counts the rest', () => {
    const rows = [
      ...[1, 2, 3, 4, 5].flatMap((k) => [pf(false, `i${k}`), pf(true, `i${k}`), pf(true, `i${k}`)]),
      pf(false, 'odd'),
    ];
    const base = assembleP(rows, 'inspection');
    const auto = applySubgroupSize(base, 'auto');
    expect(auto.size).toBe(3);
    expect(auto.data.groups).toHaveLength(5);
    expect(auto.data.excluded).toEqual([expect.objectContaining({ reason: 'size', count: 1 })]);
    expect(applySubgroupSize(base, 1).data.groups).toHaveLength(1);
  });

  it('evaluateCount: trial limits from five subgroups, saved rate when there is one', () => {
    const groups = [3, 5, 4, 6, 2].map((d, i) => ({ at: `2026-11-0${i + 1}T08:00:00.000Z`, n: 20, d, inspections: [], lot: null }));
    const trial = evaluateCount('c', groups, null, []);
    expect(trial).toMatchObject({ limitsSource: 'trial', size: 20, provisional: true });
    expect(trial.rate).toBeCloseTo(0.2);
    expect(trial.atMeanSize?.centre).toBeCloseTo(4);
    expect(evaluateCount('c', groups, 0.5, []).limitsSource).toBe('baseline');
    expect(evaluateCount('c', groups.slice(0, 3), null, []).points[0].ucl).toBeNaN();
  });

  it('a defects subgroup above its limit signals; the cleared baseline rate sets the centre', () => {
    const groups = [2, 3, 2, 3, 2, 14].map((d, i) => ({ at: `2026-11-0${i + 1}T08:00:00.000Z`, n: 10, d, inspections: [], lot: null }));
    const r = evaluateCount('c', groups, 0.25, ['we1']);
    expect(r.points[0].centre).toBeCloseTo(2.5);
    expect(r.signals.map((x) => x.index)).toEqual([5]);
  });

  it('warns when too few defects are expected per subgroup', () => {
    const groups = [0, 1, 0, 1, 0].map((d, i) => ({ at: `2026-11-0${i + 1}T08:00:00.000Z`, n: 10, d, inspections: [], lot: null }));
    expect(evaluateCount('u', groups, null, []).warnings.join(' ')).toMatch(/too few/);
  });
});
