import { capability, histogram, indices, normalCdf, sampleSd, verdict } from './capability';

const close = (a: number | null, b: number, d = 3) => expect(a).toBeCloseTo(b, d);

describe('capability indices', () => {
  it('Cp = (USL−LSL)/6σ and Cpk = the nearer limit over 3σ', () => {
    const i = indices(25.01, 0.01, { lower: 24.95, upper: 25.05 });
    close(i.ratio, 0.1 / 0.06);
    close(i.upper, 0.04 / 0.03);
    close(i.lower, 0.06 / 0.03);
    close(i.k, 0.04 / 0.03);
  });
  it('one-sided specifications have only the one-sided index', () => {
    const i = indices(1.0, 0.1, { lower: null, upper: 1.6 });
    expect(i.ratio).toBeNull();
    expect(i.lower).toBeNull();
    close(i.k, 0.6 / 0.3);
  });
  it('has no indices without variation', () => expect(indices(1, 0, { lower: 0, upper: 2 }).k).toBeNull());
  it('uses n−1 for the overall standard deviation', () => close(sampleSd([2, 4, 4, 4, 5, 5, 7, 9]), 2.13809, 4));
  it('the normal distribution function is accurate', () => {
    close(normalCdf(0), 0.5, 6);
    close(normalCdf(1.96), 0.975, 4);
    close(normalCdf(-3), 0.00135, 5);
  });
  it('bands verdicts at 1.00, 1.33 and 1.67', () => {
    expect([2, 1.5, 1.1, 0.9, null].map(verdict)).toEqual(['excellent', 'capable', 'marginal', 'not_capable', null]);
  });
});

describe('capability of a set of readings', () => {
  const spec = { lower: 24.95, upper: 25.05 };
  const centred = Array.from({ length: 40 }, (_, i) => 25 + ((i % 5) - 2) * 0.005);
  it('compares within and overall σ, and counts readings out of specification', () => {
    const c = capability(centred, 0.004, spec, 0)!;
    expect(c.n).toBe(40);
    close(c.mean, 25, 6);
    close(c.within.ratio, 0.1 / (6 * 0.004));
    expect(c.overall.ratio).toBeLessThan(c.within.ratio!); // overall σ is larger here
    expect(c.observedPpm).toBe(0);
    expect(c.warnings).toEqual([]);
    expect(c.verdict).toBe('excellent');
    const off = capability([...centred, 25.06], 0.004, spec, 0)!;
    close(off.observedPpm, 1e6 / 41, 0);
  });
  it('warns about few readings and about an unstable process', () => {
    const c = capability(centred.slice(0, 12), 0.004, spec, 2)!;
    expect(c.warnings).toHaveLength(2);
    expect(c.warnings.join(' ')).toMatch(/Only 12 readings/);
    expect(c.warnings.join(' ')).toMatch(/not stable/);
  });
  it('gives nothing without a specification, too few readings or no σ', () => {
    expect(capability(centred, 0.004, { lower: null, upper: null }, 0)).toBeNull();
    expect(capability(centred.slice(0, 9), 0.004, spec, 0)).toBeNull();
    expect(capability(centred, null, spec, 0)).toBeNull();
  });
  it('says so when every reading is identical', () => {
    expect(capability(Array(12).fill(25), 0.004, spec, 0)!.warnings[0]).toMatch(/no variation/);
  });
});

describe('histogram', () => {
  const spec = { lower: 24.95, upper: 25.05 };
  const xs = Array.from({ length: 40 }, (_, i) => 25 + ((i % 5) - 2) * 0.005);
  it('counts every reading once, over a range that holds the specification', () => {
    const h = histogram(xs, spec, 25, 0.004);
    expect(h.bins.reduce((t, b) => t + b.count, 0)).toBe(40);
    expect(h.bins[0].from).toBeLessThanOrEqual(24.95);
    expect(h.bins[h.bins.length - 1].to).toBeGreaterThanOrEqual(25.05);
    expect(h.bins.length).toBeGreaterThanOrEqual(8);
    expect(h.bins.length).toBeLessThanOrEqual(20);
  });
  it('scales the normal curve to the same counts (area ≈ readings × bin width / bin width)', () => {
    const h = histogram(xs, spec, 25, 0.004);
    const step = h.curve[1].x - h.curve[0].x;
    const area = h.curve.reduce((t, p) => t + p.y * step, 0) / h.binWidth;
    expect(area).toBeGreaterThan(38);
    expect(area).toBeLessThan(42);
  });
  it('is part of the capability result', () => {
    expect(capability(xs, 0.004, spec, 0)!.histogram!.bins.length).toBeGreaterThan(0);
  });
});
