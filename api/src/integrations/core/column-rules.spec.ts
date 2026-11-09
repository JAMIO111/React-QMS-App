import { catalogueFor } from './catalogue';
import { applyRules, parseConstraint, patternMaxLength, tableRules } from './column-rules';

describe('reading the database rules', () => {
  it('reads length limits, simple patterns, allowed values and numeric bounds as Postgres prints them', () => {
    expect(parseConstraint(`CHECK (((length(TRIM(BOTH FROM name)) >= 1) AND (length(TRIM(BOTH FROM name)) <= 200)))`)).toEqual({ name: { maxLength: 200 } });
    expect(parseConstraint(`CHECK (((city IS NULL) OR ((length(btrim(city)) >= 1) AND (length(btrim(city)) <= 80))))`)).toEqual({ city: { maxLength: 80 } });
    expect(parseConstraint(`CHECK (((notes IS NULL) OR (length(notes) <= 5000)))`)).toEqual({ notes: { maxLength: 5000 } });
    expect(parseConstraint(`CHECK ((code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'::text))`)).toEqual({ code: { maxLength: 20, pattern: '^[A-Z0-9][A-Z0-9_-]{0,19}$' } });
    expect(parseConstraint(`CHECK ((asset_number ~ '^\\S(.{0,38}\\S)?$'::text))`)).toEqual({ asset_number: { maxLength: 40, pattern: '^\\S(.{0,38}\\S)?$' } });
    expect(parseConstraint(`CHECK (((supplier_type IS NULL) OR (supplier_type = ANY (ARRAY['manufacturer'::text, 'other'::text]))))`)).toEqual({ supplier_type: { options: ['manufacturer', 'other'] } });
    expect(parseConstraint(`CHECK (((interval_value >= 1) AND (interval_value <= 1000)))`)).toEqual({ interval_value: { min: 1, max: 1000 } });
    expect(parseConstraint(`CHECK (((resolution IS NULL) OR (resolution > (0)::numeric)))`)).toEqual({ resolution: { min: 0, minExclusive: true } });
    expect(parseConstraint(`CHECK ((quantity_affected >= (0)::numeric))`)).toEqual({ quantity_affected: { min: 0 } });
    // a POSIX class means something else in JavaScript: the pattern is not taken over (its length still is)
    expect(parseConstraint(`CHECK (((email IS NULL) OR ((length(email) <= 200) AND (email ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'::text))))`)).toEqual({ email: { maxLength: 200 } });
    // a comparison between two columns is not a bound
    expect(parseConstraint(`CHECK (((range_min IS NULL) OR (range_max IS NULL) OR (range_max >= range_min)))`)).toEqual({});
    expect(patternMaxLength('^[A-Z]{2}$')).toBe(2);
    expect(patternMaxLength('^(a|b)+$')).toBeUndefined();
  });

  it('puts the database limits over the written catalogue, keeping its labels and choices', () => {
    const rules = {
      suppliers: tableRules([
        `CHECK ((code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'::text))`,
        `CHECK (((supplier_type IS NULL) OR (supplier_type = ANY (ARRAY['manufacturer'::text, 'broker'::text]))))`,
        `CHECK (((city IS NULL) OR ((length(btrim(city)) >= 1) AND (length(btrim(city)) <= 80))))`,
      ]),
    };
    const cat = applyRules(catalogueFor('supplier')!, rules);
    const f = (k: string) => cat.fields.find((x) => x.key === k)!;
    expect(f('code')).toMatchObject({ maxLength: 20, pattern: '^[A-Z0-9][A-Z0-9_-]{0,19}$', required: true, label: 'Code' });
    expect(f('city').maxLength).toBe(80);
    expect(f('supplierType').options).toEqual([{ value: 'manufacturer', label: 'Manufacturer' }, { value: 'broker', label: 'Broker' }]);
    expect(f('name').maxLength).toBe(200); // no rule read: the written limit stays
  });

  it('gives numeric bounds to number fields and leaves reference fields alone', () => {
    const rules = { gauges: tableRules([`CHECK (((interval_value >= 1) AND (interval_value <= 1000)))`, `CHECK (((resolution IS NULL) OR (resolution > (0)::numeric)))`]) };
    const cat = applyRules(catalogueFor('gauge')!, rules);
    expect(cat.fields.find((x) => x.key === 'intervalValue')).toMatchObject({ min: 1, max: 1000 });
    expect(cat.fields.find((x) => x.key === 'resolution')).toMatchObject({ min: 0, minExclusive: true });
    expect(cat.fields.find((x) => x.key === 'gaugeType')!.min).toBeUndefined();
  });
});
