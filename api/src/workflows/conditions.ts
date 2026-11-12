import type { Trigger } from './catalogue';

/**
 * A rule's conditions (WF1): `{ all: [...] }` (every one must hold) or `{ any: [...] }` (at least one), each `{ field, op, value? }`. No expressions, no code:
 * a closed set of operators over the facts the trigger offers. Empty conditions always match. Pure: the worker evaluates them, the API checks them when saved.
 */
export type Op = 'eq' | 'ne' | 'in' | 'not_in' | 'gte' | 'lte' | 'empty' | 'not_empty';
export interface Condition {
  field: string;
  op: Op;
  value?: string | string[];
}
export interface Conditions {
  all?: Condition[];
  any?: Condition[];
}

export const OPS: Op[] = ['eq', 'ne', 'in', 'not_in', 'gte', 'lte', 'empty', 'not_empty'];

const text = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const same = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();

function holds(c: Condition, facts: Record<string, unknown>, trigger?: Trigger): boolean {
  const actual = text(facts[c.field]);
  const values = Array.isArray(c.value) ? c.value : c.value === undefined ? [] : [c.value];
  switch (c.op) {
    case 'empty':
      return actual === null;
    case 'not_empty':
      return actual !== null;
    case 'eq':
      return values.length > 0 && same(actual, values[0]);
    case 'ne':
      return values.length > 0 && !same(actual, values[0]);
    case 'in':
      return values.some((v) => same(actual, v));
    case 'not_in':
      return !values.some((v) => same(actual, v));
    case 'gte':
    case 'lte': {
      const order = trigger?.fields.find((f) => f.key === c.field)?.options?.map((x) => x.value) ?? [];
      const a = actual === null ? -1 : order.indexOf(actual);
      const b = order.indexOf(values[0] ?? '');
      if (a < 0 || b < 0) return false;
      return c.op === 'gte' ? a >= b : a <= b;
    }
    default:
      return false;
  }
}

export function evaluateConditions(conditions: Conditions | null | undefined, facts: Record<string, unknown>, trigger?: Trigger): boolean {
  const all = conditions?.all ?? [];
  const any = conditions?.any ?? [];
  if (!all.every((c) => holds(c, facts, trigger))) return false;
  return any.length === 0 || any.some((c) => holds(c, facts, trigger));
}

/** What is wrong with conditions for a trigger (empty = fine): unknown fields, operators that do not fit the field, values that are not offered. */
export function conditionProblems(conditions: Conditions, trigger: Trigger): string[] {
  const problems: string[] = [];
  const list = [...(conditions.all ?? []), ...(conditions.any ?? [])];
  if (list.length > 20) problems.push('A rule tests at most twenty things');
  for (const c of list) {
    const field = trigger.fields.find((f) => f.key === c.field);
    if (!field) {
      problems.push(`"${c.field}" is not something "${trigger.label}" can be tested on`);
      continue;
    }
    if (!OPS.includes(c.op)) {
      problems.push(`${field.label}: unknown test`);
      continue;
    }
    if ((c.op === 'gte' || c.op === 'lte') && field.type !== 'ordered') problems.push(`${field.label} has no order, so "at least" / "at most" do not apply`);
    const needsValue = !['empty', 'not_empty'].includes(c.op);
    const values = Array.isArray(c.value) ? c.value : c.value === undefined || c.value === '' ? [] : [c.value];
    if (needsValue && values.length === 0) problems.push(`${field.label}: say what to compare with`);
    if (field.options && needsValue) {
      for (const v of values) if (!field.options.some((o) => o.value === v)) problems.push(`${field.label}: "${v}" is not one of the choices`);
    }
  }
  return problems;
}
