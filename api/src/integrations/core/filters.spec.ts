import { applyFilter, describeFilter, filterProblems, isActive, normaliseFilter, ruleMatches, RecordFilter, FilterRule } from './filters';

const rec = (o: Record<string, string>) => o;
const rule = (r: Partial<FilterRule> & Pick<FilterRule, 'column' | 'test'>): FilterRule => r;
const keep = (rules: FilterRule[], match: 'all' | 'any' = 'all'): RecordFilter => ({ mode: 'keep', match, rules });
const leaveOut = (rules: FilterRule[], match: 'all' | 'any' = 'all'): RecordFilter => ({ mode: 'leave_out', match, rules });

describe('rule tests', () => {
  it('compare text ignoring case and spaces', () => {
    expect(ruleMatches(rule({ column: 'Status', test: 'equals', value: 'active' }), rec({ Status: ' ACTIVE ' }))).toBe(true);
    expect(ruleMatches(rule({ column: 'Status', test: 'not_equals', value: 'active' }), rec({ Status: 'Closed' }))).toBe(true);
    expect(ruleMatches(rule({ column: 'Name', test: 'contains', value: 'bolt' }), rec({ Name: 'Hex BOLT M8' }))).toBe(true);
    expect(ruleMatches(rule({ column: 'Name', test: 'not_contains', value: 'bolt' }), rec({ Name: 'Hex BOLT M8' }))).toBe(false);
    expect(ruleMatches(rule({ column: 'Name', test: 'starts_with', value: 'hex' }), rec({ Name: 'Hex bolt' }))).toBe(true);
    expect(ruleMatches(rule({ column: 'Name', test: 'ends_with', value: 'm8' }), rec({ Name: 'Hex bolt M8' }))).toBe(true);
  });

  it('knows empty, and a missing column is empty', () => {
    expect(ruleMatches(rule({ column: 'A', test: 'is_empty' }), rec({ A: '  ' }))).toBe(true);
    expect(ruleMatches(rule({ column: 'A', test: 'is_empty' }), rec({}))).toBe(true);
    expect(ruleMatches(rule({ column: 'A', test: 'not_empty' }), rec({ A: 'x' }))).toBe(true);
  });

  it('matches against a list', () => {
    const r = rule({ column: 'Type', test: 'in', values: ['TRF', 'adj'] });
    expect(ruleMatches(r, rec({ Type: 'ADJ' }))).toBe(true);
    expect(ruleMatches(r, rec({ Type: 'PO' }))).toBe(false);
    expect(ruleMatches({ ...r, test: 'not_in' }, rec({ Type: 'PO' }))).toBe(true);
  });

  it('compares numbers as numbers, with either decimal mark', () => {
    expect(ruleMatches(rule({ column: 'Qty', test: 'gt', value: '9', as: 'number' }), rec({ Qty: '10' }))).toBe(true);
    expect(ruleMatches(rule({ column: 'Qty', test: 'gt', value: '9', as: 'number' }), rec({ Qty: '9' }))).toBe(false);
    expect(ruleMatches(rule({ column: 'Qty', test: 'gte', value: '9', as: 'number' }), rec({ Qty: '9' }))).toBe(true);
    expect(ruleMatches(rule({ column: 'Qty', test: 'lt', value: '1.5', as: 'number', decimal: ',' }), rec({ Qty: '1.000,25' }))).toBe(false);
    expect(ruleMatches(rule({ column: 'Qty', test: 'between', value: '1', valueTo: '5', as: 'number' }), rec({ Qty: '5' }))).toBe(true);
    expect(ruleMatches(rule({ column: 'Qty', test: 'between', value: '1', valueTo: '5', as: 'number' }), rec({ Qty: '5.01' }))).toBe(false);
    expect(ruleMatches(rule({ column: 'Qty', test: 'equals', value: '10', as: 'number' }), rec({ Qty: '10.0' }))).toBe(true);
  });

  it('compares dates written the way the source writes them', () => {
    const r = rule({ column: 'Created', test: 'lt', value: '01/02/2026', as: 'date', dateFormat: 'dmy' });
    expect(ruleMatches(r, rec({ Created: '31/01/2026' }))).toBe(true);
    expect(ruleMatches(r, rec({ Created: '01/02/2026' }))).toBe(false);
    expect(ruleMatches({ ...r, dateFormat: 'iso', value: '2026-02-01' }, rec({ Created: '2025-12-31' }))).toBe(true);
  });

  it('never matches a value that is not the number or date asked for', () => {
    expect(ruleMatches(rule({ column: 'Qty', test: 'gt', value: '1', as: 'number' }), rec({ Qty: 'lots' }))).toBe(false);
    expect(ruleMatches(rule({ column: 'Qty', test: 'lt', value: '1', as: 'number' }), rec({ Qty: 'lots' }))).toBe(false);
    expect(ruleMatches(rule({ column: 'D', test: 'gt', value: '2026-01-01', as: 'date' }), rec({ D: 'soon' }))).toBe(false);
  });

  it('reads only the record\'s own columns', () => {
    expect(ruleMatches(rule({ column: 'constructor', test: 'not_empty' }), rec({}))).toBe(false);
    expect(ruleMatches(rule({ column: '__proto__', test: 'not_empty' }), rec({}))).toBe(false);
  });
});

