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

describe('the catalogue of what can be imported', () => {
  it('covers machines, employees, gauge types, gauges and non-conformances', () => {
    for (const e of ['machine', 'employee', 'gauge_type', 'gauge', 'nonconformance']) expect(catalogueFor(e)?.fields.some((f) => f.required)).toBe(true);
  });

  it('checks a gauge row: integer interval, enum unit, number range', () => {
    const cat = catalogueFor('gauge')!;
    const spec = {
      keyField: 'Asset',
      fields: [
        { target: 'assetNumber', source: 'Asset' },
        { target: 'description', source: 'Desc' },
        { target: 'intervalValue', source: 'Every' },
        { target: 'intervalUnit', source: 'Unit' },
        { target: 'rangeMax', source: 'Max', decimal: ',' as const },
      ],
    };
    expect(mappingProblems(cat, spec, ['Asset', 'Desc', 'Every', 'Unit', 'Max'])).toEqual([]);
    const ok = applyMapping(cat, spec, { Asset: 'G-1', Desc: 'Micrometer', Every: '6', Unit: 'Months', Max: '25,4' });
    expect(ok.errors).toEqual([]);
    expect(ok.canonical).toMatchObject({ assetNumber: 'G-1', intervalValue: 6, intervalUnit: 'months', rangeMax: 25.4 });
    const bad = applyMapping(cat, spec, { Asset: 'G-2', Desc: 'Caliper', Every: '1.5', Unit: 'fortnights', Max: '' });
    expect(bad.errors.map((e) => e.field)).toEqual(expect.arrayContaining(['intervalValue', 'intervalUnit']));
  });

  it('accepts a non-conformance source by its label and needs title and source', () => {
    const cat = catalogueFor('nonconformance')!;
    expect(mappingProblems(cat, { keyField: 'NC', fields: [{ target: 'title', source: 'T' }] })).toContain('Source is required: map a column to it');
    const spec = { keyField: 'NC', fields: [{ target: 'title', source: 'T' }, { target: 'source', source: 'S' }, { target: 'severity', source: 'Sev' }] };
    const r = applyMapping(cat, spec, { NC: 'NC-0042', T: 'Burr on edge', S: 'Goods receiving', Sev: 'Major' });
    expect(r.errors).toEqual([]);
    expect(r.canonical).toMatchObject({ source: 'goods_receiving', severity: 'major' });
    expect(r.externalId).toBe('NC-0042');
  });
});
