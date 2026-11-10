import { EntityCatalogue } from '../catalogue';
import { applyMapping, cell, fieldColumns, mappingProblems, rawValue } from '../mapping';
import { checkFormula, closest, FUNCTION_LIST, parseFormula, runFormula } from './index';
import { MAX_DEPTH } from './parser';

const row: Record<string, string> = { Code: ' ab-12 ', Name: 'big LATHE', Qty: '12', Price: '2.5', Empty: '', 'Due date': '31.01.2026', Status: 'Scrapped', 'Odd]name': 'odd', Len: '1' };
const get = (c: string) => cell(row, c);
const run = (f: string) => {
  const r = runFormula(f, get);
  if ('error' in r) throw new Error(r.error);
  return r.value;
};
const fails = (f: string) => {
  const r = runFormula(f, get);
  return 'error' in r ? r.error : `no error, got ${r.value}`;
};

describe('formula language', () => {
  it('reads literals, columns and operators with the right precedence', () => {
    expect(run('1 + 2 * 3')).toBe('7');
    expect(run('(1 + 2) * 3')).toBe('9');
    expect(run('-[Qty] + 2')).toBe('-10');
    expect(run('[Qty] * [Price]')).toBe('30');
    expect(run('10 / 4')).toBe('2.5');
    expect(run('0.1 + 0.2')).toBe('0.3');
    expect(run('"a" & 1 & TRUE')).toBe('a1true');
    expect(run('"say ""hi"""')).toBe('say "hi"');
    expect(run('[Odd]]name]')).toBe('odd');
    expect(run('[Due date]')).toBe('31.01.2026');
    expect(run('[Qty] > 5 AND NOT [Qty] > 20')).toBe('true');
    expect(run('1 = 2 OR "x" = "X"')).toBe('true');
    expect(run('"10" > 9')).toBe('true');
    expect(run('"abc" < "abd"')).toBe('true');
    expect(run('[Empty] = ""')).toBe('true');
    expect(run('[Empty] + 1')).toBe('');
    expect(run('[Missing column]')).toBe('');
  });

  it('text functions', () => {
    expect(run('CONCAT("M-", UPPER(TRIM([Code])))')).toBe('M-AB-12');
    expect(run('LEFT([Name], 3)')).toBe('big');
    expect(run('LEFT([Name])')).toBe('b');
    expect(run('RIGHT([Name], 5)')).toBe('LATHE');
    expect(run('MID("abcdef", 2, 3)')).toBe('bcd');
    expect(run('LEN([Name])')).toBe('9');
    expect(run('LOWER([Name])')).toBe('big lathe');
    expect(run('PROPER([Name])')).toBe('Big Lathe');
    expect(run('TRIM("  a   b ")')).toBe('a b');
    expect(run('SUBSTITUTE([Code], "-", "")')).toBe('ab12');
    expect(run('FIND("lathe", [Name])')).toBe('5');
    expect(run('FIND("x", [Name])')).toBe('0');
    expect(run('SPLIT("a|b|c", "|", 2)')).toBe('b');
    expect(run('SPLIT("a|b|c", "|", -1)')).toBe('c');
  });

  it('logic functions, evaluated lazily', () => {
    expect(run('IF([Status] = "scrapped", "inactive", "active")')).toBe('inactive');
    expect(run('IF(FALSE, 1)')).toBe('');
    expect(run('IF(TRUE, "ok", 1 / 0)')).toBe('ok');
    expect(run('IFS([Qty] > 100, "big", [Qty] > 10, "medium", TRUE, "small")')).toBe('medium');
    expect(run('IFEMPTY([Empty], "n/a")')).toBe('n/a');
    expect(run('COALESCE([Empty], [Missing], [Name])')).toBe('big LATHE');
    expect(run('ISEMPTY([Empty])')).toBe('true');
    expect(run('IN([Status], "lost", "SCRAPPED")')).toBe('true');
    expect(run('SWITCH([Status], "In use", "A", "Scrapped", "S", "?")')).toBe('S');
    expect(run('SWITCH("x", "a", 1, "other")')).toBe('other');
    expect(run('SWITCH("x", "a", 1)')).toBe('');
  });

  it('number functions', () => {
    expect(run('NUMBER("1.234,5", ",")')).toBe('1234.5');
    expect(run('NUMBER("1,234.5")')).toBe('1234.5');
    expect(run('ROUND(2.345, 2)')).toBe('2.35');
    expect(run('ROUND(2.5)')).toBe('3');
    expect(run('ABS(-3)')).toBe('3');
    expect(run('MIN(3, [Empty], 1, 2)')).toBe('1');
    expect(run('MAX(3, 7, 2)')).toBe('7');
    expect(run('CONVERT(1, "in", "mm")')).toBe('25.4');
    expect(run('CONVERT(100, "C", "F")')).toBe('212');
  });

  it('date functions', () => {
    expect(run('DATE([Due date], "dd.MM.yyyy")')).toBe('2026-01-31');
    expect(run('DATE("31/01/2026", "dmy")')).toBe('2026-01-31');
    expect(run('ADDDAYS(DATE([Due date], "dd.MM.yyyy"), 30)')).toBe('2026-03-02');
    expect(run('YEAR("2026-01-31") & "/" & MONTH("2026-01-31") & "/" & DAY("2026-01-31")')).toBe('2026/1/31');
    expect(run('TODAY()')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(run('DATE([Empty])')).toBe('');
  });

  it('a formula that fails on a row says why', () => {
    expect(fails('SPLIT("a", "", 1)')).toBe('SPLIT needs a separator');
    expect(fails('[Name] * 2')).toBe('* needs a number, got "big LATHE"');
    expect(fails('1 / 0')).toBe('Cannot divide by 0');
    expect(fails('DATE("31.02.2026", "dd.MM.yyyy")')).toBe('"31.02.2026" is not a date written as dd.MM.yyyy');
    expect(fails('ADDDAYS("31/01/2026", 1)')).toMatch(/needs a date, got "31\/01\/2026"/);
    expect(fails('IF([Name], 1, 2)')).toBe('IF needs true or false, got "big LATHE"');
    expect(fails('CONVERT(1, "kg", "mm")')).toBe('Cannot convert kg to mm');
    expect(fails('MID("abc", 0, 1)')).toBe('MID starts at 1 or later');
    expect(fails('NUMBER("x")')).toBe('"x" is not a number');
  });

  it('syntax errors give the position and what was expected', () => {
    const msg = (f: string) => checkFormula(f).error?.message;
    expect(msg('1 +')).toBe('Position 4: The formula ends too soon: a value is missing');
    expect(msg('IF(1, 2')).toBe('Position 8: Expected "," or ")" to close IF( but found the end of the formula');
    expect(msg('"open')).toBe('Position 1: This text has no closing "');
    expect(msg('[Status')).toBe('Position 1: This column name has no closing ]');
    expect(msg('[]')).toBe('Position 1: Write the column name between [ and ]');
    expect(msg('Status')).toMatch(/^Position 1: "Status" is not something a formula knows: write a column as \[Status\]/);
    expect(msg('1 2')).toBe('Position 3: Expected an operator such as & or + but found "2"');
    expect(msg('1 % 2')).toMatch(/^Position 3: "%" cannot be used here/);
    expect(msg('')).toBe('Position 1: The formula is empty');
    expect(msg('IF(1, 2, 3, 4)')).toBe('Position 1: IF needs 2 or 3 values, got 4 (IF(test, then, else))');
    expect(msg('TODAY(1)')).toBe('Position 1: TODAY needs no values, got 1 (TODAY())');
    expect(msg('UPPPER("a")')).toBe('Position 1: there is no function UPPPER — did you mean UPPER?');
    expect(msg('IFS(TRUE, 1, FALSE)')).toBe('Position 1: IFS needs pairs of a test and a value, got 3 values');
  });

  it('checks columns against the file and suggests the closest one', () => {
    expect(checkFormula('[Stauts] & [Code]', ['Status', 'Code']).error?.message).toBe('Column [Stauts] is not in the file — did you mean [Status]?');
    expect(checkFormula('[Zzz]', ['Status']).error?.message).toBe('Column [Zzz] is not in the file');
    expect(checkFormula('CONCAT([Code], "-", [Status])', ['Status', 'Code'])).toMatchObject({ ok: true, columns: ['Code', 'Status'], functions: ['CONCAT'] });
    expect(closest('status', ['Status'])).toBe('Status');
  });

  it('is safe against hostile input', () => {
    expect(checkFormula('x'.repeat(2001)).error?.message).toMatch(/at most 2000 characters/);
    expect(checkFormula('('.repeat(MAX_DEPTH + 1) + '1' + ')'.repeat(MAX_DEPTH + 1)).error?.message).toMatch(/nested too deeply/);
    expect(checkFormula('-'.repeat(MAX_DEPTH + 1) + '1').error?.message).toMatch(/nested too deeply/);
    expect(checkFormula('UPPER('.repeat(MAX_DEPTH + 1) + '"a"' + ')'.repeat(MAX_DEPTH + 1)).error?.message).toMatch(/nested too deeply/);
    expect(checkFormula('NOT '.repeat(MAX_DEPTH + 1) + 'TRUE').error?.message).toMatch(/nested too deeply/);
    // Output that would grow without bound is stopped.
    const doubling = Array.from({ length: 14 }).reduce<string>((f) => `CONCAT(${f}, ${f})`, '"aaaaaaaaaa"');
    if (doubling.length <= 2000) expect(fails(doubling)).toMatch(/longer than 10000 characters|too long/);
    const wide = 'CONCAT(' + Array(50).fill('"' + 'x'.repeat(30) + '"').join(',') + ')';
    expect(run(`LEN(${wide})`)).toBe('1500');
    // No way to reach anything but the row: names that look like code are not functions.
    for (const f of ['EVAL("1")', 'SQL("select 1")', 'FETCH("http://x")', 'constructor("x")', '__proto__(1)']) expect(checkFormula(f).ok).toBe(false);
    expect(fails('process.exit()')).toMatch(/^Position/);
    expect(run('[__proto__]')).toBe('');
    expect(run('[constructor]')).toBe('');
    expect(run('LEN("\u0000‮")')).toBe('2');
  });

  it('parses once per formula text and lists every function for suggestions', () => {
    expect(parseFormula('1').type).toBe('number');
    expect(FUNCTION_LIST.map((f) => f.name)).toEqual(expect.arrayContaining(['CONCAT', 'IF', 'SWITCH', 'NUMBER', 'CONVERT', 'DATE', 'ADDDAYS', 'IN']));
    expect(FUNCTION_LIST.every((f) => f.usage && f.description)).toBe(true);
  });
});

describe('formulas in field rows', () => {
  const catalogue: EntityCatalogue = {
    entityType: 'machine',
    label: 'Machines',
    keyHint: 'Code',
    fields: [
      { key: 'code', label: 'Code', type: 'text', required: true },
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'qty', label: 'Quantity', type: 'number' },
      { key: 'due', label: 'Due', type: 'date' },
      { key: 'active', label: 'Active', type: 'boolean' },
    ],
  };
  const spec = (fields: Parameters<typeof applyMapping>[1]['fields']) => ({ keyField: 'Code', fields });

  it('a formula fills the field, then the steps run', () => {
    const out = applyMapping(catalogue, spec([
      { target: 'code', formula: 'CONCAT("M-", [Code])', steps: [{ kind: 'upper' }] },
      { target: 'qty', formula: '[Qty] * [Price]' },
      { target: 'due', formula: 'DATE([Due date], "dd.MM.yyyy")' },
      { target: 'active', formula: '[Status] <> "Scrapped"' },
    ]), row);
    expect(out.errors).toEqual([]);
    expect(out.canonical).toEqual({ code: 'M-AB-12', qty: 30, due: '2026-01-31', active: false });
    const trail: string[] = [];
    rawValue({ target: 'code', formula: 'CONCAT("M-", [Code])', steps: [{ kind: 'upper' }] }, row, trail);
    expect(trail).toEqual(['M-ab-12', 'M-AB-12']);
  });

  it('never reads inherited properties as columns', () => {
    const out = applyMapping(catalogue, { keyField: 'constructor', fields: [{ target: 'code', source: '__proto__' }, { target: 'name', formula: '[constructor] & [toString]' }] }, row);
    expect(out.externalId).toBeNull();
    expect(out.canonical).toEqual({ code: null, name: null });
  });

  it('a failing formula rejects the row with the field name', () => {
    const out = applyMapping(catalogue, spec([{ target: 'code', source: 'Code' }, { target: 'qty', formula: '[Name] * 2' }]), row);
    expect(out.errors).toEqual([{ field: 'qty', message: 'Quantity: * needs a number, got "big LATHE"' }]);
  });

  it('mapping problems include the formula\'s, and a formula counts as the source', () => {
    expect(mappingProblems(catalogue, spec([{ target: 'code', formula: '[Code' }]))).toEqual(['Code: Position 1: This column name has no closing ]']);
    expect(mappingProblems(catalogue, spec([{ target: 'code', formula: '[Stauts]' }]), ['Code', 'Status'])).toEqual(['Code: Column [Stauts] is not in the file — did you mean [Status]?']);
    expect(mappingProblems(catalogue, spec([{ target: 'code', formula: '"FIXED"' }]))).toEqual([]);
    expect(fieldColumns({ target: 'code', formula: '[Code] & [Status]', steps: [{ kind: 'coalesce', columns: ['Alt'] }] })).toEqual(['Code', 'Status', 'Alt']);
    expect(fieldColumns({ target: 'code', transform: 'concat', sources: ['A', 'B'] })).toEqual(['A', 'B']);
  });
});
