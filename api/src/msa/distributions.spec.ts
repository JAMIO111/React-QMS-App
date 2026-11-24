import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fSurvival, logGamma, regularisedBeta, tTwoSidedP } from './distributions';

// scipy 1.18.1 values from reference/generate.py
const reference = JSON.parse(readFileSync(join(__dirname, 'reference', 'reference.json'), 'utf8'));

const relative = (actual: number, expected: number, tolerance: number) => {
  const scale = Math.max(Math.abs(expected), 1e-300);
  expect(Math.abs(actual - expected) / scale).toBeLessThan(tolerance);
};

describe('F and t probabilities', () => {
  it.each(reference.fSf as [number, number, number, number][])('F > %f with (%i, %i) degrees of freedom', (f, d1, d2, expected) => {
    relative(fSurvival(f, d1, d2), expected, 1e-9);
  });

  it.each(reference.tTwoSided as [number, number, number][])('two-sided p of t = %f with %i degrees of freedom', (t, df, expected) => {
    relative(tTwoSidedP(t, df), expected, 1e-9);
  });

  it('handles the edges', () => {
    expect(fSurvival(0, 3, 10)).toBe(1);
    expect(fSurvival(-1, 3, 10)).toBe(1);
    expect(fSurvival(Infinity, 3, 10)).toBe(0);
    expect(fSurvival(NaN, 3, 10)).toBeNaN();
    expect(tTwoSidedP(0, 5)).toBe(1);
    expect(tTwoSidedP(Infinity, 5)).toBe(0);
    expect(() => fSurvival(1, 0, 5)).toThrow(RangeError);
    expect(() => tTwoSidedP(1, 0)).toThrow(RangeError);
  });

  it('the incomplete beta function and ln Γ agree with closed forms', () => {
    expect(regularisedBeta(0.3, 1, 1)).toBeCloseTo(0.3, 12); // uniform
    expect(regularisedBeta(0.5, 2, 2)).toBeCloseTo(0.5, 12); // symmetric
    expect(regularisedBeta(0.25, 1, 3)).toBeCloseTo(1 - 0.75 ** 3, 12); // I_x(1,b) = 1 − (1−x)^b
    expect(regularisedBeta(0, 2, 3)).toBe(0);
    expect(regularisedBeta(1, 2, 3)).toBe(1);
    expect(logGamma(1)).toBeCloseTo(0, 12);
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 12);
    expect(logGamma(0.5)).toBeCloseTo(0.5 * Math.log(Math.PI), 12);
    expect(logGamma(10.5)).toBeCloseTo(Math.log(1133278.3889487855), 11);
  });
});
