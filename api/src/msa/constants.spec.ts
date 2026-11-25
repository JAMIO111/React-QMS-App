import { controlA2, controlD3, controlD4, d2, d2Star1, d3, MAX_RANGE_GROUP } from './constants';

const close = (a: number, b: number, digits: number) => expect(a).toBeCloseTo(b, digits);

describe('range constants (worked out by integration, checked against the printed tables)', () => {
  it('d2 and d3 match the standard SPC tables to the printed three decimals', () => {
    const d2Table: Record<number, number> = { 2: 1.128, 3: 1.693, 4: 2.059, 5: 2.326, 6: 2.534, 7: 2.704, 8: 2.847, 9: 2.97, 10: 3.078 };
    const d3Table: Record<number, number> = { 2: 0.853, 3: 0.888, 4: 0.88, 5: 0.864, 6: 0.848, 7: 0.833, 8: 0.82, 9: 0.808, 10: 0.797 };
    for (const m of Object.keys(d2Table).map(Number)) {
      close(d2(m), d2Table[m], 3);
      close(d3(m), d3Table[m], 3);
    }
  });

  it('D4 and A2 match the printed control chart constants', () => {
    const d4: Record<number, number> = { 2: 3.267, 3: 2.574, 4: 2.282, 5: 2.114, 6: 2.004, 7: 1.924, 8: 1.864, 9: 1.816, 10: 1.777 };
    for (const m of Object.keys(d4).map(Number)) close(controlD4(m), d4[m], 2);
    const a2: Record<number, number> = { 2: 1.88, 3: 1.023, 4: 0.729, 5: 0.577 };
    for (const m of Object.keys(a2).map(Number)) close(controlA2(m), a2[m], 3);
    expect(controlD3(5)).toBe(0);
    expect(controlD3(7)).toBeGreaterThan(0);
  });

  it('1/d2 and 1/d2* match the AIAG MSA K1, K2 and K3 constants', () => {
    close(1 / d2(2), 0.8862, 4); // K1, two trials
    close(1 / d2(3), 0.5908, 4); // K1, three trials
    close(1 / d2Star1(2), 0.7071, 4); // K2 two appraisers, K3 two parts
    close(1 / d2Star1(3), 0.5231, 4); // K2 three appraisers, K3 three parts
    const k3: Record<number, number> = { 4: 0.4467, 5: 0.403, 6: 0.3742, 7: 0.3534, 8: 0.3375, 9: 0.3249, 10: 0.3146 };
    for (const m of Object.keys(k3).map(Number)) close(1 / d2Star1(m), k3[m], 4);
  });

  it('has constants for every group the studies can use, and refuses others', () => {
    for (let m = 2; m <= MAX_RANGE_GROUP; m += 1) expect(d2(m)).toBeGreaterThan(0);
    expect(() => d2(1)).toThrow(RangeError);
    expect(() => d2(26)).toThrow(RangeError);
  });
});
