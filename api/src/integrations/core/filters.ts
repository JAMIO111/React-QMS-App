/**
 * Record filters (docs/import-filters-plan.md): which source records an import reads at all. A filter runs on the raw source columns, before any mapping,
 * so a record it removes is never mapped, checked or written. It is saved on the template version (so a scheduled import uses exactly what was previewed)
 * and is plain data: rules of "column, test, value", or one formula in the same language as the mapping formulas. Nothing here reads anything but the
 * record's own columns.
 */
import { DateFormat, DATE_FORMATS, parseDate } from './mapping-dates';
import { checkFormula, closest, runFormula } from './formula';

export const FILTER_TESTS = ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'in', 'not_in', 'is_empty', 'not_empty', 'gt', 'gte', 'lt', 'lte', 'between'] as const;
export type FilterTest = (typeof FILTER_TESTS)[number];
export const FILTER_MODES = ['keep', 'leave_out'] as const;
export const FILTER_MATCHES = ['all', 'any'] as const;
export const FILTER_AS = ['text', 'number', 'date'] as const;

export const MAX_FILTER_RULES = 20;
export const MAX_FILTER_VALUES = 100;
export const MAX_FILTER_TEXT = 500;
export const MAX_FILTER_FORMULA = 2000;

export interface FilterRule {
  column: string;
  test: FilterTest;
  /** The value to compare with (not used by is_empty / not_empty / in / not_in). */
  value?: string;
  /** The list for in / not_in. */
  values?: string[];
  /** The upper end for between (inclusive). */
  valueTo?: string;
  /** How to read the column and the value: text (default, case ignored), number, or date. */
  as?: (typeof FILTER_AS)[number];
  /** For as = number: the decimal mark in the source. */
  decimal?: '.' | ',';
  /** For as = date: how the source writes dates (the mapping's date formats). */
  dateFormat?: DateFormat;
}

export interface RecordFilter {
  /** keep = read only records that match; leave_out = read every record except those that match. */
  mode: (typeof FILTER_MODES)[number];
  /** How several rules combine: all of them, or any of them. */
  match: (typeof FILTER_MATCHES)[number];
  rules: FilterRule[];
  /** A formula instead of rules (true = the record matches). When given there are no rules. */
  formula?: string;
}

const NEEDS_NO_VALUE = new Set<FilterTest>(['is_empty', 'not_empty']);
const NEEDS_LIST = new Set<FilterTest>(['in', 'not_in']);
const COMPARES = new Set<FilterTest>(['gt', 'gte', 'lt', 'lte', 'between']);

const TEST_WORDS: Record<FilterTest, string> = {
  equals: 'is', not_equals: 'is not', contains: 'contains', not_contains: 'does not contain', starts_with: 'starts with', ends_with: 'ends with',
  in: 'is one of', not_in: 'is not one of', is_empty: 'is empty', not_empty: 'is not empty', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most', between: 'is between',
};

/** One cell of a source record, trimmed ('' when absent). Only the record's own columns are read, never inherited ones such as "constructor". */
function cell(record: Record<string, unknown>, column: string): string {
  return Object.prototype.hasOwnProperty.call(record, column) ? String(record[column] ?? '').trim() : '';
}

/** A rule in words, for the run page and the preview ("Status is "Cancelled""). */
export function describeRule(rule: FilterRule): string {
  const q = (s: string) => `"${s}"`;
  const col = rule.column;
  if (NEEDS_NO_VALUE.has(rule.test)) return `${col} ${TEST_WORDS[rule.test]}`;
  if (NEEDS_LIST.has(rule.test)) return `${col} ${TEST_WORDS[rule.test]} ${(rule.values ?? []).map(q).join(', ')}`;
  if (rule.test === 'between') return `${col} ${TEST_WORDS.between} ${rule.value ?? ''} and ${rule.valueTo ?? ''}`;
  return `${col} ${TEST_WORDS[rule.test]} ${COMPARES.has(rule.test) ? (rule.value ?? '') : q(rule.value ?? '')}`;
}

/** The filter in words ("Keep records where Status is "Active" and Type is one of "A", "B""). */
export function describeFilter(filter: RecordFilter): string {
  const lead = filter.mode === 'keep' ? 'Keep records where' : 'Leave out records where';
  if (filter.formula) return `${lead} the formula ${filter.formula} is true`;
  return `${lead} ${filter.rules.map(describeRule).join(filter.match === 'all' ? ' and ' : ' or ')}`;
}

