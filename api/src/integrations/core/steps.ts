/**
 * Step-by-step transforms (docs/import-templates-plan.md §3): an ordered list of steps from a closed set, applied to a field's text after it is taken
 * from its column. No code, no expressions: each step has a kind and its own settings. Every step works on text and gives text; a number step gives
 * the number written plainly ("1234.5") and a date step gives yyyy-mm-dd, so the field's type check afterwards reads them without any settings.
 * A step that cannot do its work gives an error, which rejects the row with the field's name.
 */
import { DATE_FORMATS, DateFormat, parseDate } from './mapping-dates';

export const STEP_KINDS = [
  'trim', 'upper', 'lower', 'title', 'collapse_spaces', 'replace', 'remove', 'left', 'right', 'split', 'prefix', 'suffix',
  'number', 'round', 'multiply', 'divide', 'convert',
  'date', 'add_days',
  'map', 'if', 'coalesce', 'join', 'default',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const UNITS = {
  length: { mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048 },
  mass: { g: 0.001, kg: 1, lb: 0.45359237, oz: 0.028349523125 },
  temperature: { c: 1, f: 1 },
} as const;
export type Unit = 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'g' | 'kg' | 'lb' | 'oz' | 'c' | 'f';
export const ALL_UNITS: Unit[] = ['mm', 'cm', 'm', 'in', 'ft', 'g', 'kg', 'lb', 'oz', 'c', 'f'];
const unitGroup = (u: string) => (Object.entries(UNITS) as [string, Record<string, number>][]).find(([, units]) => u in units)?.[0];

export const IF_TESTS = ['equals', 'not_equals', 'contains', 'starts_with', 'empty', 'not_empty', 'one_of'] as const;

export interface Step {
  kind: StepKind;
  /** replace */
  find?: string;
  with?: string;
  ignoreCase?: boolean;
  /** remove */
  characters?: string;
  /** left / right */
  count?: number;
  /** split / join */
  separator?: string;
  /** split: 1 = the first part, -1 = the last */
  part?: number;
  /** prefix / suffix / default */
  text?: string;
  /** number */
  decimal?: '.' | ',';
  thousands?: '' | ',' | '.' | ' ' | "'";
  /** round */
  places?: number;
  /** multiply / divide */
  by?: number;
  /** convert */
  from?: string;
  to?: string;
  /** date: a fixed format or a pattern such as dd.MM.yyyy */
  format?: string;
  /** add_days */
  days?: number;
  /** map */
  values?: Record<string, string>;
  unmatched?: 'keep' | 'empty' | 'error';
  /** if */
  test?: (typeof IF_TESTS)[number];
  value?: string;
  list?: string[];
  then?: string;
  else?: string | null;
  /** coalesce: the columns tried after the current value; join: the parts */
  columns?: string[];
  parts?: ({ column: string } | { text: string } | { current: true })[];
}

export type StepResult = { value: string } | { error: string };

const words = (k: string) => k.replace(/_/g, ' ');
const plain = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(15))));

