import { DATE_FORMATS, DateFormat, parseDate } from '../mapping-dates';
import { applyStep, parsePattern, readNumber } from '../steps';
import { BinaryOp, Node } from './parser';

/** A value inside a formula: empty, text, a number, true / false, or a date (kept as yyyy-mm-dd). */
export type Value = null | string | number | boolean | { date: string };

/** A formula that fails on a row: the row is rejected with this message. */
export class FormulaError extends Error {}

export const MAX_STEPS = 20000;
export const MAX_TEXT = 10000;

const plain = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(15))));
const isDate = (v: Value): v is { date: string } => typeof v === 'object' && v !== null;
const empty = (v: Value) => v === null || v === '';

/** The text a value becomes when it fills a field (or is joined with &). */
export function asText(v: Value): string {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return plain(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v.date;
}

function asNumber(v: Value, what: string): number | null {
  if (empty(v)) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isDate(v)) throw new FormulaError(`${what} needs a number, got the date ${v.date}`);
  const n = readNumber(v);
  if (n === null) throw new FormulaError(`${what} needs a number, got "${v}"`);
  return n;
}

function asBoolean(v: Value, what: string): boolean {
  if (empty(v)) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (isDate(v)) return true;
  const s = v.trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  throw new FormulaError(`${what} needs true or false, got "${v}"`);
}

function asDate(v: Value, what: string): string | null {
  if (empty(v)) return null;
  if (isDate(v)) return v.date;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) && parseDate(v.trim(), 'iso')) return v.trim();
  throw new FormulaError(`${what} needs a date, got "${asText(v)}" (read it with DATE first)`);
}

const wholeNumber = (v: Value, what: string): number => {
  const n = asNumber(v, what);
  if (n === null || !Number.isInteger(n)) throw new FormulaError(`${what} needs a whole number`);
  return n;
};

/** Compare two values: numbers as numbers, dates as dates, text ignoring case. */
function compare(a: Value, b: Value): number {
  if (empty(a) && empty(b)) return 0;
  const na = typeof a === 'number' ? a : typeof a === 'string' ? readNumber(a) : null;
  const nb = typeof b === 'number' ? b : typeof b === 'string' ? readNumber(b) : null;
  if ((typeof a === 'number' || typeof b === 'number') && na !== null && nb !== null) return na === nb ? 0 : na < nb ? -1 : 1;
  const ta = asText(a).toLowerCase();
  const tb = asText(b).toLowerCase();
  return ta === tb ? 0 : ta < tb ? -1 : 1;
}

type Lazy = () => Value;
interface FunctionDef {
  min: number;
  max: number;
  /** How to call it, for suggestions and messages. */
  usage: string;
  description: string;
  run: (args: Lazy[], name: string) => Value;
}

const text = (s: string): Value => {
  if (s.length > MAX_TEXT) throw new FormulaError(`The result is longer than ${MAX_TEXT} characters`);
  return s;
};
const stepText = (kind: Parameters<typeof applyStep>[0], v: string): string => {
  const r = applyStep(kind, v, () => '');
  if ('error' in r) throw new FormulaError(r.error);
  return r.value;
};
const all = (args: Lazy[]) => args.map((a) => a());

