/**
 * Reading an action priority grid from a CSV the organisation holds (docs/fmea-plan.md FM2). The grid is the organisation's own data: the product ships none.
 *
 * Accepted layouts (headings in any case, spaces and punctuation ignored):
 *  - one column each for S, O and D (also `severity`, `occurrence`, `detection`) holding a level or a range (`7`, `1-3`, `9 to 10`), and `priority` / `AP` / `action priority`;
 *  - or a from and a to column per factor (`S from`, `S to`, `severity min`, `severity max` ...).
 * A priority is H / M / L or high / medium / low. Blank lines are skipped. Nothing here checks that the grid covers every combination: the database does that
 * (`app.fmea_model_problem`), so this file only turns text into ranges and says which line it could not read.
 */
export interface ApRule {
  sFrom: number;
  sTo: number;
  oFrom: number;
  oTo: number;
  dFrom: number;
  dTo: number;
  priority: 'high' | 'medium' | 'low';
}
export interface ApImportError {
  /** 1-based line of the file; 0 for a problem with the file as a whole. */
  line: number;
  message: string;
}
export interface ApImportResult {
  rules: ApRule[];
  errors: ApImportError[];
}

const MAX_RULES = 300;
const MAX_CHARS = 200_000;

/** One line of delimited text into cells, honouring "quotes" (a doubled quote is a quote). */
export function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
    } else cell += ch;
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

/** The delimiter used by the first non-blank line: the one found most often among comma, semicolon and tab. */
export function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const [best] = [',', ';', '\t'].map((d) => [d, splitLine(first, d).length - 1] as const).sort((a, b) => b[1] - a[1]);
  return best[1] > 0 ? best[0] : ',';
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
const FACTOR: Record<string, 's' | 'o' | 'd'> = { s: 's', severity: 's', o: 'o', occurrence: 'o', d: 'd', detection: 'd' };

/** Which column holds what: `{ s: {range: i} | {from: i, to: j}, ..., priority: i }`, or the reason it cannot be worked out. */
function columnsOf(headers: string[]): { cols: Record<'s' | 'o' | 'd', { range?: number; from?: number; to?: number }>; priority: number } | string {
  const cols: Record<'s' | 'o' | 'd', { range?: number; from?: number; to?: number }> = { s: {}, o: {}, d: {} };
  let priority = -1;
  headers.forEach((raw, i) => {
    const h = norm(raw);
    if (h === 'priority' || h === 'ap' || h === 'actionpriority') {
      priority = i;
      return;
    }
    const m = /^(severity|occurrence|detection|s|o|d)(from|min|to|max|low|high)?$/.exec(h);
    if (!m) return;
    const f = FACTOR[m[1]];
    if (!m[2]) cols[f].range = i;
    else if (['from', 'min', 'low'].includes(m[2])) cols[f].from = i;
    else cols[f].to = i;
  });
  if (priority < 0) return 'There is no priority column (call it Priority or AP)';
  for (const f of ['s', 'o', 'd'] as const) {
    const c = cols[f];
    const word = { s: 'severity (S)', o: 'occurrence (O)', d: 'detection (D)' }[f];
    if (c.range === undefined && (c.from === undefined || c.to === undefined)) return `There is no column for ${word}: give one column of levels or ranges, or a from and a to column`;
  }
  return { cols, priority };
}

/** A level or a range as written: `7`, `1-3`, `1 – 3`, `9 to 10`. */
export function parseRange(text: string): [number, number] | null {
  const t = text.trim().toLowerCase();
  const one = /^(\d{1,2})$/.exec(t);
  if (one) return [Number(one[1]), Number(one[1])];
  const two = /^(\d{1,2})\s*(?:-|–|—|to|\.\.)\s*(\d{1,2})$/.exec(t);
  return two ? [Number(two[1]), Number(two[2])] : null;
}

const PRIORITY: Record<string, ApRule['priority']> = { h: 'high', high: 'high', m: 'medium', medium: 'medium', med: 'medium', l: 'low', low: 'low' };

export function parseApCsv(text: string): ApImportResult {
  const errors: ApImportError[] = [];
  if (text.length > MAX_CHARS) return { rules: [], errors: [{ line: 0, message: 'The file is too large for an action priority grid' }] };
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const delimiter = detectDelimiter(text);
  const headerAt = lines.findIndex((l) => l.trim() !== '');
  if (headerAt < 0) return { rules: [], errors: [{ line: 0, message: 'The file is empty' }] };
  const found = columnsOf(splitLine(lines[headerAt], delimiter));
  if (typeof found === 'string') return { rules: [], errors: [{ line: headerAt + 1, message: found }] };
  const { cols, priority } = found;

  const rules: ApRule[] = [];
  for (let i = headerAt + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const cells = splitLine(lines[i], delimiter);
    const range = (f: 's' | 'o' | 'd'): [number, number] | string => {
      const c = cols[f];
      if (c.range !== undefined) return parseRange(cells[c.range] ?? '') ?? `${f.toUpperCase()} is a level or a range such as 1-3 (got "${cells[c.range] ?? ''}")`;
      const from = parseRange(cells[c.from!] ?? '');
      const to = parseRange(cells[c.to!] ?? '');
      return from && to ? [from[0], to[1]] : `${f.toUpperCase()} from and to are levels (got "${cells[c.from!] ?? ''}" and "${cells[c.to!] ?? ''}")`;
    };
    const s = range('s');
    const o = range('o');
    const d = range('d');
    const p = PRIORITY[(cells[priority] ?? '').trim().toLowerCase()];
    const problem = [s, o, d].find((x): x is string => typeof x === 'string') ?? (p ? null : `The priority is H, M or L (got "${cells[priority] ?? ''}")`);
    if (problem) {
      errors.push({ line: i + 1, message: problem });
      continue;
    }
    const [sr, or, dr] = [s, o, d] as [number, number][];
    const bad = [sr, or, dr].some(([a, b]) => a < 1 || b > 10 || a > b);
    if (bad) {
      errors.push({ line: i + 1, message: 'Levels run from 1 to 10, and a range from the lower to the higher' });
      continue;
    }
    rules.push({ sFrom: sr[0], sTo: sr[1], oFrom: or[0], oTo: or[1], dFrom: dr[0], dTo: dr[1], priority: p });
  }
  if (rules.length === 0 && errors.length === 0) errors.push({ line: 0, message: 'The file has a heading but no rows' });
  if (rules.length > MAX_RULES) errors.push({ line: 0, message: `A grid is up to ${MAX_RULES} ranges (this one has ${rules.length}): use ranges such as 1-3 rather than one row per level` });
  return { rules: rules.slice(0, MAX_RULES), errors };
}
