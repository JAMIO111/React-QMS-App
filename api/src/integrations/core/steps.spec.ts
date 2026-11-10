import { EntityCatalogue } from './catalogue';
import { applyMapping, FieldMapping, mappingProblems } from './mapping';
import { applyStep, applySteps, parsePattern, readNumber, Step, stepProblems } from './steps';

const row: Record<string, string> = { Code: '  ab-12 ', Name: 'big LATHE', Alt: 'Second', Empty: '', Qty: '1.234,5', When: '31.01.2026', Len: '25.4' };
const get = (c: string) => String(row[c] ?? '').trim();
const one = (step: Step, v: string) => applyStep(step, v, get);
const ok = (step: Step, v: string) => {
  const r = one(step, v);
  if ('error' in r) throw new Error(r.error);
  return r.value;
};

describe('steps', () => {
  it('text steps', () => {
    expect(ok({ kind: 'trim' }, '  a b  ')).toBe('a b');
    expect(ok({ kind: 'upper' }, 'ab')).toBe('AB');
    expect(ok({ kind: 'lower' }, 'AB')).toBe('ab');
    expect(ok({ kind: 'title' }, "o'neil mc-donald machine")).toBe("O'Neil Mc-Donald Machine");
    expect(ok({ kind: 'collapse_spaces' }, ' a   b \t c ')).toBe('a b c');
    expect(ok({ kind: 'replace', find: '-', with: '/' }, 'a-b-c')).toBe('a/b/c');
    expect(ok({ kind: 'replace', find: 'X', with: 'y' }, 'xX')).toBe('yy');
    expect(ok({ kind: 'replace', find: 'X', with: 'y', ignoreCase: false }, 'xX')).toBe('xy');
    expect(ok({ kind: 'replace', find: '.', with: '' }, '1.2.3')).toBe('123');
    expect(ok({ kind: 'remove', characters: '-/ ' }, 'a-b/c d')).toBe('abcd');
    expect(ok({ kind: 'left', count: 3 }, 'abcdef')).toBe('abc');
    expect(ok({ kind: 'right', count: 2 }, 'abcdef')).toBe('ef');
    expect(ok({ kind: 'split', separator: '|', part: 2 }, 'a|b|c')).toBe('b');
    expect(ok({ kind: 'split', separator: '|', part: -1 }, 'a|b|c')).toBe('c');
    expect(ok({ kind: 'split', separator: '|', part: 9 }, 'a|b')).toBe('');
    expect(ok({ kind: 'prefix', text: 'M-' }, '12')).toBe('M-12');
    expect(ok({ kind: 'prefix', text: 'M-' }, '')).toBe('');
    expect(ok({ kind: 'suffix', text: ' mm' }, '12')).toBe('12 mm');
  });

  it('number steps', () => {
    expect(ok({ kind: 'number', decimal: ',', thousands: '.' }, '1.234,5')).toBe('1234.5');
    expect(ok({ kind: 'number', decimal: '.', thousands: ',' }, '1,234.5')).toBe('1234.5');
    expect(ok({ kind: 'number', decimal: '.', thousands: ' ' }, '1 234.5')).toBe('1234.5');
    expect(one({ kind: 'number' }, 'twelve')).toEqual({ error: '"twelve" is not a number' });
    expect(ok({ kind: 'number' }, '')).toBe('');
    expect(ok({ kind: 'round', places: 2 }, '1.005')).toBe('1.01');
    expect(ok({ kind: 'round', places: 0 }, '2.5')).toBe('3');
    expect(ok({ kind: 'multiply', by: 1000 }, '1.5')).toBe('1500');
    expect(ok({ kind: 'divide', by: 4 }, '10')).toBe('2.5');
    expect(one({ kind: 'divide', by: 0 }, '10')).toEqual({ error: 'Cannot divide by 0' });
    expect(ok({ kind: 'convert', from: 'in', to: 'mm' }, '1')).toBe('25.4');
    expect(ok({ kind: 'convert', from: 'mm', to: 'in' }, '25.4')).toBe('1');
    expect(ok({ kind: 'convert', from: 'lb', to: 'kg' }, '1')).toBe('0.45359237');
    expect(ok({ kind: 'convert', from: 'c', to: 'f' }, '100')).toBe('212');
    expect(ok({ kind: 'convert', from: 'f', to: 'c' }, '32')).toBe('0');
    expect(one({ kind: 'convert', from: 'kg', to: 'mm' }, '1')).toEqual({ error: 'Cannot convert kg to mm' });
    expect(readNumber('1e3')).toBe(1000);
    expect(readNumber('1.2.3')).toBeNull();
  });

  it('date steps', () => {
    expect(ok({ kind: 'date', format: 'dmy' }, '31/01/2026')).toBe('2026-01-31');
    expect(ok({ kind: 'date', format: 'mdy' }, '01/31/2026')).toBe('2026-01-31');
    expect(ok({ kind: 'date', format: 'excel' }, '46053')).toBe('2026-01-31');
    expect(ok({ kind: 'date', format: 'dd.MM.yyyy' }, '31.01.2026')).toBe('2026-01-31');
    expect(ok({ kind: 'date', format: 'yyyyMMdd' }, '20260131')).toBe('2026-01-31');
    expect(ok({ kind: 'date', format: 'd/M/yy' }, '1/2/26')).toBe('2026-02-01');
    expect(one({ kind: 'date', format: 'dd.MM.yyyy' }, '31.02.2026')).toEqual({ error: '"31.02.2026" is not a date written as dd.MM.yyyy' });
    expect(parsePattern('2026-13-01', 'yyyy-MM-dd')).toBeNull();
    expect(ok({ kind: 'add_days', days: 30 }, '2026-01-31')).toBe('2026-03-02');
    expect(ok({ kind: 'add_days', days: -1 }, '2026-03-01')).toBe('2026-02-28');
    expect('error' in one({ kind: 'add_days', days: 1 }, '31/01/2026')).toBe(true);
  });

  it('logic steps', () => {
    expect(ok({ kind: 'map', values: { Y: 'yes', N: 'no' } }, 'y')).toBe('yes');
    expect(ok({ kind: 'map', values: { Y: 'yes' } }, 'Q')).toBe('Q');
    expect(ok({ kind: 'map', values: { Y: 'yes' }, unmatched: 'empty' }, 'Q')).toBe('');
    expect(one({ kind: 'map', values: { Y: 'yes' }, unmatched: 'error' }, 'Q')).toEqual({ error: '"Q" is not in the translation list' });
    expect(ok({ kind: 'if', test: 'equals', value: 'scrapped', then: 'inactive', else: 'active' }, 'Scrapped')).toBe('inactive');
    expect(ok({ kind: 'if', test: 'equals', value: 'scrapped', then: 'inactive', else: 'active' }, 'In use')).toBe('active');
    expect(ok({ kind: 'if', test: 'contains', value: 'old', then: 'x' }, 'Gold')).toBe('x');
    expect(ok({ kind: 'if', test: 'starts_with', value: 'M', then: 'machine' }, 'Lathe')).toBe('Lathe');
    expect(ok({ kind: 'if', test: 'empty', then: 'n/a' }, '  ')).toBe('n/a');
    expect(ok({ kind: 'if', test: 'not_empty', then: 'yes', else: 'no' }, '')).toBe('no');
    expect(ok({ kind: 'if', test: 'one_of', list: ['lost', 'destroyed'], then: 'false', else: 'true' }, 'Destroyed')).toBe('false');
    expect(ok({ kind: 'coalesce', columns: ['Empty', 'Alt'] }, '')).toBe('Second');
    expect(ok({ kind: 'coalesce', columns: ['Alt'] }, 'mine')).toBe('mine');
    expect(ok({ kind: 'join', separator: '-', parts: [{ column: 'Code' }, { text: 'X' }, { current: true }, { column: 'Empty' }] }, 'v')).toBe('ab-12-X-v');
    expect(ok({ kind: 'default', text: 'Unknown' }, '')).toBe('Unknown');
    expect(ok({ kind: 'default', text: 'Unknown' }, 'Known')).toBe('Known');
  });

  it('applies steps in order, keeps a trail and stops at the first error', () => {
    const trail: string[] = [];
    expect(applySteps([{ kind: 'trim' }, { kind: 'upper' }, { kind: 'prefix', text: 'M-' }], ' ab ', get, trail)).toEqual({ value: 'M-AB' });
    expect(trail).toEqual(['ab', 'AB', 'M-AB']);
    expect(applySteps([{ kind: 'number' }, { kind: 'upper' }], 'x', get)).toEqual({ error: '"x" is not a number' });
  });

  it('lists the problems of steps before saving', () => {
    expect(stepProblems([{ kind: 'replace' }], 'Name')).toEqual(['Name, step 1 (replace): say what to find']);
    expect(stepProblems([{ kind: 'left', count: 0 }], 'Name')).toEqual(['Name, step 1 (left): give a number of characters from 1 to 1000']);
    expect(stepProblems([{ kind: 'convert', from: 'kg', to: 'm' }], 'Weight')[0]).toMatch(/same kind/);
    expect(stepProblems([{ kind: 'date', format: 'qq' }], 'Due')[0]).toMatch(/year, a month and a day/);
    expect(stepProblems([{ kind: 'date', format: 'MM/yyyy' }], 'Due')[0]).toMatch(/year, a month and a day/);
    expect(stepProblems([{ kind: 'coalesce', columns: ['Nope'] }], 'Name', new Set(['Code']))).toEqual(['Name, step 1 (coalesce): the column "Nope" is not in the file']);
    expect(stepProblems([{ kind: 'trim' }, { kind: 'date', format: 'dd.MM.yyyy' }], 'Due')).toEqual([]);
  });
});

