import { FileParseError } from '../integrations/core/file-parsers';
import { balloonFromFeature, detectReportDelimiter, normaliseBalloon, parseMeasurement, parseReport, readHeader } from './parse-report';
import { PROFILE_TEMPLATES, TableSettings } from './profile-settings';
import { normaliseUnit } from './units';

const bytes = (s: string) => new TextEncoder().encode(s);
const template = (key: string) => PROFILE_TEMPLATES.find((t) => t.key === key)!.settings;

// Shaped like a CALYPSO characteristics table (to be checked against a real export, plan CM0).
const CALYPSO = [
  ['planid', 'id', 'type', 'actual', 'nominal', 'uppertol', 'lowertol', 'deviation'].join('\t'),
  ['HSG-100', '1 Diameter bore', 'diameter', '25.0213', '25.0000', '0.0500', '-0.0500', '0.0213'].join('\t'),
  ['HSG-100', '2 Distance', 'distance', '40.1200', '40.0000', '0.1000', '-0.1000', '0.1200'].join('\t'),
  ['HSG-100', 'Flatness top', 'flatness', '0.0080', '0.0000', '0.0200', '', '0.0080'].join('\t'),
].join('\n');

// Shaped like a PC-DMIS CSV export: header lines, one line per axis, minus tolerance without its sign, values in inches.
const PCDMIS = [
  'Part Name,HSG-100',
  'Serial Number,SN-0042',
  'Revision Number,B',
  '',
  'Dimension,Axis,Nominal,+Tol,-Tol,Measured,Deviation,OutTol',
  'LOC1,X,1.0000,0.0020,0.0020,1.0011,0.0011,0',
  'LOC1,Y,2.0000,0.0020,0.0020,1.9969,-0.0031,0.0011',
  '#5 DIA,D,0.5000,0.0010,0.0010,0.5004,0.0004,0',
].join('\r\n');

describe('parseMeasurement', () => {
  it('reads plain, signed, exponent and comma-decimal numbers, and nothing else', () => {
    expect(parseMeasurement('25.0213')).toBe(25.0213);
    expect(parseMeasurement(' -0,05 ', ',')).toBe(-0.05);
    expect(parseMeasurement('1.5e-3')).toBe(0.0015);
    expect(parseMeasurement('+.5')).toBe(0.5);
    expect(parseMeasurement('1,234.5', ',')).toBeNull();
    expect(parseMeasurement('OK')).toBeNull();
    expect(parseMeasurement('12mm')).toBeNull();
    expect(parseMeasurement('')).toBeNull();
    expect(parseMeasurement('Infinity')).toBeNull();
  });
});

describe('balloon numbers', () => {
  it('takes the number at the start of a feature name, or after # or in brackets', () => {
    expect(balloonFromFeature('12_DIA')).toBe('12');
    expect(balloonFromFeature('B3 Position')).toBe('B3');
    expect(balloonFromFeature('#5 DIA')).toBe('5');
    expect(balloonFromFeature('Bore (7)')).toBe('7');
    expect(balloonFromFeature('CIR_OD')).toBeNull();
    expect(balloonFromFeature('DIA25')).toBeNull();
  });
  it('compares ignoring case and leading zeros', () => {
    expect(normaliseBalloon(' 012 ')).toBe('12');
    expect(normaliseBalloon('b03')).toBe('B3');
    expect(normaliseBalloon('10')).toBe('10');
    expect(normaliseBalloon('')).toBeNull();
  });
});

describe('units', () => {
  it('turns what files write into unit codes, and never reads inherited names', () => {
    expect(normaliseUnit('MM')).toBe('mm');
    expect(normaliseUnit('inch')).toBe('in');
    expect(normaliseUnit('°')).toBe('deg');
    expect(normaliseUnit('micron')).toBe('µm');
    expect(normaliseUnit('constructor')).toBe('constructor');
    expect(normaliseUnit('__proto__')).toBe('__proto__');
    expect(normaliseUnit('  ')).toBeNull();
  });
});

describe('detectReportDelimiter', () => {
  it('finds the separator the table uses even with header lines above it', () => {
    expect(detectReportDelimiter(PCDMIS)).toBe(',');
    expect(detectReportDelimiter(CALYPSO)).toBe('\t');
    expect(detectReportDelimiter('Part;X\nA;B;C\n1;2;3\n4;5;6')).toBe(';');
  });
});

describe('readHeader', () => {
  it('reads "Label: value" and label-then-value cells, ignoring case', () => {
    const lines = [['Part number: 123-A'], ['serial no', '', 'SN-9'], ['Operator =', 'J. Smith']];
    expect(readHeader(lines, { partNumber: 'Part number', serial: 'Serial no', operator: 'operator' })).toEqual({ partNumber: '123-A', serial: 'SN-9', operator: 'J. Smith' });
  });
});

