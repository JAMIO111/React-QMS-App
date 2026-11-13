import type { FieldType, Trigger } from './catalogue';

/**
 * A rule's conditions (WF1): `{ all: [...] }` (every one must hold) or `{ any: [...] }` (at least one), each `{ field, op, value? }`. No expressions, no code:
 * a closed set of operators over the facts the trigger offers. Empty conditions always match. Pure: the worker evaluates them, the API checks them when saved.
 */
export type Op = 'eq' | 'ne' | 'in' | 'not_in' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'not_contains' | 'empty' | 'not_empty';
export interface Condition {
  field: string;
  op: Op;
  value?: string | string[];
}
export interface Conditions {
  all?: Condition[];
  any?: Condition[];
}

export const OPS: Op[] = ['eq', 'ne', 'in', 'not_in', 'gt', 'lt', 'gte', 'lte', 'contains', 'not_contains', 'empty', 'not_empty'];

/** Which tests fit which kind of field (WF4: numbers compare as numbers, words can be searched). */
export const OPS_FOR: Record<FieldType, Op[]> = {
  enum: ['eq', 'ne', 'in', 'not_in', 'empty', 'not_empty'],
  ordered: ['eq', 'ne', 'in', 'not_in', 'gte', 'lte', 'empty', 'not_empty'],
  ref: ['eq', 'ne', 'in', 'not_in', 'empty', 'not_empty'],
  text: ['eq', 'ne', 'in', 'not_in', 'contains', 'not_contains', 'empty', 'not_empty'],
  number: ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'empty', 'not_empty'],
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
};

const text = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const same = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();

export function conditionHolds(c: Condition, facts: Record<string, unknown>, trigger?: Trigger): boolean {
  const actual = text(facts[c.field]);
  const values = Array.isArray(c.value) ? c.value : c.value === undefined ? [] : [c.value];
  const field = trigger?.fields.find((f) => f.key === c.field);
  // A number field compares as numbers; an empty or unreadable value never passes a comparison.
  if (field?.type === 'number' && ['eq', 'ne', 'gt', 'lt', 'gte', 'lte'].includes(c.op)) {
    const a = num(facts[c.field]);
    const b = num(values[0]);
    if (a === null || b === null) return c.op === 'ne' && a === null && b !== null;
    switch (c.op) {
      case 'eq': return a === b;
      case 'ne': return a !== b;
      case 'gt': return a > b;
      case 'lt': return a < b;
      case 'gte': return a >= b;
      default: return a <= b;
    }
  }
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
    case 'contains':
      return values.length > 0 && actual !== null && actual.toLowerCase().includes(values[0].toLowerCase());
    case 'not_contains':
      return values.length > 0 && (actual === null || !actual.toLowerCase().includes(values[0].toLowerCase()));
    case 'gt':
    case 'lt':
      return false;
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
  if (!all.every((c) => conditionHolds(c, facts, trigger))) return false;
  return any.length === 0 || any.some((c) => conditionHolds(c, facts, trigger));
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
    if (!OPS_FOR[field.type].includes(c.op)) {
      problems.push(
        c.op === 'gte' || c.op === 'lte' || c.op === 'gt' || c.op === 'lt'
          ? `${field.label} has no order, so "at least" / "at most" do not apply`
          : c.op === 'contains' || c.op === 'not_contains'
            ? `${field.label}: "contains" applies to words only`
            : `${field.label}: that test does not apply`,
      );
      continue;
    }
    const needsValue = !['empty', 'not_empty'].includes(c.op);
    const values = Array.isArray(c.value) ? c.value : c.value === undefined || c.value === '' ? [] : [c.value];
    if (needsValue && values.length === 0) problems.push(`${field.label}: say what to compare with`);
    if (field.type === 'number' && needsValue) for (const v of values) if (num(v) === null) problems.push(`${field.label}: "${v}" is not a number`);
    if (field.options && needsValue) {
      for (const v of values) if (!field.options.some((o) => o.value === v)) problems.push(`${field.label}: "${v}" is not one of the choices`);
    }
  }
  return problems;
}
