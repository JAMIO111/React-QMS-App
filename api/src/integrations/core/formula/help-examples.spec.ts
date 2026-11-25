import { checkFormula, runFormula } from './index';

/**
 * The examples in the website guide "Formulas in imports" (site/src/content/docs/import-formulas.md), run through the real engine. When this fails,
 * either the language changed (update the guide) or the guide is wrong (fix it): the two must say the same.
 */
const run = (formula: string, record: Record<string, string> = {}) => {
  const r = runFormula(formula, (c) => (record[c] ?? '').trim());
  if ('error' in r) throw new Error(`${formula}: ${r.error}`);
  return r.value;
};
const fails = (formula: string, record: Record<string, string> = {}) => {
  const r = runFormula(formula, (c) => (record[c] ?? '').trim());
  return 'error' in r ? r.error : null;
};

describe('the help guide examples', () => {
  it('writing a formula: columns, text, numbers, brackets', () => {
    expect(run('[Size [mm]]]', { 'Size [mm]': '12' })).toBe('12');
    expect(run('[customer.code]', { 'customer.code': 'ACME' })).toBe('ACME');
    expect(run('"6"" pipe"')).toBe('6" pipe');
    expect(run('.5 + 1e3')).toBe('1000.5');
    expect(run('([A] + [B]) * 2', { A: '1', B: '2' })).toBe('6');
    expect(run('upper("a")')).toBe('A');
    expect(run('true')).toBe('true');
  });

  it('values: numbers from text, tests, dates, empty', () => {
    expect(run('[X] + 0', { X: '1,250.5' })).toBe('1250.5');
    expect(run('IF([Flag], "on", "off")', { Flag: 'yes' })).toBe('on');
    expect(run('IF([Flag], "on", "off")', { Flag: '' })).toBe('off');
    expect(fails('IF([Flag], "on", "off")', { Flag: 'maybe' })).toMatch(/needs true or false/);
    expect(fails('YEAR([D])', { D: '03/11/2026' })).toMatch(/read it with DATE first/);
    expect(run('YEAR([D])', { D: '2026-11-03' })).toBe('2026');
    expect(run('[Qty] * 2', { Qty: '' })).toBe('');
    expect(run('[A] & [B]', { A: 'x', B: '' })).toBe('x');
    expect(run('1 / 3')).toBe('0.333333333333333');
    expect(run('DATE("2026-11-03")')).toBe('2026-11-03');
  });

  it('operators and their order', () => {
    expect(run('2 + 3 * 4')).toBe('14');
    expect(run('[A] & [B] = "XY"', { A: 'X', B: 'Y' })).toBe('true');
    expect(run('-[Offset]', { Offset: '3' })).toBe('-3');
    expect(run('[Length] / 1000', { Length: '2500' })).toBe('2.5');
    expect(run('[First name] & " " & [Surname]', { 'First name': 'Ada', Surname: 'Lovelace' })).toBe('Ada Lovelace');
    expect(run('NOT ISEMPTY([Part])', { Part: 'P1' })).toBe('true');
    expect(run('[Status] = "Open" AND [Qty] > 0', { Status: 'open', Qty: '3' })).toBe('true');
    expect(run('[Site] = "LEEDS" OR [Site] = "HULL"', { Site: 'hull' })).toBe('true');
    expect(fails('1 / 0')).toBe('Cannot divide by 0');
  });

  it('comparisons', () => {
    expect(run('"leeds" = "LEEDS"')).toBe('true');
    expect(run('[Qty] > 5', { Qty: '12' })).toBe('true');
    expect(run('[A] > [B]', { A: '10', B: '9' })).toBe('false');
    expect(run('NUMBER([A]) > NUMBER([B])', { A: '10', B: '9' })).toBe('true');
    expect(run('[A] = [B]')).toBe('true');
    expect(run('[A] < "a"')).toBe('true');
  });

  it('text functions', () => {
    expect(run('CONCAT([Prefix], "-", [Number])', { Prefix: 'PN', Number: '0042' })).toBe('PN-0042');
    expect(run('LEFT("ABC-123", 3)')).toBe('ABC');
    expect(run('LEFT("ABC")')).toBe('A');
    expect(run('RIGHT("ABC-123", 3)')).toBe('123');
    expect(run('MID("ABC-123", 5, 2)')).toBe('12');
    expect(run('LEN("ABC-123")')).toBe('7');
    expect(run('UPPER("abc")')).toBe('ABC');
    expect(run('LOWER("ABC")')).toBe('abc');
    expect(run('PROPER("ada LOVELACE")')).toBe('Ada Lovelace');
    expect(run('TRIM("  A   B ")')).toBe('A B');
    expect(run('SUBSTITUTE("12-345", "-", "")')).toBe('12345');
    expect(run('FIND("-", "ABC-123")')).toBe('4');
    expect(run('FIND("x", "ABC-123")')).toBe('0');
    expect(run('SPLIT("PO-1/20", "/", -1)')).toBe('20');
    expect(run('SPLIT("a/b", "/", 5)')).toBe('');
  });

  it('logic functions', () => {
    expect(run('IF([Qty] > 100, "major", "minor")', { Qty: '150' })).toBe('major');
    expect(run('IF(FALSE, "x")')).toBe('');
    expect(run('IFS([Score] >= 90, "A", [Score] >= 75, "B", TRUE, "C")', { Score: '80' })).toBe('B');
    expect(run('IFS(FALSE, "A")')).toBe('');
    expect(run('SWITCH([Status], "A", "active", "I", "inactive", "active")', { Status: 'i' })).toBe('inactive');
    expect(run('SWITCH([Status], "A", "active", "I", "inactive", "active")', { Status: 'X' })).toBe('active');
    expect(run('IN([Site], "LEEDS", "HULL")', { Site: 'leeds' })).toBe('true');
    expect(run('IFEMPTY([Severity], "minor")')).toBe('minor');
    expect(run('COALESCE([Mobile], [Phone], [Office phone])', { Phone: '0113' })).toBe('0113');
    expect(run('ISEMPTY([Closed on])', { 'Closed on': '   ' })).toBe('true');
    expect(run('IF(ISEMPTY([Qty]), 0, 100 / [Qty])')).toBe('0');
  });

  it('number functions', () => {
    expect(run('NUMBER("1.234,50", ",")')).toBe('1234.5');
    expect(run('ROUND(2.345, 2)')).toBe('2.35');
    expect(run('ABS(-4)')).toBe('4');
    expect(run('MIN([Price 1], [Price 2])', { 'Price 1': '4', 'Price 2': '' })).toBe('4');
    expect(run('MAX([Qty], 1)', { Qty: '0' })).toBe('1');
    expect(run('CONVERT(0.5, "in", "mm")')).toBe('12.7');
  });

  it('date functions and formats', () => {
    expect(run('DATE("03.11.2026", "dd.MM.yyyy")')).toBe('2026-11-03');
    expect(run('ADDDAYS(DATE([Received]), 30)', { Received: '2026-11-03' })).toBe('2026-12-03');
    expect(run('YEAR(DATE("2026-11-03"))')).toBe('2026');
    expect(run('MONTH(DATE("2026-11-03"))')).toBe('11');
    expect(run('DAY(DATE("2026-11-03"))')).toBe('3');
    expect(run('DATE("2026-11-03T08:00:00")')).toBe('2026-11-03');
    expect(run('DATE("3/11/2026", "dmy")')).toBe('2026-11-03');
    expect(run('DATE("03.11.26", "dmy")')).toBe('2026-11-03');
    expect(run('DATE("3-11-2026", "dmy")')).toBe('2026-11-03');
    expect(run('DATE("11/3/2026", "mdy")')).toBe('2026-11-03');
    expect(run('DATE("46329", "excel")')).toBe('2026-11-03');
    expect(run('DATE("46329")')).toBe('2026-11-03');
    expect(run('DATE("20261103", "yyyyMMdd")')).toBe('2026-11-03');
    expect(run('DATE("3/11/26", "d/M/yy")')).toBe('2026-11-03');
    expect(fails('DATE("31.02.2026", "dd.MM.yyyy")')).toMatch(/is not a date/);
    expect(run('TODAY()')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the messages the guide quotes', () => {
    expect(checkFormula('UPPER([A] & "x').error?.message).toBe('Position 13: This text has no closing "');
    expect(checkFormula('UPPPER([A])').error?.message).toBe('Position 1: there is no function UPPPER — did you mean UPPER?');
    expect(checkFormula('IF(1, 2, 3, 4)').error?.message).toBe('Position 1: IF needs 2 or 3 values, got 4 (IF(test, then, else))');
    expect(checkFormula('[Stauts]', ['Status']).error?.message).toBe('Column [Stauts] is not in the file — did you mean [Status]?');
    expect(checkFormula('Leeds').error?.message).toBe('Position 1: "Leeds" is not something a formula knows: write a column as [Leeds], text as "Leeds", or a function as LEEDS(…)');
    expect(fails('NUMBER([Qty])', { Qty: 'n/a' })).toBe('"n/a" is not a number');
    expect(fails('[Qty] * 1', { Qty: 'n/a' })).toBe('* needs a number, got "n/a"');
  });

  it('the cookbook', () => {
    const row = {
      'First name': 'Ada', Surname: 'Lovelace', Prefix: 'PN', Number: '0042', Part: ' abc-123 ', Status: 'A', Severity: '', Qty: '150',
      Raised: '03.11.2026', Received: '3/11/2026', Diameter: '0.5', Price: '1.234,50', 'Order line': 'PO-1/20', Mobile: '', Phone: '0113', 'Movement type': 'corr',
    };
    expect(run('[First name] & " " & [Surname]', row)).toBe('Ada Lovelace');
    expect(run('CONCAT([Prefix], "-", [Number])', row)).toBe('PN-0042');
    expect(run('UPPER(TRIM([Part]))', row)).toBe('ABC-123');
    expect(run('SWITCH([Status], "A", "active", "I", "inactive", "active")', row)).toBe('active');
    expect(run('IFEMPTY([Severity], "minor")', row)).toBe('minor');
    expect(run('IF(NUMBER([Qty]) > 100, "major", "minor")', row)).toBe('major');
    expect(run('DATE([Raised], "dd.MM.yyyy")', row)).toBe('2026-11-03');
    expect(run('ADDDAYS(DATE([Received], "dmy"), 30)', row)).toBe('2026-12-03');
    expect(run('ROUND(CONVERT(NUMBER([Diameter]), "in", "mm"), 3)', row)).toBe('12.7');
    expect(run('NUMBER([Price], ",")', row)).toBe('1234.5');
    expect(run('SPLIT([Order line], "/", -1)', row)).toBe('20');
    expect(run('LEFT([Part], FIND("-", [Part]) - 1)', { Part: 'ABC-123' })).toBe('ABC');
    expect(run('LEFT([Part], FIND("-", [Part]) - 1)', { Part: 'ABC123' })).toBe('');
    expect(run('COALESCE([Mobile], [Phone])', row)).toBe('0113');
    expect(run('IN([Movement type], "CORR", "REV")', row)).toBe('true');

    const filters: Array<[string, Record<string, string>, string]> = [
      ['[Status] = "Active" AND NUMBER([Qty]) > 0', { Status: 'active', Qty: '2' }, 'true'],
      ['IN([Site], "LEEDS", "HULL")', { Site: 'York' }, 'false'],
      ['NOT ISEMPTY([Part number])', { 'Part number': 'P-1' }, 'true'],
      ['YEAR(DATE([Date], "dmy")) >= 2024', { Date: '1/2/2023' }, 'false'],
      ['NOT (LEFT([Part], 2) = "SA" OR [Type] = "Test")', { Part: 'SA-1', Type: '' }, 'false'],
    ];
    for (const [f, rec, want] of filters) expect(run(f, rec)).toBe(want);
  });
});