describe('parseReport', () => {
  it('reads a CALYPSO-style table: balloon from the feature, limits from the tolerances, a one-sided feature', () => {
    const r = parseReport('report_chr.txt', bytes(CALYPSO), template('calypso_table'));
    expect(r.headingRow).toBe(1);
    expect(r.units).toHaveLength(1);
    const [bore, dist, flat] = r.units[0].features;
    expect(bore).toMatchObject({ featureName: '1 Diameter bore', balloon: '1', actual: 25.0213, nominal: 25, lower: 24.95, upper: 25.05, unit: 'mm' });
    expect(dist).toMatchObject({ balloon: '2', actual: 40.12, lower: 39.9, upper: 40.1 });
    expect(flat).toMatchObject({ balloon: null, lower: null, upper: 0.02 });
    expect(bore.raw).toMatchObject({ planid: 'HSG-100', deviation: '0.0213' });
  });

  it('reads a PC-DMIS-style CSV: header lines, axis lines, the minus tolerance taken away, inches', () => {
    const r = parseReport('report.csv', bytes(PCDMIS), { ...template('pcdmis_csv'), unit: 'in' });
    expect(r.header).toEqual({ partNumber: 'HSG-100', serial: 'SN-0042' });
    expect(r.headingRow).toBe(5);
    expect(r.units[0].reference).toBe('SN-0042');
    expect(r.units[0].features.map((f) => f.featureName)).toEqual(['LOC1 X', 'LOC1 Y', '#5 DIA D']);
    expect(r.units[0].features[1]).toMatchObject({ actual: 1.9969, lower: 1.998, upper: 2.002, unit: 'in', line: 7 });
    expect(r.units[0].features[2].balloon).toBe('5');
  });

  it('splits a file into parts by a column, in the order they appear', () => {
    const settings = TableSettings.parse({ columns: { feature: 'Feature', actual: 'Value', unitSplit: 'Serial' } });
    const csv = 'Serial,Feature,Value\nA1,1,10.01\nA1,2,5\nA2,1,10.02\nA2,2,5.1\n';
    const r = parseReport('pallet.csv', bytes(csv), settings);
    expect(r.units.map((u) => [u.reference, u.features.length])).toEqual([['A1', 2], ['A2', 2]]);
    expect(r.featureCount).toBe(4);
  });

  it('reads pass / fail words, from their own column or in place of a value', () => {
    const settings = TableSettings.parse({ columns: { feature: 'Feature', actual: 'Value', passFail: 'Result' } });
    const r = parseReport('a.csv', bytes('Feature,Value,Result\nVisual,,OK\nBurrs,NOK,\nBore,10.01,FAIL\n'), settings);
    expect(r.units[0].features.map((f) => [f.pass, f.actual])).toEqual([[true, null], [false, null], [false, 10.01]]);
  });

  it('reads comma decimals and a unit column', () => {
    const settings = TableSettings.parse({ delimiter: ';', decimal: ',', columns: { feature: 'Merkmal', actual: 'Ist', lowerLimit: 'UGW', upperLimit: 'OGW', unit: 'Einheit' } });
    const r = parseReport('de.csv', bytes('Merkmal;Ist;UGW;OGW;Einheit\n1 Bohrung;25,012;24,95;25,05;mm\n'), settings);
    expect(r.units[0].features[0]).toMatchObject({ actual: 25.012, lower: 24.95, upper: 25.05, unit: 'mm', balloon: '1' });
  });

  it('warns about optional columns that are missing, refuses missing required ones', () => {
    const settings = TableSettings.parse({ columns: { feature: 'Feature', actual: 'Value', nominal: 'Nominal' } });
    expect(parseReport('a.csv', bytes('Feature,Value\n1,2\n'), settings).warnings).toEqual(['The file has no column "Nominal"']);
    expect(() => parseReport('a.csv', bytes('Name,Value\n1,2\n'), settings)).toThrow(/Could not find a line with the columns "Feature" and "Value"/);
    const fixed = TableSettings.parse({ headingRow: 1, columns: { feature: 'Feature', actual: 'Value' } });
    expect(() => parseReport('a.csv', bytes('Name,Value\n1,2\n'), fixed)).toThrow(/no column "Feature"/);
  });

  it('refuses an empty table and old workbooks', () => {
    const settings = TableSettings.parse({ columns: { feature: 'Feature', actual: 'Value' } });
    expect(() => parseReport('a.csv', bytes('Feature,Value\n,\n'), settings)).toThrow(FileParseError);
    expect(() => parseReport('a.xls', bytes('x'), settings)).toThrow(/xls/);
  });

  it('reads hostile files safely: odd headings, huge cells, too many features', () => {
    const settings = TableSettings.parse({ columns: { feature: '__proto__', actual: 'constructor' } });
    const r = parseReport('h.csv', bytes(`__proto__,constructor,toString\nX,1,${'z'.repeat(5000)}\n`), settings);
    const f = r.units[0].features[0];
    expect(f.actual).toBe(1);
    expect(Object.getPrototypeOf(f.raw)).toBe(Object.prototype);
    expect(f.raw.toString).toHaveLength(100);
    expect(JSON.stringify(f.raw).length).toBeLessThan(4096);
    const many = 'F,V\n' + Array.from({ length: 5001 }, (_, i) => `${i},1`).join('\n');
    expect(() => parseReport('m.csv', bytes(many), TableSettings.parse({ columns: { feature: 'F', actual: 'V' } }))).toThrow(/more than 5,000 features/);
    const parts = 'S,F,V\n' + Array.from({ length: 201 }, (_, i) => `P${i},1,1`).join('\n');
    expect(() => parseReport('p.csv', bytes(parts), TableSettings.parse({ columns: { feature: 'F', actual: 'V', unitSplit: 'S' } }))).toThrow(/more than 200 parts/);
  });
});

describe('profile settings', () => {
  it('every template is valid, and a profile needs a value column and a nominal for tolerances', () => {
    for (const t of PROFILE_TEMPLATES) expect(TableSettings.safeParse(t.settings).success).toBe(true);
    expect(TableSettings.safeParse({ columns: { feature: 'F' } }).success).toBe(false);
    expect(TableSettings.safeParse({ columns: { feature: 'F', actual: 'A', upperTolerance: 'U' } }).success).toBe(false);
    expect(TableSettings.safeParse({ balloonFrom: 'column', columns: { feature: 'F', actual: 'A' } }).success).toBe(false);
    expect(TableSettings.safeParse({ columns: { feature: 'F', actual: 'A' }, script: 'x' }).success).toBe(false);
  });
});
