import { AnalysisReading, compareGroups, groupStats } from './analysis';

const meas = (value: number, lower: number | null = 24.95, upper: number | null = 25.05, nominal: number | null = 25): AnalysisReading => ({ kind: 'variable', value, pass: null, count: null, lower, upper, nominal });
const pf = (pass: boolean): AnalysisReading => ({ kind: 'attribute', value: null, pass, count: null, lower: null, upper: null, nominal: null });
const cnt = (count: number): AnalysisReading => ({ kind: 'count', value: null, pass: null, count, lower: null, upper: null, nominal: null });
const close = (a: number | null, b: number, d = 3) => expect(a).toBeCloseTo(b, d);

describe('group statistics', () => {
  const xs = Array.from({ length: 20 }, (_, i) => 25 + ((i % 5) - 2) * 0.005);
  it('measured: mean, spread, position in the tolerance and Pp/Ppk', () => {
    const s = groupStats(xs.map((x) => meas(x)), 'variable');
    close(s.mean, 25, 6);
    expect(s.spec).toEqual({ nominal: 25, lower: 24.95, upper: 25.05 });
    expect(s.outOfSpec).toBe(0);
    close(s.offsetPct, 0, 6);
    close(s.spreadPct, ((3 * s.sd!) / 0.05) * 100, 6);
    close(s.pp, 0.1 / (6 * s.sd!), 6);
    close(s.ppk, s.pp!, 6); // centred
  });
  it('an off-centre group has a lower Ppk than Pp', () => {
    const s = groupStats(xs.map((x) => meas(x + 0.02)), 'variable');
    close(s.offsetPct, 40, 4);
    expect(s.ppk!).toBeLessThan(s.pp!);
  });
  it('parts with different specs are compared on the tolerance scale', () => {
    const a = xs.map((x) => meas(x));
    const b = xs.map((x) => meas(10 + (x - 25) * 2, 9.9, 10.1, 10)); // same shape on a twice-wider tolerance
    const s = groupStats([...a, ...b], 'variable');
    expect(s.spec).toBeNull();
    close(s.offsetPct, 0, 6);
    close(s.pp, groupStats(a, 'variable').pp!, 1);
  });
  it('needs ten readings for capability, and both limits for position and spread', () => {
    expect(groupStats(xs.slice(0, 9).map((x) => meas(x)), 'variable').ppk).toBeNull();
    const oneSided = groupStats(xs.map((x) => meas(x + 1, null, 26.6, null)), 'variable');
    expect(oneSided.offsetPct).toBeNull();
    expect(oneSided.ppk).not.toBeNull();
  });
  it('pass/fail: failures and rate; count: defects per unit', () => {
    expect(groupStats([pf(true), pf(false), pf(true), pf(true)], 'attribute')).toMatchObject({ n: 4, failed: 1, rate: 0.25 });
    expect(groupStats([cnt(0), cnt(3), cnt(1)], 'count')).toMatchObject({ n: 3, defects: 4 });
    close(groupStats([cnt(0), cnt(3), cnt(1)], 'count').perUnit, 4 / 3, 6);
  });
});

describe('comparing groups', () => {
  const group = (rows: AnalysisReading[], kind: 'attribute' | 'count' | 'variable') => ({ rows, stats: groupStats(rows, kind) });
  it('calls a machine with far more failures higher, the others similar', () => {
    const gs = [
      group([...Array(40).fill(0).map(() => pf(true)), ...Array(20).fill(0).map(() => pf(false))], 'attribute'),
      group([...Array(57).fill(0).map(() => pf(true)), ...Array(3).fill(0).map(() => pf(false))], 'attribute'),
      group([...Array(58).fill(0).map(() => pf(true)), ...Array(2).fill(0).map(() => pf(false))], 'attribute'),
    ];
    compareGroups(gs, 'attribute');
    expect(gs.map((g) => g.stats.verdict)).toEqual(['higher', 'similar', 'similar']);
  });
  it('count groups use defects per unit', () => {
    const gs = [group(Array(30).fill(0).map(() => cnt(3)), 'count'), group(Array(30).fill(0).map(() => cnt(1)), 'count')];
    compareGroups(gs, 'count');
    expect(gs.map((g) => g.stats.verdict)).toEqual(['higher', 'lower']);
  });
  it('measured groups are compared on the mean, on the tolerance scale', () => {
    const base = Array.from({ length: 30 }, (_, i) => 25 + ((i % 5) - 2) * 0.004);
    const gs = [group(base.map((x) => meas(x)), 'variable'), group(base.map((x) => meas(x + 0.03)), 'variable'), group(base.map((x) => meas(x)), 'variable')];
    compareGroups(gs, 'variable');
    expect(gs.map((g) => g.stats.verdict)).toEqual(['lower', 'higher', 'lower']);
  });
  it('says nothing for one group', () => {
    const gs = [group([pf(true), pf(false)], 'attribute')];
    compareGroups(gs, 'attribute');
    expect(gs[0].stats.verdict).toBeNull();
  });
});