type Num = number | null;
const asNumber = (raw: string, decimal?: '.' | ','): Num => {
  const s = raw.replace(/\s/g, '');
  const normal = decimal === ',' ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  return /^-?\d+(\.\d+)?$/.test(normal) ? Number(normal) : null;
};

/** Does one rule hold for one record? A value that cannot be read as the number or date the rule asks for never matches. */
export function ruleMatches(rule: FilterRule, record: Record<string, unknown>): boolean {
  const raw = cell(record, rule.column);
  switch (rule.test) {
    case 'is_empty': return raw === '';
    case 'not_empty': return raw !== '';
    default: break;
  }
  const as = rule.as ?? 'text';
  if (COMPARES.has(rule.test) || ((rule.test === 'equals' || rule.test === 'not_equals') && as !== 'text')) {
    let cmp: (target: string | undefined) => number | null;
    if (as === 'date') {
      const mine = parseDate(raw, rule.dateFormat ?? 'iso');
      cmp = (t) => {
        const theirs = t === undefined ? null : parseDate(t, rule.dateFormat ?? 'iso');
        return mine === null || theirs === null ? null : mine < theirs ? -1 : mine > theirs ? 1 : 0;
      };
    } else {
      const mine = asNumber(raw, rule.decimal);
      cmp = (t) => {
        const theirs = t === undefined ? null : asNumber(t, rule.decimal);
        return mine === null || theirs === null ? null : mine < theirs ? -1 : mine > theirs ? 1 : 0;
      };
    }
    const c = cmp(rule.value);
    switch (rule.test) {
      case 'equals': return c === 0;
      case 'not_equals': return c !== 0;
      case 'gt': return c !== null && c > 0;
      case 'gte': return c !== null && c >= 0;
      case 'lt': return c !== null && c < 0;
      case 'lte': return c !== null && c <= 0;
      case 'between': {
        const hi = cmp(rule.valueTo);
        return c !== null && hi !== null && c >= 0 && hi <= 0;
      }
      default: return false;
    }
  }
  const mine = raw.toLowerCase();
  const one = (rule.value ?? '').trim().toLowerCase();
  switch (rule.test) {
    case 'equals': return mine === one;
    case 'not_equals': return mine !== one;
    case 'contains': return one !== '' && mine.includes(one);
    case 'not_contains': return one === '' || !mine.includes(one);
    case 'starts_with': return one !== '' && mine.startsWith(one);
    case 'ends_with': return one !== '' && mine.endsWith(one);
    case 'in': return (rule.values ?? []).some((v) => v.trim().toLowerCase() === mine);
    case 'not_in': return !(rule.values ?? []).some((v) => v.trim().toLowerCase() === mine);
    default: return false;
  }
}

export interface FilterOutcome {
  /** Read this record (true) or leave it out (false). */
  keep: boolean;
  /** Why it was left out, in words (only when keep is false). */
  reason?: string;
  /** The filter could not be worked out for this record (a formula that fails): it is not read, and this says why. */
  error?: string;
  /** Per rule, whether it held for this record (for the preview's counts). */
  matched: boolean[];
}

/** Apply one filter to one source record. */
export function applyFilter(filter: RecordFilter, record: Record<string, unknown>): FilterOutcome {
  let matches: boolean;
  let matched: boolean[] = [];
  if (filter.formula) {
    const r = runFormula(filter.formula, (c) => cell(record, c));
    if ('error' in r) return { keep: false, error: `Filter formula: ${r.error}`, matched };
    matches = ['true', '1'].includes(r.value.trim().toLowerCase());
  } else {
    matched = filter.rules.map((rule) => ruleMatches(rule, record));
    matches = filter.rules.length === 0 ? true : filter.match === 'all' ? matched.every(Boolean) : matched.some(Boolean);
  }
  const keep = filter.mode === 'keep' ? matches : !matches;
  if (keep) return { keep: true, matched };
  if (filter.mode === 'leave_out') {
    const which = filter.formula ? `the formula ${filter.formula} is true` : filter.rules.filter((_, i) => matched[i]).map(describeRule).join(filter.match === 'all' ? ' and ' : ' or ');
    return { keep: false, reason: `Filtered out: ${which}`, matched };
  }
  const all = filter.formula ? `the formula ${filter.formula} is true` : filter.rules.map(describeRule).join(filter.match === 'all' ? ' and ' : ' or ');
  return { keep: false, reason: `Filtered out: does not meet ${all}`, matched };
}

/** A filter with nothing to do (no rules and no formula) is no filter: callers drop it. */
export function isActive(filter: RecordFilter | null | undefined): filter is RecordFilter {
  return !!filter && (!!(filter.formula && filter.formula.trim()) || filter.rules.length > 0);
}

