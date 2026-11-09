import { catalogueFor } from './catalogue';
import { applyMapping, mappingProblems, parseDate } from './mapping';

const suppliers = catalogueFor('supplier')!;

describe('mapping problems', () => {
  it('asks for a key column, every required field, known targets and columns the file has', () => {
    const problems = mappingProblems(suppliers, { keyField: 'Acct', fields: [{ target: 'name', source: 'Nom' }, { target: 'colour', source: 'X' }, { target: 'name', source: 'Name' }] }, ['Acct', 'Name']);
    expect(problems).toEqual(
      expect.arrayContaining([
        'The column "Nom" is not in the file'.replace('The', 'Name: the'),
        '"colour" is not a field of suppliers',
        'Name is mapped twice',
        'Code is required: map a column to it',
      ]),
    );
    expect(mappingProblems(suppliers, { keyField: '', fields: [] })).toContain('Choose the column that identifies each record');
  });

  it('checks each transform has what it needs', () => {
    const p = mappingProblems(suppliers, {
      keyField: 'A',
      fields: [
        { target: 'code', transform: 'constant' },
        { target: 'name', transform: 'concat', sources: ['A'] },
        { target: 'supplierType', source: 'T', transform: 'map' },
        { target: 'email' },
      ],
    });
    expect(p).toEqual(expect.arrayContaining(['Code: give the value every record gets', 'Name: join at least two columns', 'Supplier type: list the values to translate', 'Email: choose a column or a default']));
  });
});

describe('applying a mapping', () => {
  const spec = {
    keyField: 'Account',
    fields: [
      { target: 'code', source: 'Account', transform: 'upper' as const },
      { target: 'name', transform: 'concat' as const, sources: ['Name', 'Suffix'], separator: ' ' },
      { target: 'supplierType', source: 'Type', transform: 'map' as const, values: { MFG: 'manufacturer', 'Sub-con': 'subcontractor' } },
      { target: 'country', source: 'Country', default: 'GB' },
      { target: 'active', source: 'Status' },
      { target: 'email', source: 'Email' },
    ],
  };

  it('builds the canonical record and its identifier', () => {
    const out = applyMapping(suppliers, spec, { Account: ' s-1 ', Name: 'Alpha', Suffix: 'Ltd', Type: 'mfg', Country: '', Status: 'Active', Email: 'q@alpha.example' });
    expect(out).toEqual({
      externalId: 's-1',
      canonical: { code: 'S-1', name: 'Alpha Ltd', supplierType: 'manufacturer', country: 'GB', active: true, email: 'q@alpha.example' },
      errors: [],
    });
  });

  it('reports every problem with the field it belongs to', () => {
    const out = applyMapping(suppliers, spec, { Account: '', Name: '', Type: 'Weird', Country: 'Britain', Status: 'maybe', Email: 'nope' });
    expect(out.externalId).toBeNull();
    expect(out.errors.map((e) => e.field)).toEqual(['code', 'name', 'supplierType', 'country', 'active', 'email']);
    expect(out.errors[2].message).toMatch(/Supplier type: "Weird" is not one of/);
  });

  it('converts numbers and dates as written in the source', () => {
    expect(parseDate('2026-11-09')).toBe('2026-11-09');
    expect(parseDate('09/11/2026', 'dmy')).toBe('2026-11-09');
    expect(parseDate('11/09/2026', 'mdy')).toBe('2026-11-09');
    expect(parseDate('31/02/2026', 'dmy')).toBeNull();
    expect(parseDate('46000', 'excel')).toBe('2025-12-09');
    expect(parseDate('09/11/2026')).toBeNull();
  });
});