export const FUNCTIONS: Record<string, FunctionDef> = {
  // Text
  CONCAT: { min: 1, max: 50, usage: 'CONCAT(value, value, …)', description: 'Joins the values into one text', run: (a) => text(all(a).map(asText).join('')) },
  LEFT: { min: 1, max: 2, usage: 'LEFT(text, count)', description: 'The first characters (one when no count is given)', run: (a) => text([...asText(a[0]())].slice(0, a[1] ? Math.max(0, wholeNumber(a[1](), 'LEFT')) : 1).join('')) },
  RIGHT: {
    min: 1, max: 2, usage: 'RIGHT(text, count)', description: 'The last characters (one when no count is given)',
    run: (a) => { const cs = [...asText(a[0]())]; const n = a[1] ? Math.max(0, wholeNumber(a[1](), 'RIGHT')) : 1; return text(cs.slice(Math.max(0, cs.length - n)).join('')); },
  },
  MID: {
    min: 3, max: 3, usage: 'MID(text, start, count)', description: 'Characters from a position (the first character is 1)',
    run: (a) => { const start = wholeNumber(a[1](), 'MID'); if (start < 1) throw new FormulaError('MID starts at 1 or later'); return text([...asText(a[0]())].slice(start - 1, start - 1 + Math.max(0, wholeNumber(a[2](), 'MID'))).join('')); },
  },
  LEN: { min: 1, max: 1, usage: 'LEN(text)', description: 'How many characters', run: (a) => [...asText(a[0]())].length },
  UPPER: { min: 1, max: 1, usage: 'UPPER(text)', description: 'In capitals', run: (a) => asText(a[0]()).toUpperCase() },
  LOWER: { min: 1, max: 1, usage: 'LOWER(text)', description: 'In small letters', run: (a) => asText(a[0]()).toLowerCase() },
  PROPER: { min: 1, max: 1, usage: 'PROPER(text)', description: 'Each Word With A Capital', run: (a) => stepText({ kind: 'title' }, asText(a[0]())) },
  TRIM: { min: 1, max: 1, usage: 'TRIM(text)', description: 'Without spaces at the ends and with single spaces inside', run: (a) => asText(a[0]()).replace(/\s+/g, ' ').trim() },
  SUBSTITUTE: {
    min: 3, max: 3, usage: 'SUBSTITUTE(text, find, with)', description: 'Replaces every "find" (any case) with "with"',
    run: (a) => { const find = asText(a[1]()); if (!find) throw new FormulaError('SUBSTITUTE needs something to find'); return text(stepText({ kind: 'replace', find, with: asText(a[2]()) }, asText(a[0]()))); },
  },
  FIND: {
    min: 2, max: 2, usage: 'FIND(find, text)', description: 'Where "find" first appears in the text (1 = first character, 0 = not there; any case)',
    run: (a) => { const find = asText(a[0]()).toLowerCase(); const s = asText(a[1]()).toLowerCase(); return find ? s.indexOf(find) + 1 : 0; },
  },
  SPLIT: {
    min: 3, max: 3, usage: 'SPLIT(text, separator, part)', description: 'One part of the text (1 = first, -1 = last)',
    run: (a) => {
      const sep = asText(a[1]());
      if (!sep) throw new FormulaError('SPLIT needs a separator');
      const n = wholeNumber(a[2](), 'SPLIT');
      if (n === 0) throw new FormulaError('SPLIT counts parts from 1 (or from -1 for the last)');
      const parts = asText(a[0]()).split(sep);
      return (n > 0 ? parts[n - 1] : parts[parts.length + n])?.trim() ?? '';
    },
  },
  // Logic
  IF: { min: 2, max: 3, usage: 'IF(test, then, else)', description: 'One value when the test is true, the other when not (empty when no else)', run: (a) => (asBoolean(a[0](), 'IF') ? a[1]() : a[2] ? a[2]() : null) },
  IFS: {
    min: 2, max: 60, usage: 'IFS(test, value, test, value, …)', description: 'The value of the first true test (empty when none is true)',
    run: (a) => { if (a.length % 2) throw new FormulaError('IFS needs pairs of a test and a value'); for (let i = 0; i < a.length; i += 2) if (asBoolean(a[i](), 'IFS')) return a[i + 1](); return null; },
  },
  IFEMPTY: { min: 2, max: 2, usage: 'IFEMPTY(value, otherwise)', description: 'The value, or "otherwise" when it is empty', run: (a) => { const v = a[0](); return empty(v) ? a[1]() : v; } },
  COALESCE: { min: 1, max: 50, usage: 'COALESCE(value, value, …)', description: 'The first value that is not empty', run: (a) => { for (const x of a) { const v = x(); if (!empty(v)) return v; } return null; } },
  ISEMPTY: { min: 1, max: 1, usage: 'ISEMPTY(value)', description: 'True when the value is empty or only spaces', run: (a) => { const v = a[0](); return empty(v) || (typeof v === 'string' && !v.trim()); } },
  IN: { min: 2, max: 100, usage: 'IN(value, option, option, …)', description: 'True when the value is one of the options (any case)', run: (a) => { const v = a[0](); return a.slice(1).some((o) => compare(v, o()) === 0); } },
  SWITCH: {
    min: 3, max: 101, usage: 'SWITCH(value, case, result, case, result, …, otherwise)', description: 'The result for the first case equal to the value (any case), else "otherwise" (empty when not given)',
    run: (a) => {
      const v = a[0]();
      const rest = a.slice(1);
      const pairs = Math.floor(rest.length / 2);
      for (let i = 0; i < pairs; i += 1) if (compare(v, rest[i * 2]()) === 0) return rest[i * 2 + 1]();
      return rest.length % 2 ? rest[rest.length - 1]() : null;
    },
  },
  // Numbers
  NUMBER: {
    min: 1, max: 2, usage: 'NUMBER(text, decimal mark)', description: 'Reads a number; the decimal mark is "." (default) or "," (then "." separates thousands)',
    run: (a) => {
      const raw = asText(a[0]());
      if (!raw.trim()) return null;
      const mark = a[1] ? asText(a[1]()) : '.';
      if (mark !== '.' && mark !== ',') throw new FormulaError('NUMBER takes "." or "," as the decimal mark');
      const n = readNumber(raw, mark, mark === ',' ? '.' : ',');
      if (n === null) throw new FormulaError(`"${raw}" is not a number`);
      return n;
    },
  },
  ROUND: {
    min: 1, max: 2, usage: 'ROUND(number, places)', description: 'Rounded to that many decimal places (none when not given)',
    run: (a) => { const n = asNumber(a[0](), 'ROUND'); if (n === null) return null; const places = a[1] ? wholeNumber(a[1](), 'ROUND') : 0; if (places < 0 || places > 10) throw new FormulaError('ROUND takes 0 to 10 places'); return Number(stepText({ kind: 'round', places }, plain(n))); },
  },
  ABS: { min: 1, max: 1, usage: 'ABS(number)', description: 'Without its sign', run: (a) => { const n = asNumber(a[0](), 'ABS'); return n === null ? null : Math.abs(n); } },
  MIN: { min: 1, max: 50, usage: 'MIN(number, number, …)', description: 'The smallest (empty values are left out)', run: (a) => { const ns = all(a).map((v) => asNumber(v, 'MIN')).filter((n): n is number => n !== null); return ns.length ? Math.min(...ns) : null; } },
  MAX: { min: 1, max: 50, usage: 'MAX(number, number, …)', description: 'The largest (empty values are left out)', run: (a) => { const ns = all(a).map((v) => asNumber(v, 'MAX')).filter((n): n is number => n !== null); return ns.length ? Math.max(...ns) : null; } },
  CONVERT: {
    min: 3, max: 3, usage: 'CONVERT(number, "from", "to")', description: 'Between mm, cm, m, in, ft; g, kg, lb, oz; c and f',
    run: (a) => { const n = asNumber(a[0](), 'CONVERT'); if (n === null) return null; return Number(stepText({ kind: 'convert', from: asText(a[1]()).toLowerCase(), to: asText(a[2]()).toLowerCase() }, plain(n))); },
  },
  // Dates
  DATE: {
    min: 1, max: 2, usage: 'DATE(text, "format")', description: 'Reads a date: format iso (default), dmy, mdy, excel, or a pattern such as "dd.MM.yyyy"',
    run: (a) => {
      const raw = asText(a[0]()).trim();
      if (!raw) return null;
      const format = a[1] ? asText(a[1]()) : 'iso';
      const d = (DATE_FORMATS as readonly string[]).includes(format) ? parseDate(raw, format as DateFormat) : /[yMd]/.test(format) ? parsePattern(raw, format) : null;
      if (!d) throw new FormulaError(`"${raw}" is not a date written as ${format}`);
      return { date: d };
    },
  },
  TODAY: { min: 0, max: 0, usage: 'TODAY()', description: "Today's date (UTC)", run: () => ({ date: new Date().toISOString().slice(0, 10) }) },
  ADDDAYS: {
    min: 2, max: 2, usage: 'ADDDAYS(date, days)', description: 'The date that many days later (earlier when negative)',
    run: (a) => { const d = asDate(a[0](), 'ADDDAYS'); if (d === null) return null; const dt = new Date(`${d}T00:00:00Z`); dt.setUTCDate(dt.getUTCDate() + wholeNumber(a[1](), 'ADDDAYS')); return { date: dt.toISOString().slice(0, 10) }; },
  },
  YEAR: { min: 1, max: 1, usage: 'YEAR(date)', description: 'The year of a date', run: (a) => { const d = asDate(a[0](), 'YEAR'); return d === null ? null : Number(d.slice(0, 4)); } },
  MONTH: { min: 1, max: 1, usage: 'MONTH(date)', description: 'The month of a date (1–12)', run: (a) => { const d = asDate(a[0](), 'MONTH'); return d === null ? null : Number(d.slice(5, 7)); } },
  DAY: { min: 1, max: 1, usage: 'DAY(date)', description: 'The day of the month of a date', run: (a) => { const d = asDate(a[0](), 'DAY'); return d === null ? null : Number(d.slice(8, 10)); } },
};

