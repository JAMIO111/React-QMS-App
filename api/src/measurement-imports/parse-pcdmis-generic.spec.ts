import { isPcdmisGeneric, parsePcdmisGeneric } from './parse-pcdmis-generic';

const enc = (s: string) => new TextEncoder().encode(s);

/** The dimension lines of the example in Hexagon's help page, with a feature export in front of them. */
const SAMPLE = [
  'CIR1, 93.486348, 19.488589, -1.269350, 0.000000, 0.000000, 1.000000, 14.997670',
  '',
  'CIR1 HITS, 85.984616, 19.473057, -1.279984, 0.999998, 0.002070, 0.000000',
  'LOC1 AX:X, 93.485000, 0.010000, 0.010000, 93.486348, 0.001348, 0.000000',
  '',
  'LOC1 AX:Y, 19.500000, 0.010000, 0.010000, 19.488589, -0.011411, 0.001411',
  'LOC1 AX:D, 15.000000, 0.010000, 0.010000, 14.997670, -0.002330, 0.000000',
].join('\r\n');

describe('PC-DMIS generic export', () => {
  it('is recognised by its lines, and a headed table or QIF file is not', () => {
    expect(isPcdmisGeneric(enc(SAMPLE))).toBe(true);
    expect(isPcdmisGeneric(enc('Feature,Actual\nBore,25'))).toBe(false);
    expect(isPcdmisGeneric(enc('CIR1, 1, 2, 3, 0, 0, 1, 15'))).toBe(false); // features only: nothing to record
    expect(isPcdmisGeneric(enc('<QIFDocument/>'))).toBe(false);
    expect(isPcdmisGeneric(enc(''))).toBe(false);
  });

  it('reads each dimension with limits from the tolerances, and skips feature and hit lines', () => {
    const r = parsePcdmisGeneric(enc(SAMPLE));
    expect(r.units).toHaveLength(1);
    expect(r.units[0].reference).toBeNull();
    expect(r.units[0].features.map((f) => [f.featureName, f.nominal, f.lower, f.upper, f.actual, f.line])).toEqual([
      ['LOC1 X', 93.485, 93.475, 93.495, 93.486348, 4],
      ['LOC1 Y', 19.5, 19.49, 19.51, 19.488589, 6],
      ['LOC1 D', 15, 14.99, 15.01, 14.99767, 7],
    ]);
    expect(r.units[0].features.every((f) => f.balloon === null && f.unit === null)).toBe(true);
    expect(r.units[0].features[1].raw).toMatchObject({ Dimension: 'LOC1', Axis: 'Y', Deviation: '-0.011411', 'Out of tol': '0.001411' });
    expect(r.warnings.join(' ')).toMatch(/2 feature and hit lines/);
  });

  it('a negative minus tolerance puts the lower limit above nominal; a label on one axis may be a balloon number', () => {
    const r = parsePcdmisGeneric(enc('12 AX:D, 10.000, 0.050, -0.010, 10.030, 0.030, 0.000\nLOC2 AX:X, 5, 0.1, 0.1, 5.02, 0.02, 0'));
    expect(r.units[0].features[0]).toMatchObject({ featureName: '12 D', balloon: '12', lower: 10.01, upper: 10.05 });
    expect(r.units[0].features[1].balloon).toBeNull();
  });

  it('a dimension written again starts the next part', () => {
    const r = parsePcdmisGeneric(enc('A AX:D, 1, 0.1, 0.1, 1, 0, 0\nB AX:D, 2, 0.1, 0.1, 2, 0, 0\nA AX:D, 1, 0.1, 0.1, 1.05, 0.05, 0\nB AX:D, 2, 0.1, 0.1, 2, 0, 0'));
    expect(r.units.map((u) => [u.reference, u.features.length])).toEqual([['Part 1', 2], ['Part 2', 2]]);
    expect(r.warnings.join(' ')).toMatch(/read as 2 parts/);
  });

  it('refuses a file with a line it does not know', () => {
    expect(() => parsePcdmisGeneric(enc('LOC1 AX:X, 1, 0.1, 0.1, 1, 0, 0\nPart: HSG-1'))).toThrow(/not a PC-DMIS generic export/);
  });
});
