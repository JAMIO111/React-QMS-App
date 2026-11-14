import { matchReport, MatchRequirement, valueFor } from './match';
import { ParsedFeature, ParsedReport } from './parse-report';

const feature = (position: number, featureName: string, balloon: string | null, actual: number | null, extra: Partial<ParsedFeature> = {}): ParsedFeature => ({
  position, line: position + 1, featureName, balloon, raw: {}, actualText: actual === null ? null : String(actual), actual, pass: null,
  unit: 'mm', nominal: null, lower: null, upper: null, ...extra,
});
const report = (...units: ParsedFeature[][]): ParsedReport => ({
  header: {}, headings: [], headingRow: 1, featureCount: units.flat().length, warnings: [],
  units: units.map((features, i) => ({ position: i + 1, reference: `SN-${i + 1}`, features })),
});
const REQS: MatchRequirement[] = [
  { id: 'r-od', characteristicKey: 'OD', charNumber: '1', name: 'Outer diameter', dataType: 'variable', applicable: true },
  { id: 'r-len', characteristicKey: 'LEN', charNumber: '02', name: 'Length', dataType: 'variable', applicable: true },
  { id: 'r-vis', characteristicKey: 'VIS', charNumber: null, name: 'Visual', dataType: 'attribute', applicable: true },
  { id: 'r-burr', characteristicKey: 'BURR', charNumber: '9', name: 'Burrs', dataType: 'count', applicable: true },
];

describe('matchReport', () => {
  it('matches by balloon (ignoring leading zeros), and leaves features with no balloon or no check unmatched', () => {
    const { units, warnings } = matchReport(report([feature(1, '1 Bore', '1', 25.01), feature(2, '2 Length', '2', 40), feature(3, 'Datum A', null, 0), feature(4, '7 Hole', '7', 3)]), REQS, [], null);
    expect(units[0].rows.map((r) => [r.featureName, r.requirementId, r.matchKind])).toEqual([
      ['1 Bore', 'r-od', 'balloon'], ['2 Length', 'r-len', 'balloon'], ['Datum A', null, 'none'], ['7 Hole', null, 'none'],
    ]);
    expect(units[0].unitReference).toBe('SN-1');
    expect(warnings).toEqual([]);
  });

  it('a saved feature map wins over the balloon, and a profile’s own map over a general one', () => {
    const maps = [
      { featureName: 'visual check', characteristicKey: 'VIS', profileId: null },
      { featureName: '1 bore', characteristicKey: 'LEN', profileId: null },
      { featureName: '1 bore', characteristicKey: 'OD', profileId: 'p1' },
    ];
    const f = [feature(1, '1 Bore', '1', 25.01), feature(2, 'Visual check', null, null, { pass: true, actualText: 'OK' })];
    expect(matchReport(report(f), REQS, maps, null).units[0].rows.map((r) => [r.requirementId, r.matchKind])).toEqual([['r-len', 'map'], ['r-vis', 'map']]);
    expect(matchReport(report(f), REQS, maps, 'p1').units[0].rows[0].requirementId).toBe('r-od');
  });

  it('a map to a check this inspection does not have falls back to the balloon', () => {
    const { units } = matchReport(report([feature(1, '1 Bore', '1', 25)]), REQS, [{ featureName: '1 Bore', characteristicKey: 'GONE', profileId: null }], null);
    expect(units[0].rows[0]).toMatchObject({ requirementId: 'r-od', matchKind: 'balloon' });
  });

  it('one feature per check per part: the second is left unmatched with a warning, other parts are matched again', () => {
    const { units, warnings } = matchReport(report([feature(1, '1 Bore', '1', 25), feature(2, '1 Bore again', '1', 25.1)], [feature(3, '1 Bore', '1', 25.02)]), REQS, [], null);
    expect(units[0].rows.map((r) => r.requirementId)).toEqual(['r-od', null]);
    expect(units[1].rows[0].requirementId).toBe('r-od');
    expect(warnings).toEqual(['SN-1: "1 Bore" and "1 Bore again" both look like Outer diameter; "1 Bore again" was left unmatched']);
  });

  it('two checks with the same balloon are not matched by balloon', () => {
    const reqs = [...REQS, { id: 'r-x', characteristicKey: 'X', charNumber: '1', name: 'Other', dataType: 'variable' as const, applicable: true }];
    const { units, warnings } = matchReport(report([feature(1, '1 Bore', '1', 25)]), reqs, [], null);
    expect(units[0].rows[0].requirementId).toBeNull();
    expect(warnings).toEqual(['Two checks of the control plan share balloon 1; features with that balloon need matching by hand']);
  });

  it('keeps the file’s own limits and unit, unconverted (the database converts)', () => {
    const { units } = matchReport(report([feature(1, '1 Bore', '1', 0.985, { unit: 'in', nominal: 0.984, lower: 0.982, upper: 0.986 })]), REQS, [], null);
    expect(units[0].rows[0]).toMatchObject({ valueNumeric: 0.985, unitRead: 'in', fileNominal: 0.984, fileLower: 0.982, fileUpper: 0.986 });
  });
});

describe('valueFor', () => {
  it('gives each kind of check the value it takes', () => {
    const f = feature(1, 'x', null, 3, { pass: false });
    expect(valueFor(f, 'variable')).toEqual({ valueNumeric: 3 });
    expect(valueFor(f, 'attribute')).toEqual({ valuePass: false });
    expect(valueFor(f, 'count')).toEqual({ valueCount: 3 });
    expect(valueFor(feature(1, 'x', null, 2.5), 'count')).toEqual({});
    expect(valueFor(feature(1, 'x', null, null, { pass: true }), null)).toEqual({ valuePass: true });
  });
});
