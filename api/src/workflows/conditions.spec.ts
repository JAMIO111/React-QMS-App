import { triggerFor } from './catalogue';
import { conditionProblems, evaluateConditions } from './conditions';

const nc = triggerFor('ncr.created')!;
const facts = { severity: 'major', source: 'customer', category: 'PRODUCT', supplier_id: null, part_id: 'p1' };

describe('workflow conditions', () => {
  it('matches when there is nothing to test', () => {
    expect(evaluateConditions(undefined, facts, nc)).toBe(true);
    expect(evaluateConditions({ all: [] }, facts, nc)).toBe(true);
  });

  it('tests equal, one of, not one of and emptiness, ignoring case', () => {
    expect(evaluateConditions({ all: [{ field: 'source', op: 'eq', value: 'Customer' }] }, facts, nc)).toBe(true);
    expect(evaluateConditions({ all: [{ field: 'source', op: 'ne', value: 'customer' }] }, facts, nc)).toBe(false);
    expect(evaluateConditions({ all: [{ field: 'severity', op: 'in', value: ['major', 'critical'] }] }, facts, nc)).toBe(true);
    expect(evaluateConditions({ all: [{ field: 'severity', op: 'not_in', value: ['major'] }] }, facts, nc)).toBe(false);
    expect(evaluateConditions({ all: [{ field: 'supplier_id', op: 'empty' }] }, facts, nc)).toBe(true);
    expect(evaluateConditions({ all: [{ field: 'part_id', op: 'not_empty' }] }, facts, nc)).toBe(true);
  });

  it('compares severities in their order', () => {
    expect(evaluateConditions({ all: [{ field: 'severity', op: 'gte', value: 'major' }] }, facts, nc)).toBe(true);
    expect(evaluateConditions({ all: [{ field: 'severity', op: 'gte', value: 'critical' }] }, facts, nc)).toBe(false);
    expect(evaluateConditions({ all: [{ field: 'severity', op: 'lte', value: 'minor' }] }, facts, nc)).toBe(false);
    expect(evaluateConditions({ all: [{ field: 'severity', op: 'gte', value: 'major' }] }, { severity: null }, nc)).toBe(false);
  });

  it('needs every "all" and at least one "any"', () => {
    const c = { all: [{ field: 'source', op: 'eq' as const, value: 'customer' }], any: [{ field: 'severity', op: 'eq' as const, value: 'critical' }, { field: 'category', op: 'eq' as const, value: 'product' }] };
    expect(evaluateConditions(c, facts, nc)).toBe(true);
    expect(evaluateConditions({ ...c, any: [{ field: 'severity', op: 'eq', value: 'critical' }] }, facts, nc)).toBe(false);
  });

  it('says what is wrong with conditions', () => {
    expect(conditionProblems({ all: [{ field: 'severity', op: 'in', value: ['major'] }] }, nc)).toEqual([]);
    expect(conditionProblems({ all: [{ field: 'colour', op: 'eq', value: 'red' }] }, nc)).toEqual(['"colour" is not something "A non-conformance is raised" can be tested on']);
    expect(conditionProblems({ all: [{ field: 'source', op: 'gte', value: 'customer' }] }, nc)).toEqual(['Source has no order, so "at least" / "at most" do not apply']);
    expect(conditionProblems({ all: [{ field: 'severity', op: 'eq', value: 'huge' }] }, nc)).toEqual(['Severity: "huge" is not one of the choices']);
    expect(conditionProblems({ all: [{ field: 'part_id', op: 'eq' }] }, nc)).toEqual(['Part: say what to compare with']);
  });
});

describe('numbers and words (WF4)', () => {
  const nc2 = triggerFor('ncr.created')!;
  const f = { quantity_affected: 40, total_cost: '120.50', title: 'Bent brackets on line 3' };
  it('compares numbers as numbers, never as words', () => {
    expect(evaluateConditions({ all: [{ field: 'quantity_affected', op: 'gt', value: '9' }] }, f, nc2)).toBe(true);
    expect(evaluateConditions({ all: [{ field: 'quantity_affected', op: 'lt', value: '100' }] }, f, nc2)).toBe(true);
    expect(evaluateConditions({ all: [{ field: 'total_cost', op: 'gte', value: '120.5' }] }, f, nc2)).toBe(true);
    expect(evaluateConditions({ all: [{ field: 'total_cost', op: 'lte', value: '100' }] }, f, nc2)).toBe(false);
    expect(evaluateConditions({ all: [{ field: 'quantity_affected', op: 'eq', value: '40.0' }] }, f, nc2)).toBe(true);
    expect(evaluateConditions({ all: [{ field: 'quantity_affected', op: 'gt', value: '9' }] }, { quantity_affected: null }, nc2)).toBe(false);
  });

  it('searches words ignoring case', () => {
    expect(evaluateConditions({ all: [{ field: 'title', op: 'contains', value: 'LINE 3' }] }, f, nc2)).toBe(true);
    expect(evaluateConditions({ all: [{ field: 'title', op: 'not_contains', value: 'scratch' }] }, f, nc2)).toBe(true);
    expect(evaluateConditions({ all: [{ field: 'title', op: 'not_contains', value: 'scratch' }] }, { title: null }, nc2)).toBe(true);
    expect(evaluateConditions({ all: [{ field: 'title', op: 'contains', value: 'bent' }] }, { title: null }, nc2)).toBe(false);
  });

  it('refuses tests that do not fit the field and numbers that are not numbers', () => {
    expect(conditionProblems({ all: [{ field: 'quantity_affected', op: 'gt', value: 'lots' }] }, nc2)).toEqual(['Quantity affected: "lots" is not a number']);
    expect(conditionProblems({ all: [{ field: 'source', op: 'contains', value: 'cust' }] }, nc2)).toEqual(['Source: "contains" applies to words only']);
    expect(conditionProblems({ all: [{ field: 'title', op: 'gt', value: '3' }] }, nc2)).toEqual(['Title has no order, so "at least" / "at most" do not apply']);
    expect(conditionProblems({ all: [{ field: 'quantity_affected', op: 'gte', value: '10' }, { field: 'title', op: 'contains', value: 'line' }] }, nc2)).toEqual([]);
  });
});
