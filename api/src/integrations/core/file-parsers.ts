import { strFromU8, unzipSync } from 'fflate';

/** A row read from a file: its row number in the file (1 = the first line) and its values by column heading, always as text. */
export interface ParsedRow {
  row: number;
  values: Record<string, string>;
}

export interface ParsedFile {
  headers: string[];
  rows: ParsedRow[];
  sheet: string | null;
}

export type Delimiter = ',' | ';' | 'tab' | '|';
export type Encoding = 'utf-8' | 'windows-1252' | 'utf-16le' | 'utf-16be';

export interface ParseOptions {
  /** `auto` (or nothing) works the separator out from the first lines. */
  delimiter?: Delimiter | 'auto';
  /** `auto` (or nothing) works the encoding out; a byte-order mark always wins. */
  encoding?: Encoding | 'auto';
  hasHeader?: boolean;
  maxRows?: number;
}

/** The file could not be read; the message is written for the person who uploaded it. */
export class FileParseError extends Error {}

const MAX_COLUMNS = 200;

/** Column headings: trimmed, blank ones named "Column N", repeats numbered "Name (2)", at most 200 characters. */
export function normaliseHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = (h ?? '').trim().slice(0, 190) || `Column ${i + 1}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

function toParsed(table: string[][], hasHeader: boolean, maxRows: number, sheet: string | null): ParsedFile {
  // Leave out wholly empty lines (spreadsheets often end with some).
  const lines = table.map((cells, i) => ({ cells, row: i + 1 })).filter((l) => l.cells.some((c) => c.trim() !== ''));
  if (lines.length === 0) throw new FileParseError('The file is empty');
  // Columns at the end with no heading and no values are left out (many exports end every line with a separator).
  let width = Math.max(...lines.map((l) => l.cells.length));
  while (width > 1 && lines.every((l) => (l.cells[width - 1] ?? '').trim() === '')) width -= 1;
  if (width > MAX_COLUMNS) throw new FileParseError(`The file has ${width} columns; the most is ${MAX_COLUMNS}`);
  const first = hasHeader ? lines[0] : null;
  const headers = normaliseHeaders(first ? Array.from({ length: width }, (_, i) => first.cells[i] ?? '') : Array.from({ length: width }, (_, i) => `Column ${i + 1}`));
  const body = hasHeader ? lines.slice(1) : lines;
  if (body.length === 0) throw new FileParseError('The file has headings but no rows');
  if (body.length > maxRows) throw new FileParseError(`The file has ${body.length.toLocaleString('en-GB')} rows; an import can have up to ${maxRows.toLocaleString('en-GB')}`);
  return {
    headers,
    sheet,
    rows: body.map((l) => ({ row: l.row, values: Object.fromEntries(headers.map((h, i) => [h, (l.cells[i] ?? '').trim()])) })),
  };
}

/**
 * The encoding of a file with no byte-order mark: UTF-16 when every other byte of the start is zero (little- or big-endian by which), else UTF-8 when it is
 * valid UTF-8, else Windows-1252 (older Excel exports).
 */
export function sniffEncoding(buf: Uint8Array): Encoding {
  const n = Math.min(buf.length, 4096);
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) (i % 2 === 0 ? (evenZero += 1) : (oddZero += 1));
  if (n >= 4 && oddZero > n * 0.3 && evenZero < n * 0.05) return 'utf-16le';
  if (n >= 4 && evenZero > n * 0.3 && oddZero < n * 0.05) return 'utf-16be';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return 'utf-8';
  } catch {
    return 'windows-1252';
  }
}

/** The encoding a file is read with: its byte-order mark when it has one, else the chosen one, else worked out from the bytes. */
export function detectEncoding(buf: Uint8Array, chosen: Encoding | 'auto' = 'auto'): { encoding: Encoding; bom: number } {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { encoding: 'utf-8', bom: 3 };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { encoding: 'utf-16le', bom: 2 };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { encoding: 'utf-16be', bom: 2 };
  return { encoding: chosen === 'auto' ? sniffEncoding(buf) : chosen, bom: 0 };
}

/** Text of a file without its byte-order mark and without NUL characters (which no text column can hold). */
export function decodeText(buf: Uint8Array, encoding: Encoding | 'auto' = 'auto'): string {
  const { encoding: enc, bom } = detectEncoding(buf, encoding);
  const text = new TextDecoder(enc, { fatal: false }).decode(buf.subarray(bom));
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\u0000/g, '');
}

const DELIMITER_CHARS: Record<Delimiter, string> = { ',': ',', ';': ';', tab: '\t', '|': '|' };

/** The separator of a delimited text: the candidate found the same number of times (more than none) on each of the first lines, most often wins; else comma. */
export function detectDelimiter(text: string): Delimiter {
  const lines = parseFirstLines(text, 10);
  let best: Delimiter = ',';
  let bestScore = 0;
  for (const d of [',', ';', 'tab', '|'] as Delimiter[]) {
    const counts = lines.map((l) => countOutsideQuotes(l, DELIMITER_CHARS[d]));
    const min = Math.min(...counts);
    const consistent = counts.every((c) => c === counts[0]);
    const score = min > 0 ? min + (consistent ? 1000 : 0) : 0;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function parseFirstLines(text: string, max: number): string[] {
  const out: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length && out.length < max; i += 1) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) {
      const line = text.slice(start, i);
      if (line.trim() !== '') out.push(line);
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      start = i + 1;
    }
  }
  if (out.length < max && start < text.length && text.slice(start).trim() !== '') out.push(text.slice(start));
  return out.length ? out : [''];
}

function countOutsideQuotes(line: string, ch: string): number {
  let n = 0;
  let quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === ch) n += 1;
  }
  return n;
}

/** RFC 4180 CSV: quoted fields may hold the separator, line breaks and doubled quotes; lines end with CRLF, LF or CR. */
export function parseCsvText(text: string, delimiter: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i += 1;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      i += 1;
    } else if (ch === '\r' || ch === '\n') {
      row.push(field);
      out.push(row);
      row = [];
      field = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (quoted) throw new FileParseError('A quoted value is never closed');
  if (field !== '' || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out;
}

export function parseCsv(buf: Uint8Array, opts: ParseOptions = {}): ParsedFile {
  const text = decodeText(buf, opts.encoding ?? 'auto');
  const chosen = !opts.delimiter || opts.delimiter === 'auto' ? detectDelimiter(text) : opts.delimiter;
  return toParsed(parseCsvText(text, DELIMITER_CHARS[chosen]), opts.hasHeader !== false, opts.maxRows ?? 100_000, null);
}

// ---- XLSX (the first worksheet) ------------------------------------------------------------------

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
    e.startsWith('#x') ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith('#') ? String.fromCodePoint(parseInt(e.slice(1), 10)) : XML_ENTITIES[e],
  );
/** The text of every <t> element inside a fragment (a shared string or inline string may be split into rich-text runs). */
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('');
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;

/** Column letters to a zero-based index: A → 0, Z → 25, AA → 26. */
export const columnIndex = (letters: string) => [...letters.toUpperCase()].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

// Built-in number formats that are dates (ECMA-376 §18.8.30), and custom codes with day / month / year parts outside quotes and brackets.
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const isDateFormat = (code: string) => /[dmy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));

/** An Excel serial date (1900 system) as an ISO date, with the time when there is one. */
export function excelSerialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  const d = new Date(ms);
  const iso = d.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19);
}

export function parseXlsx(buf: Uint8Array, opts: ParseOptions = {}): ParsedFile {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buf, { filter: (f) => f.name.startsWith('xl/') && (f.name.endsWith('.xml') || f.name.endsWith('.rels')) });
  } catch {
    throw new FileParseError('The file is not a valid Excel workbook (.xlsx)');
  }
  const read = (name: string) => (files[name] ? strFromU8(files[name]) : null);
  const workbook = read('xl/workbook.xml');
  if (!workbook) throw new FileParseError('The file is not a valid Excel workbook (.xlsx)');

  // The first sheet and where it lives.
  const sheetTag = workbook.match(/<sheet\s[^>]*\/?>/)?.[0];
  if (!sheetTag) throw new FileParseError('The workbook has no worksheets');
  const sheetName = unescapeXml(attr(sheetTag, 'name') ?? 'Sheet1');
  const relId = attr(sheetTag, 'r:id');
  const rels = read('xl/_rels/workbook.xml.rels') ?? '';
  const target = [...rels.matchAll(/<Relationship\s[^>]*\/?>/g)].map((m) => m[0]).find((t) => attr(t, 'Id') === relId);
  const sheetPath = target ? `xl/${(attr(target, 'Target') ?? '').replace(/^\/?xl\//, '').replace(/^\//, '')}` : 'xl/worksheets/sheet1.xml';
  const sheet = read(sheetPath) ?? read('xl/worksheets/sheet1.xml');
  if (!sheet) throw new FileParseError('The first worksheet could not be read');

  const shared = [...(read('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));

  // Which cell styles are dates.
  const styles = read('xl/styles.xml') ?? '';
  const customFormats = new Map([...styles.matchAll(/<numFmt\s[^>]*\/?>/g)].map((m) => [Number(attr(m[0], 'numFmtId')), unescapeXml(attr(m[0], 'formatCode') ?? '')]));
  const cellXfs = styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? '';
  const dateStyles = [...cellXfs.matchAll(/<xf\s[^>]*\/?>/g)].map((m) => {
    const id = Number(attr(m[0], 'numFmtId') ?? 0);
    return BUILTIN_DATE_FORMATS.has(id) || (customFormats.has(id) && isDateFormat(customFormats.get(id)!));
  });

  const table: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const rowNumber = Number(attr(rowMatch[1] ?? rowMatch[3] ?? '', 'r') ?? table.length + 1);
    const cells: string[] = [];
    for (const c of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = ` ${c[1]}`;
      const ref = attr(tag, 'r');
      const col = ref ? columnIndex(ref.replace(/[0-9]/g, '')) : cells.length;
      if (col >= MAX_COLUMNS) throw new FileParseError(`The worksheet has more than ${MAX_COLUMNS} columns`);
      const type = attr(tag, 't');
      const inner = c[2] ?? '';
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = '';
      if (type === 's') value = v !== undefined ? (shared[Number(v)] ?? '') : '';
      else if (type === 'inlineStr') value = textOf(inner);
      else if (type === 'b') value = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : '';
      else if (type === 'str' || type === 'e') value = v !== undefined ? unescapeXml(v) : '';
      else if (v !== undefined) {
        const style = Number(attr(tag, 's') ?? 0);
        const num = Number(v);
        value = dateStyles[style] && Number.isFinite(num) ? excelSerialToIso(num) : v;
      }
      while (cells.length < col) cells.push('');
      cells[col] = value;
    }
    while (table.length < rowNumber - 1) table.push([]);
    table[rowNumber - 1] = cells;
  }
  return toParsed(table, opts.hasHeader !== false, opts.maxRows ?? 100_000, sheetName);
}

/** Read a file by its name: .xlsx as a workbook, anything else as CSV with the connection's settings. */
export function parseFile(fileName: string, buf: Uint8Array, opts: ParseOptions = {}): ParsedFile {
  if (/\.xlsx$/i.test(fileName)) return parseXlsx(buf, opts);
  if (/\.xls$/i.test(fileName)) throw new FileParseError('Old .xls workbooks are not supported: save it as .xlsx or .csv');
  return parseCsv(buf, opts);
}