describe('steps inside a mapping', () => {
  const catalogue: EntityCatalogue = {
    entityType: 'machine',
    label: 'Machines',
    keyHint: 'Code',
    fields: [
      { key: 'code', label: 'Code', type: 'text', required: true },
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'qty', label: 'Quantity', type: 'number' },
      { key: 'due', label: 'Due', type: 'date' },
      { key: 'len', label: 'Length', type: 'number' },
    ],
  };
  const spec = (fields: FieldMapping[]) => ({ keyField: 'Code', fields });

  it('the original transforms and their steps give the same values', () => {
    const pairs: [FieldMapping, FieldMapping][] = [
      [{ target: 'name', source: 'Name', transform: 'upper' }, { target: 'name', source: 'Name', steps: [{ kind: 'upper' }] }],
      [{ target: 'name', source: 'Name', transform: 'lower' }, { target: 'name', source: 'Name', steps: [{ kind: 'lower' }] }],
      [{ target: 'name', source: 'Name', transform: 'map', values: { 'BIG lathe': 'Lathe' } }, { target: 'name', source: 'Name', steps: [{ kind: 'map', values: { 'BIG lathe': 'Lathe' } }] }],
      [{ target: 'name', source: 'Name', transform: 'concat', sources: ['Code', 'Name'], separator: '/' }, { target: 'name', steps: [{ kind: 'join', separator: '/', parts: [{ column: 'Code' }, { column: 'Name' }] }] }],
      [{ target: 'qty', source: 'Qty', decimal: ',' }, { target: 'qty', source: 'Qty', steps: [{ kind: 'number', decimal: ',', thousands: '.' }] }],
      [{ target: 'due', source: 'When', dateFormat: 'dmy' }, { target: 'due', source: 'When', steps: [{ kind: 'date', format: 'dd.MM.yyyy' }] }],
      [{ target: 'name', source: 'Empty', default: 'n/a' }, { target: 'name', source: 'Empty', steps: [{ kind: 'default', text: 'n/a' }] }],
    ];
    for (const [legacy, stepped] of pairs) {
      const a = applyMapping(catalogue, spec([{ target: 'code', source: 'Code' }, legacy]), row);
      const b = applyMapping(catalogue, spec([{ target: 'code', source: 'Code' }, stepped]), row);
      expect(b.canonical).toEqual(a.canonical);
      expect(b.errors).toEqual(a.errors);
    }
  });

  it('a step error rejects the row with the field name; a number step is not read again with the field\'s decimal mark', () => {
    const bad = applyMapping(catalogue, spec([{ target: 'code', source: 'Code' }, { target: 'qty', source: 'Name', steps: [{ kind: 'number' }] }]), row);
    expect(bad.errors).toEqual([{ field: 'qty', message: 'Quantity: "big LATHE" is not a number' }]);
    const conv = applyMapping(catalogue, spec([{ target: 'code', source: 'Code' }, { target: 'len', source: 'Len', decimal: ',', steps: [{ kind: 'convert', from: 'mm', to: 'in' }] }]), row);
    expect(conv.canonical.len).toBe(1);
  });

  it('mapping problems include the steps\' problems, and a field filled by a step needs no column', () => {
    expect(mappingProblems(catalogue, spec([{ target: 'code', source: 'Code' }, { target: 'name', steps: [{ kind: 'replace' }] }]))).toEqual([
      'Name: choose a column or a default',
      'Name, step 1 (replace): say what to find',
    ]);
    expect(mappingProblems(catalogue, spec([{ target: 'code', source: 'Code' }, { target: 'name', steps: [{ kind: 'join', parts: [{ column: 'Code' }, { column: 'Name' }] }] }]))).toEqual([]);
  });
});
