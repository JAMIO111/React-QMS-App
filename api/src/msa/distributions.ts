/**
 * The two probability functions the studies need, written here so the product takes no new dependency:
 *   F distribution upper tail (is the part × appraiser interaction significant?) and Student's t two-sided p (is the bias zero?).
 * Both come from the regularised incomplete beta function I_x(a, b) (Numerical Recipes' continued fraction, modified Lentz).
 * distributions.spec.ts compares them with scipy to better than 1e-9 relative.
 */

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0 (Lanczos, g = 7, about 15 digits). */
export function logGamma(x: number): number {
  if (!(x > 0)) throw new RangeError('logGamma needs x > 0');
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i += 1) a += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function betaContinuedFraction(x: number, a: number, b: number): number {
  const TINY = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 1000; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) return h;
  }
  return h;
}

/** Regularised incomplete beta function I_x(a, b), 0 ≤ x ≤ 1. */
export function regularisedBeta(x: number, a: number, b: number): number {
  if (!(a > 0) || !(b > 0)) throw new RangeError('regularisedBeta needs a > 0 and b > 0');
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  return x < (a + 1) / (a + b + 2) ? (front * betaContinuedFraction(x, a, b)) / a : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/** P(F > f) for an F distribution with d1 and d2 degrees of freedom. An infinite f has probability 0. */
export function fSurvival(f: number, d1: number, d2: number): number {
  if (!(d1 > 0) || !(d2 > 0)) throw new RangeError('Degrees of freedom must be positive');
  if (Number.isNaN(f)) return NaN;
  if (f <= 0) return 1;
  if (!Number.isFinite(f)) return 0;
  return regularisedBeta(d2 / (d2 + d1 * f), d2 / 2, d1 / 2);
}

/** Two-sided p-value of a t statistic with `df` degrees of freedom: P(|T| > |t|). */
export function tTwoSidedP(t: number, df: number): number {
  if (!(df > 0)) throw new RangeError('Degrees of freedom must be positive');
  if (!Number.isFinite(t)) return 0;
  return regularisedBeta(df / (df + t * t), df / 2, 0.5);
}
