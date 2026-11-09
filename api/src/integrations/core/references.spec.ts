import { catalogueFor } from './catalogue';
import { MappedRecord, resolveReferences } from './references';

describe('references between imported records', () => {
  const nc = catalogueFor('nonconformance')!;
  const spec = {
    keyField: 'NC',
    fields: [
      { target: 'title', source: 'T' },
      { target: 'source', source: 'S' },
      { target: 'causalMachine', source: 'Machine', match: 'source' as const },
      { target: 'category', source: 'Cat' },
    ],
  };

  it('resolves by the source id or the Fortress code, one lookup per field, and reports what it cannot find', async () => {
    const calls: string[] = [];
    const lookup = async (kind: string, mode: string, values: string[]): Promise<Record<string, string>> => {
      calls.push(`${kind}:${mode}:${values.join(',')}`);
      if (kind === 'machine') return { '17': 'm-17' };
      return { PRODUCT: 'c-1' };
    };
    const rows: Array<MappedRecord & { canonical: Record<string, unknown> }> = [
      { canonical: { title: 'A', causalMachine: '17', category: 'PRODUCT' } as Record<string, unknown>, errors: [] },
      { canonical: { title: 'B', causalMachine: '99', category: 'PRODUCT' } as Record<string, unknown>, errors: [] },
      { canonical: { title: 'C', causalMachine: null, category: 'NOPE' } as Record<string, unknown>, errors: [] },
    ];
    await resolveReferences(nc, spec, rows, lookup);
    expect(calls).toEqual(['machine:source:17,99', 'category:code:PRODUCT,NOPE']);
    expect(rows[0].canonical).toMatchObject({ causalMachineId: 'm-17', categoryId: 'c-1' });
    expect(rows[0].errors).toEqual([]);
    expect(rows[1].errors[0].message).toMatch(/no machine "99" has been imported through this connection yet/);
    expect(rows[2].canonical.causalMachineId).toBeNull();
    expect(rows[2].errors[0]).toEqual({ field: 'category', message: 'Category: there is no category "NOPE" in Fortress' });
  });

  it('gives a unit its code and says when a department code is ambiguous', async () => {
    const gauge = catalogueFor('gauge')!;
    const rows = [{ canonical: { assetNumber: 'G', description: 'x', unit: 'MM', department: 'QA' } as Record<string, unknown>, errors: [] as { field: string | null; message: string }[] }];
    await resolveReferences(gauge, { keyField: 'A', fields: [{ target: 'unit', source: 'U' }, { target: 'department', source: 'D' }] }, rows, async (kind): Promise<Record<string, string>> =>
      kind === 'unit' ? { MM: 'mm' } : { QA: 'ambiguous' },
    );
    expect(rows[0].canonical.unitCode).toBe('mm');
    expect(rows[0].errors[0].message).toMatch(/used by more than one department/);
  });
});