/** Read a number written with the given decimal mark and thousands separator; null when it is not one. */
export function readNumber(raw: string, decimal: '.' | ',' = '.', thousands = ''): number | null {
  let s = raw.trim().replace(/\s/g, thousands === ' ' ? '' : ' ').trim();
  if (thousands) s = s.split(thousands).join('');
  if (decimal === ',') s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** A date pattern such as dd.MM.yyyy, d/M/yy or yyyyMMdd: the tokens yyyy, yy, MM, M, dd, d; everything else must match as written. */
export function parsePattern(raw: string, pattern: string): string | null {
  const tokens = pattern.match(/yyyy|yy|MM|M|dd|d|[^yMd]+/g);
  if (!tokens) return null;
  let re = '^';
  const order: string[] = [];
  for (const t of tokens) {
    if (t === 'yyyy') { re += '(\\d{4})'; order.push('y'); }
    else if (t === 'yy') { re += '(\\d{2})'; order.push('yy'); }
    else if (t === 'MM') { re += '(\\d{2})'; order.push('m'); }
    else if (t === 'M') { re += '(\\d{1,2})'; order.push('m'); }
    else if (t === 'dd') { re += '(\\d{2})'; order.push('d'); }
    else if (t === 'd') { re += '(\\d{1,2})'; order.push('d'); }
    else re += t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const m = raw.trim().match(new RegExp(re + '$'));
  if (!m) return null;
  let y = 0, mo = 0, d = 0;
  order.forEach((o, i) => {
    const n = Number(m[i + 1]);
    if (o === 'y') y = n;
    else if (o === 'yy') y = 2000 + n;
    else if (o === 'm') mo = n;
    else d = n;
  });
  if (!y || !mo || !d) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

const matches = (a: string, b: string, ignoreCase: boolean) => (ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Apply one step to the current text. `get(column)` reads another column of the same source record. */
export function applyStep(step: Step, value: string, get: (column: string) => string): StepResult {
  const ic = step.ignoreCase !== false;
  switch (step.kind) {
    case 'trim':
      return { value: value.trim() };
    case 'upper':
      return { value: value.toUpperCase() };
    case 'lower':
      return { value: value.toLowerCase() };
    case 'title':
      return { value: value.toLowerCase().replace(/(^|[\s\-/'(])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase()) };
    case 'collapse_spaces':
      return { value: value.replace(/\s+/g, ' ').trim() };
    case 'replace': {
      if (!step.find) return { value };
      const re = new RegExp(step.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ic ? 'gi' : 'g');
      return { value: value.replace(re, () => step.with ?? '') };
    }
    case 'remove': {
      const chars = new Set([...(step.characters ?? '')]);
      return { value: [...value].filter((c) => !chars.has(c)).join('') };
    }
    case 'left':
      return { value: [...value].slice(0, step.count ?? 0).join('') };
    case 'right': {
      const cs = [...value];
      return { value: cs.slice(Math.max(0, cs.length - (step.count ?? 0))).join('') };
    }
    case 'split': {
      if (value === '') return { value };
      const parts = value.split(step.separator ?? ',');
      const n = step.part ?? 1;
      const p = n > 0 ? parts[n - 1] : parts[parts.length + n];
      return { value: (p ?? '').trim() };
    }
    case 'prefix':
      return { value: value === '' ? value : (step.text ?? '') + value };
    case 'suffix':
      return { value: value === '' ? value : value + (step.text ?? '') };
    case 'number': {
      if (value.trim() === '') return { value: '' };
      const n = readNumber(value, step.decimal ?? '.', step.thousands ?? '');
      return n === null ? { error: `"${value}" is not a number` } : { value: plain(n) };
    }
    case 'round': {
      if (value.trim() === '') return { value: '' };
      const n = readNumber(value);
      if (n === null) return { error: `"${value}" is not a number to round` };
      const f = 10 ** (step.places ?? 0);
      return { value: plain(Math.round((n + Number.EPSILON * Math.sign(n)) * f) / f) };
    }
    case 'multiply':
    case 'divide': {
      if (value.trim() === '') return { value: '' };
      const n = readNumber(value);
      if (n === null) return { error: `"${value}" is not a number to ${step.kind}` };
      const by = step.by ?? 1;
      if (step.kind === 'divide' && by === 0) return { error: 'Cannot divide by 0' };
      return { value: plain(step.kind === 'multiply' ? n * by : n / by) };
    }
    case 'convert': {
      if (value.trim() === '') return { value: '' };
      const n = readNumber(value);
      if (n === null) return { error: `"${value}" is not a number to convert` };
      const from = step.from as string, to = step.to as string;
      const group = unitGroup(from);
      if (!group || group !== unitGroup(to)) return { error: `Cannot convert ${from} to ${to}` };
      if (group === 'temperature') return { value: plain(from === to ? n : from === 'c' ? n * 9 / 5 + 32 : (n - 32) * 5 / 9) };
      const units = UNITS[group as 'length' | 'mass'] as Record<string, number>;
      return { value: plain((n * units[from]) / units[to]) };
    }
    case 'date': {
      if (value.trim() === '') return { value: '' };
      const format = step.format ?? 'iso';
      const d = (DATE_FORMATS as readonly string[]).includes(format) ? parseDate(value, format as DateFormat) : parsePattern(value, format);
      return d ? { value: d } : { error: `"${value}" is not a date written as ${format === 'dmy' ? 'day/month/year' : format === 'mdy' ? 'month/day/year' : format === 'excel' ? 'an Excel date number' : format === 'iso' ? 'year-month-day' : format}` };
    }
    case 'add_days': {
      if (value.trim() === '') return { value: '' };
      const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
      if (!d || Number.isNaN(d.getTime())) return { error: `"${value}" is not a date (read it with a date step first)` };
      d.setUTCDate(d.getUTCDate() + (step.days ?? 0));
      return { value: d.toISOString().slice(0, 10) };
    }
    case 'map': {
      if (value === '') return { value };
      const hit = Object.entries(step.values ?? {}).find(([from]) => matches(from.trim(), value.trim(), ic));
      if (hit) return { value: hit[1] };
      if (step.unmatched === 'empty') return { value: '' };
      if (step.unmatched === 'error') return { error: `"${value}" is not in the translation list` };
      return { value };
    }
    case 'if': {
      const v = value.trim();
      const t = (step.value ?? '').trim();
      const test = step.test ?? 'equals';
      const yes =
        test === 'empty' ? v === ''
        : test === 'not_empty' ? v !== ''
        : test === 'equals' ? matches(v, t, ic)
        : test === 'not_equals' ? !matches(v, t, ic)
        : test === 'contains' ? (ic ? v.toLowerCase().includes(t.toLowerCase()) : v.includes(t))
        : test === 'starts_with' ? (ic ? v.toLowerCase().startsWith(t.toLowerCase()) : v.startsWith(t))
        : (step.list ?? []).some((x) => matches(v, x.trim(), ic));
      if (yes) return { value: step.then ?? '' };
      return { value: step.else === undefined || step.else === null ? value : step.else };
    }
    case 'coalesce': {
      if (value.trim() !== '') return { value };
      for (const c of step.columns ?? []) {
        const v = get(c);
        if (v !== '') return { value: v };
      }
      return { value: '' };
    }
    case 'join': {
      const pieces = (step.parts ?? []).map((p) => ('column' in p ? get(p.column) : 'text' in p ? p.text : value)).filter((p) => p !== '');
      return { value: pieces.join(step.separator ?? ' ') };
    }
    case 'default':
      return { value: value.trim() === '' ? (step.text ?? '') : value };
    default:
      return { error: `Unknown step "${words(String((step as Step).kind))}"` };
  }
}

/** Apply the steps in order; stops at the first error. `trail` (when given) collects the value after each step for the preview. */
export function applySteps(steps: Step[] | undefined, value: string, get: (column: string) => string, trail?: string[]): StepResult {
  let v = value;
  for (const s of steps ?? []) {
    const out = applyStep(s, v, get);
    if ('error' in out) return out;
    v = out.value;
    trail?.push(v);
  }
  return { value: v };
}

/** Problems with a list of steps before it is saved (settings missing or out of range, columns the file does not have). */
export function stepProblems(steps: Step[] | undefined, label: string, columns?: Set<string> | null): string[] {
  const out: string[] = [];
  (steps ?? []).forEach((s, i) => {
    const at = `${label}, step ${i + 1} (${words(s.kind)})`;
    if (!(STEP_KINDS as readonly string[]).includes(s.kind)) return out.push(`${label}, step ${i + 1}: unknown step "${String(s.kind)}"`);
    if (s.kind === 'replace' && !s.find) out.push(`${at}: say what to find`);
    if (s.kind === 'remove' && !s.characters) out.push(`${at}: list the characters to remove`);
    if ((s.kind === 'left' || s.kind === 'right') && !(Number.isInteger(s.count) && (s.count as number) >= 1 && (s.count as number) <= 1000)) out.push(`${at}: give a number of characters from 1 to 1000`);
    if (s.kind === 'split' && (!s.separator || !Number.isInteger(s.part) || s.part === 0)) out.push(`${at}: give the separator and which part to keep (1 = first, -1 = last)`);
    if ((s.kind === 'prefix' || s.kind === 'suffix') && !s.text) out.push(`${at}: give the text to add`);
    if (s.kind === 'round' && !(Number.isInteger(s.places) && (s.places as number) >= 0 && (s.places as number) <= 10)) out.push(`${at}: give 0 to 10 decimal places`);
    if ((s.kind === 'multiply' || s.kind === 'divide') && !(typeof s.by === 'number' && Number.isFinite(s.by))) out.push(`${at}: give the number to ${s.kind} by`);
    if (s.kind === 'divide' && s.by === 0) out.push(`${at}: cannot divide by 0`);
    if (s.kind === 'convert' && (!s.from || !s.to || !unitGroup(s.from) || unitGroup(s.from) !== unitGroup(s.to))) out.push(`${at}: choose two units of the same kind (length, mass or temperature)`);
    if (s.kind === 'date' && s.format && !(DATE_FORMATS as readonly string[]).includes(s.format) && !/^(yyyy|yy|MM|M|dd|d|[^yMd])+$/.test(s.format)) out.push(`${at}: the date pattern can use yyyy, yy, MM, M, dd and d`);
    if (s.kind === 'date' && s.format && !(DATE_FORMATS as readonly string[]).includes(s.format) && !(/yy/.test(s.format) && /M/.test(s.format) && /d/.test(s.format))) out.push(`${at}: the date pattern needs a year, a month and a day`);
    if (s.kind === 'add_days' && !(Number.isInteger(s.days) && Math.abs(s.days as number) <= 36500)) out.push(`${at}: give a whole number of days`);
    if (s.kind === 'map' && (!s.values || Object.keys(s.values).length === 0)) out.push(`${at}: list the values to translate`);
    if (s.kind === 'if' && !s.test) out.push(`${at}: choose the test`);
    if (s.kind === 'if' && ['equals', 'not_equals', 'contains', 'starts_with'].includes(s.test ?? '') && (s.value ?? '') === '') out.push(`${at}: give the value to test against`);
    if (s.kind === 'if' && s.test === 'one_of' && !(s.list ?? []).length) out.push(`${at}: list the values`);
    if (s.kind === 'coalesce' && !(s.columns ?? []).length) out.push(`${at}: choose the columns to try`);
    if (s.kind === 'join' && (s.parts ?? []).length < 2) out.push(`${at}: join at least two parts`);
    const cols = s.kind === 'coalesce' ? (s.columns ?? []) : s.kind === 'join' ? (s.parts ?? []).flatMap((p) => ('column' in p ? [p.column] : [])) : [];
    if (columns) for (const c of cols) if (!columns.has(c)) out.push(`${at}: the column "${c}" is not in the file`);
  });
  return out;
}

/** Whether the steps already turn the text into a plain number / an ISO date (so the field's own decimal mark / date format must not be applied again). */
export const stepsGive = (steps: Step[] | undefined, kind: 'number' | 'date') =>
  (steps ?? []).some((s) => (kind === 'number' ? ['number', 'round', 'multiply', 'divide', 'convert'] : ['date', 'add_days']).includes(s.kind));

/** The source columns the steps read (coalesce and join). */
export function stepColumns(steps: Step[] | undefined): string[] {
  const out: string[] = [];
  for (const s of steps ?? []) {
    if (s.kind === 'coalesce') out.push(...(s.columns ?? []));
    if (s.kind === 'join') for (const p of s.parts ?? []) if ('column' in p && p.column) out.push(p.column);
  }
  return out;
}