/** Tidy a filter as it was typed: texts trimmed, empty rules and an empty formula dropped. Null when nothing is left. */
export function normaliseFilter(filter: RecordFilter | null | undefined): RecordFilter | null {
  if (!filter) return null;
  const formula = filter.formula?.trim();
  const rules = formula
    ? []
    : filter.rules
        .map((r): FilterRule => ({
          ...r,
          column: r.column.trim(),
          ...(r.value !== undefined ? { value: r.value.trim() } : {}),
          ...(r.valueTo !== undefined ? { valueTo: r.valueTo.trim() } : {}),
          ...(r.values !== undefined ? { values: r.values.map((v) => v.trim()).filter((v) => v !== '') } : {}),
        }))
        .filter((r) => r.column !== '');
  const out: RecordFilter = { mode: filter.mode, match: filter.match, rules, ...(formula ? { formula } : {}) };
  return isActive(out) ? out : null;
}

/** What is wrong with a filter, in words; empty when it can be saved. `headers` (the source's columns, when known) lets a rule naming a column that is not there be caught. */
export function filterProblems(filter: RecordFilter, headers?: string[]): string[] {
  const problems: string[] = [];
  if (!FILTER_MODES.includes(filter.mode)) problems.push('Choose whether to keep or leave out the records that match');
  if (!FILTER_MATCHES.includes(filter.match)) problems.push('Choose whether all of the rules or any of them must hold');
  if (filter.formula) {
    if (filter.rules.length > 0) problems.push('A filter is either rules or a formula, not both');
    if (filter.formula.length > MAX_FILTER_FORMULA) problems.push(`A filter formula is limited to ${MAX_FILTER_FORMULA} characters`);
    else {
      const check = checkFormula(filter.formula, headers ?? null);
      if (!check.ok && check.error) problems.push(`Filter formula: ${check.error.message}`);
    }
    return problems;
  }
  if (filter.rules.length > MAX_FILTER_RULES) problems.push(`A filter is limited to ${MAX_FILTER_RULES} rules`);
  const cols = headers ? new Set(headers) : null;
  filter.rules.slice(0, MAX_FILTER_RULES).forEach((rule, i) => {
    const n = `Rule ${i + 1}`;
    if (!rule.column.trim()) return void problems.push(`${n}: choose a column`);
    if (cols && !cols.has(rule.column)) {
      const hint = closest(rule.column, cols);
      problems.push(`${n}: the column ${rule.column} is not in the source${hint ? ` — did you mean ${hint}?` : ''}`);
    }
    if (!FILTER_TESTS.includes(rule.test)) return void problems.push(`${n}: choose a test`);
    if (NEEDS_NO_VALUE.has(rule.test)) return;
    const as = rule.as ?? 'text';
    if (as === 'date' && rule.dateFormat !== undefined && !DATE_FORMATS.includes(rule.dateFormat)) problems.push(`${n}: choose how the dates are written`);
    if (NEEDS_LIST.has(rule.test)) {
      const list = rule.values ?? [];
      if (list.length === 0) problems.push(`${n}: give at least one value`);
      if (list.length > MAX_FILTER_VALUES) problems.push(`${n}: a list is limited to ${MAX_FILTER_VALUES} values`);
      if (list.some((v) => v.length > MAX_FILTER_TEXT)) problems.push(`${n}: a value is longer than ${MAX_FILTER_TEXT} characters`);
      return;
    }
    const one = (rule.value ?? '').trim();
    if (one === '') return void problems.push(`${n}: give a value`);
    if (one.length > MAX_FILTER_TEXT) problems.push(`${n}: the value is longer than ${MAX_FILTER_TEXT} characters`);
    if (COMPARES.has(rule.test) && as === 'text') problems.push(`${n}: "${TEST_WORDS[rule.test]}" needs the column read as a number or a date`);
    const readable = (v: string) => (as === 'date' ? parseDate(v, rule.dateFormat ?? 'iso') !== null : as === 'number' ? asNumber(v, rule.decimal) !== null : true);
    if (as !== 'text' && !readable(one)) problems.push(`${n}: "${one}" is not a ${as}`);
    if (rule.test === 'between') {
      const to = (rule.valueTo ?? '').trim();
      if (to === '') problems.push(`${n}: give the upper end`);
      else if (as !== 'text' && !readable(to)) problems.push(`${n}: "${to}" is not a ${as}`);
    }
  });
  return problems;
}