describe('applying a filter', () => {
  it('keeps records that meet all of the rules', () => {
    const f = keep([rule({ column: 'Status', test: 'equals', value: 'Active' }), rule({ column: 'Site', test: 'equals', value: 'Leeds' })]);
    expect(applyFilter(f, rec({ Status: 'active', Site: 'LEEDS' })).keep).toBe(true);
    const out = applyFilter(f, rec({ Status: 'active', Site: 'Hull' }));
    expect(out.keep).toBe(false);
    expect(out.reason).toBe('Filtered out: does not meet Status is "Active" and Site is "Leeds"');
    expect(out.matched).toEqual([true, false]);
  });

  it('keeps records that meet any of the rules', () => {
    const f = keep([rule({ column: 'Status', test: 'equals', value: 'Active' }), rule({ column: 'Status', test: 'equals', value: 'New' })], 'any');
    expect(applyFilter(f, rec({ Status: 'New' })).keep).toBe(true);
    expect(applyFilter(f, rec({ Status: 'Old' })).keep).toBe(false);
  });

  it('leaves out records that match, and says which rule did it', () => {
    const f = leaveOut([rule({ column: 'Type', test: 'in', values: ['TRF', 'ADJ'] }), rule({ column: 'Qty', test: 'lt', value: '0', as: 'number' })], 'any');
    expect(applyFilter(f, rec({ Type: 'PO', Qty: '5' })).keep).toBe(true);
    const out = applyFilter(f, rec({ Type: 'PO', Qty: '-1' }));
    expect(out.keep).toBe(false);
    expect(out.reason).toBe('Filtered out: Qty is less than 0');
  });

  it('works from a formula, and leaves a record it cannot judge unread, with the reason', () => {
    const f: RecordFilter = { mode: 'leave_out', match: 'all', rules: [], formula: 'IN([Type], "TRF", "ADJ")' };
    expect(applyFilter(f, rec({ Type: 'trf' })).keep).toBe(false);
    expect(applyFilter(f, rec({ Type: 'PO' })).keep).toBe(true);
    const bad = applyFilter({ mode: 'keep', match: 'all', rules: [], formula: '1/0 = 1' }, rec({}));
    expect(bad.keep).toBe(false);
    expect(bad.error).toMatch(/^Filter formula: /);
  });

  it('is in words', () => {
    expect(describeFilter(keep([rule({ column: 'Status', test: 'in', values: ['A', 'B'] })]))).toBe('Keep records where Status is one of "A", "B"');
    expect(describeFilter(leaveOut([rule({ column: 'N', test: 'between', value: '1', valueTo: '2', as: 'number' }), rule({ column: 'X', test: 'is_empty' })], 'any'))).toBe('Leave out records where N is between 1 and 2 or X is empty');
  });
});

describe('tidying and checking a filter', () => {
  it('drops empty rules and an empty formula, and nothing left is no filter', () => {
    expect(normaliseFilter(keep([rule({ column: '  ', test: 'equals', value: 'x' })]))).toBeNull();
    expect(normaliseFilter({ mode: 'keep', match: 'all', rules: [], formula: '   ' })).toBeNull();
    const n = normaliseFilter(keep([rule({ column: ' A ', test: 'equals', value: ' x ' })]))!;
    expect(n.rules[0]).toMatchObject({ column: 'A', value: 'x' });
    expect(isActive(n)).toBe(true);
    expect(isActive(null)).toBe(false);
  });

  it('says what is wrong, in words', () => {
    expect(filterProblems(keep([rule({ column: 'A', test: 'equals', value: 'x' })]), ['A'])).toEqual([]);
    expect(filterProblems(keep([rule({ column: 'Stauts', test: 'equals', value: 'x' })]), ['Status'])).toEqual(['Rule 1: the column Stauts is not in the source — did you mean Status?']);
    expect(filterProblems(keep([rule({ column: 'A', test: 'equals' })]))).toEqual(['Rule 1: give a value']);
    expect(filterProblems(keep([rule({ column: 'A', test: 'in', values: [] })]))).toEqual(['Rule 1: give at least one value']);
    expect(filterProblems(keep([rule({ column: 'A', test: 'gt', value: '1' })]))).toEqual(['Rule 1: "is more than" needs the column read as a number or a date']);
    expect(filterProblems(keep([rule({ column: 'A', test: 'gt', value: 'abc', as: 'number' })]))).toEqual(['Rule 1: "abc" is not a number']);
    expect(filterProblems(keep([rule({ column: 'A', test: 'between', value: '1', as: 'number' })]))).toEqual(['Rule 1: give the upper end']);
    expect(filterProblems(keep(Array.from({ length: 21 }, () => rule({ column: 'A', test: 'is_empty' }))))).toEqual(['A filter is limited to 20 rules']);
    expect(filterProblems({ mode: 'keep', match: 'all', rules: [rule({ column: 'A', test: 'is_empty' })], formula: 'TRUE' })).toEqual(['A filter is either rules or a formula, not both']);
  });

  it('checks a formula against the columns', () => {
    expect(filterProblems({ mode: 'keep', match: 'all', rules: [], formula: '[Status] = "Active"' }, ['Status'])).toEqual([]);
    const p = filterProblems({ mode: 'keep', match: 'all', rules: [], formula: '[Stauts] = "Active"' }, ['Status']);
    expect(p[0]).toMatch(/^Filter formula: .*Stauts/);
    expect(filterProblems({ mode: 'keep', match: 'all', rules: [], formula: 'NOPE(1)' })[0]).toMatch(/no function NOPE/);
  });
});