export const arityText = (name: string) => {
  const f = FUNCTIONS[name];
  if (!f) return '';
  if (f.min === f.max) return f.min === 0 ? 'no values' : `${f.min} value${f.min === 1 ? '' : 's'}`;
  if (f.max - f.min === 1) return `${f.min} or ${f.max} values`;
  return `${f.min} to ${f.max} values`;
};

function binary(op: BinaryOp, l: Lazy, r: Lazy): Value {
  switch (op) {
    case 'AND': return asBoolean(l(), 'AND') && asBoolean(r(), 'AND');
    case 'OR': return asBoolean(l(), 'OR') || asBoolean(r(), 'OR');
    case '&': return text(asText(l()) + asText(r()));
    case '=': return compare(l(), r()) === 0;
    case '<>': return compare(l(), r()) !== 0;
    case '<': return compare(l(), r()) < 0;
    case '<=': return compare(l(), r()) <= 0;
    case '>': return compare(l(), r()) > 0;
    case '>=': return compare(l(), r()) >= 0;
    default: {
      const a = asNumber(l(), op);
      const b = asNumber(r(), op);
      if (a === null || b === null) return null;
      if (op === '/' && b === 0) throw new FormulaError('Cannot divide by 0');
      const n = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : a / b;
      if (!Number.isFinite(n)) throw new FormulaError('The number is too large');
      return n;
    }
  }
}

/** Evaluate a parsed formula against one row; `get(column)` reads a column (trimmed; '' when empty). */
export function evaluate(tree: Node, get: (column: string) => string): Value {
  let steps = 0;
  const ev = (n: Node): Value => {
    steps += 1;
    if (steps > MAX_STEPS) throw new FormulaError('The formula takes too long to work out');
    switch (n.type) {
      case 'number': return n.value;
      case 'text': return n.value;
      case 'boolean': return n.value;
      case 'column': { const v = get(n.name); return v === '' ? null : v; }
      case 'unary': {
        if (n.op === 'NOT') return !asBoolean(ev(n.arg), 'NOT');
        const v = asNumber(ev(n.arg), n.op);
        return v === null ? null : n.op === '-' ? -v : v;
      }
      case 'binary': return binary(n.op, () => ev(n.left), () => ev(n.right));
      case 'call': {
        const f = FUNCTIONS[n.name];
        if (!f) throw new FormulaError(`Unknown function ${n.name}`);
        return f.run(n.args.map((a) => () => ev(a)), n.name);
      }
    }
  };
  return ev(tree);
}
