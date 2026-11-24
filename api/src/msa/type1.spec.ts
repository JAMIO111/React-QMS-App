import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyseType1 } from './type1';
import { MsaInputError } from './errors';

const reference = JSON.parse(readFileSync(join(__dirname, 'reference', 'reference.json'), 'utf8'));
const rel = (actual: number | null, expected: number, tolerance = 1e-9) => {
  expect(actual).not.toBeNull();
  expect(Math.abs((actual as number) - expected) / Math.max(Math.abs(expected), 1e-12)).toBeLessThan(tolerance);
};

type Case = { values: number[]; reference: number; lower: number; upper: number; k: number; l: number; mean: number; sd: number; bias: number; t: number; p: number; cg: number; cgk: number };

describe('Type 1 study against scipy and an independent calculation (reference/generate.py)', () => {
  it.each(reference.type1Cases as Case[])('n = $values.length, reference $reference', (c) => {
    const r = analyseType1({ values: c.values, reference: c.reference, lower: c.lower, upper: c.upper, k: c.k, l: c.l });
    rel(r.mean, c.mean);
    rel(r.sd, c.sd);
    expect(r.bias).toBeCloseTo(c.bias, 12);
    rel(r.biasT, c.t, 1e-8);
    rel(r.biasP, c.p, 1e-8);
    rel(r.cg, c.cg);
    rel(r.cgk, c.cgk);
    rel(r.pctRepeatability, c.k / c.cg);
    rel(r.pctRepeatabilityAndBias, c.k / c.cgk);
  });
});

describe('Type 1 definitions', () => {
  // 25 readings on a 25.000 reference, tolerance 0.200 (24.9 … 25.1): sd 0.002, mean on the reference
  const readings = (offset: number, spread: number) => Array.from({ length: 25 }, (_, i) => 25 + offset + (i % 2 === 0 ? spread : -spread) * (1 + (i % 5) * 0.1));

  it('Cg = 0.2·T/(6s) and Cgk = (0.1·T − |bias|)/(3s) with the defaults', () => {
    const r = analyseType1({ values: readings(0.001, 0.002), reference: 25, lower: 24.9, upper: 25.1 });
    expect(r.cg).toBeCloseTo((0.2 * 0.2) / (6 * r.sd), 10);
    expect(r.cgk).toBeCloseTo((0.1 * 0.2 - Math.abs(r.bias)) / (3 * r.sd), 10);
    expect(r.tolerance).toBeCloseTo(0.2, 12);
    expect(r.k).toBe(20);
    expect(r.l).toBe(6);
  });

  it('is acceptable at 1.33 and above for both indices, unacceptable below, and never marginal', () => {
    const good = analyseType1({ values: readings(0, 0.0005), reference: 25, lower: 24.9, upper: 25.1 });
    expect(good.verdict.band).toBe('acceptable');
    const biased = analyseType1({ values: readings(0.04, 0.0005), reference: 25, lower: 24.9, upper: 25.1 });
    expect(biased.cg).toBeGreaterThan(1.33); // repeatable...
    expect(biased.cgk).toBeLessThan(1.33); // ...but biased
    expect(biased.verdict.band).toBe('unacceptable');
    expect(biased.warnings.map((w) => w.code)).toContain('bias_significant');
  });

  it('honours K and L', () => {
    const v = readings(0, 0.003);
    const four = analyseType1({ values: v, reference: 25, lower: 24.9, upper: 25.1, l: 4 });
    const six = analyseType1({ values: v, reference: 25, lower: 24.9, upper: 25.1, l: 6 });
    expect((four.cg as number) / (six.cg as number)).toBeCloseTo(6 / 4, 10);
    const tenth = analyseType1({ values: v, reference: 25, lower: 24.9, upper: 25.1, k: 10 });
    expect((tenth.cg as number) / (six.cg as number)).toBeCloseTo(0.5, 10);
  });

  it('gives the statistics but no verdict without both limits', () => {
    const r = analyseType1({ values: readings(0, 0.002), reference: 25, lower: 24.9, upper: null });
    expect(r.cg).toBeNull();
    expect(r.cgk).toBeNull();
    expect(r.verdict.band).toBeNull();
    expect(r.sd).toBeGreaterThan(0);
    expect(r.warnings.map((w) => w.code)).toContain('no_tolerance');
  });

  it('warns about few readings and a coarse resolution', () => {
    const r = analyseType1({ values: readings(0, 0.002).slice(0, 12), reference: 25, lower: 24.9, upper: 25.1, resolution: 0.02 });
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['few_readings', 'resolution_tolerance']));
    expect(r.resolutionPct).toBeCloseTo(10, 10);
    const fine = analyseType1({ values: readings(0, 0.002), reference: 25, lower: 24.9, upper: 25.1, resolution: 0.005 });
    expect(fine.warnings.map((w) => w.code)).not.toContain('resolution_tolerance');
  });

  it('identical readings have no repeatability to estimate', () => {
    const r = analyseType1({ values: Array(30).fill(25.001), reference: 25, lower: 24.9, upper: 25.1 });
    expect(r.sd).toBe(0);
    expect(r.cg).toBeNull();
    expect(r.biasT).toBeNull();
    expect(r.verdict.band).toBeNull();
    expect(r.warnings.map((w) => w.code)).toContain('no_variation');
  });

  it('refuses data that cannot be analysed', () => {
    expect(() => analyseType1({ values: [1], reference: 1, lower: 0, upper: 2 })).toThrow(MsaInputError);
    expect(() => analyseType1({ values: [1, NaN, 2], reference: 1, lower: 0, upper: 2 })).toThrow('Every reading must be a number');
    expect(() => analyseType1({ values: [1, 2], reference: NaN, lower: 0, upper: 2 })).toThrow('reference value');
    expect(() => analyseType1({ values: [1, 2], reference: 1, lower: 2, upper: 1 })).toThrow('above the lower limit');
    expect(() => analyseType1({ values: [1, 2], reference: 1, lower: 0, upper: 2, k: 0 })).toThrow('K must be');
    expect(() => analyseType1({ values: [1, 2], reference: 1, lower: 0, upper: 2, l: 0 })).toThrow('L must be');
  });
});
