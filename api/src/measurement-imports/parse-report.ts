import { DELIMITER_CHARS, decodeText, FileParseError, parseCsvText, readXlsxTable } from '../integrations/core/file-parsers';
import { HEADER_FIELDS, HeaderField, TableSettings } from './profile-settings';
import { normaliseUnit } from './units';

/** One feature line of a report, as written (values are in the file's own unit; matching converts them). */
export interface ParsedFeature {
  /** 1-based, across the whole file. */
  position: number;
  /** The line in the file (1 = the first line). */
  line: number;
  featureName: string;
  balloon: string | null;
  /** The line's cells by heading (non-empty ones, kept short) so a person can see what the file said. */
  raw: Record<string, string>;
  actualText: string | null;
  actual: number | null;
  pass: boolean | null;
  unit: string | null;
  nominal: number | null;
  lower: number | null;
  upper: number | null;
}

export interface ParsedUnit {
  position: number;
  reference: string | null;
  features: ParsedFeature[];
}

export interface ParsedReport {
  header: Partial<Record<HeaderField, string>>;
  headings: string[];
  headingRow: number;
  units: ParsedUnit[];
  featureCount: number;
  warnings: string[];
}

export const MAX_UNITS = 200;
export const MAX_FEATURES = 5000;
const MAX_LINES = 50_000;
const RAW_CELLS = 40;
const RAW_CELL_LENGTH = 100;
const RAW_BYTES = 3500;

/** A number as written in a report: optional sign, the chosen decimal mark, optional exponent; spaces ignored. Anything else → null. */
export function parseMeasurement(text: string | null | undefined, decimal: '.' | ',' = '.'): number | null {
  if (text == null) return null;
  let t = text.replace(/[\s ]/g, '');
  if (!t) return null;
  if (decimal === ',') {
    if (t.includes('.') && t.includes(',')) return null;
    t = t.replace(',', '.');
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The balloon number in a feature name: a number (optionally with one letter before or after) at the start, or after a "#" or in brackets. */
export function balloonFromFeature(name: string): string | null {
  const start = name.match(/^\s*([A-Za-z]?\d+[A-Za-z]?)(?=$|[\s_.\-:)#/])/);
  if (start) return start[1];
  const marked = name.match(/(?:#|\(|\[)\s*([A-Za-z]?\d+[A-Za-z]?)\s*(?:\)|\]|(?=$|[\s_.\-:]))/);
  return marked ? marked[1] : null;
}

/** A balloon number for comparing: capitals, no spaces, no leading zeros on its digits ("012" = "12", "b03" = "B3"). */
export function normaliseBalloon(b: string | null | undefined): string | null {
  const t = (b ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!t) return null;
  return t.replace(/(^|[A-Z])0+(\d)/g, '$1$2');
}

/** The separator used most consistently by the lines of a report (header lines may use none). */
export function detectReportDelimiter(text: string): string {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(0, 200);
  let best = ',';
  let bestLines = 0;
  for (const d of [',', ';', '\t', '|']) {
    const counts = new Map<number, number>();
    for (const l of lines) {
      const n = l.split(d).length - 1;
      if (n > 0) counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    const modal = Math.max(0, ...counts.values());
    if (modal > bestLines) {
      best = d;
      bestLines = modal;
    }
  }
  return best;
}

function readTable(fileName: string, buf: Uint8Array, s: TableSettings): string[][] {
  if (/\.xlsx$/i.test(fileName)) return readXlsxTable(buf).table;
  if (/\.xls$/i.test(fileName)) throw new FileParseError('Old .xls workbooks are not supported: save it as .xlsx or .csv');
  const text = decodeText(buf, s.encoding);
  const sep = s.delimiter === 'auto' ? detectReportDelimiter(text) : DELIMITER_CHARS[s.delimiter];
  return parseCsvText(text, sep);
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const stripLabel = (s: string) => s.trim().replace(/\s*[:=]\s*$/, '').trim();

/** Header values from the lines above the table: "Label: value" in one cell, or the label in one cell and the value in the next non-empty one. */
export function readHeader(lines: string[][], labels: TableSettings['header']): Partial<Record<HeaderField, string>> {
  const out: Partial<Record<HeaderField, string>> = {};
  for (const field of HEADER_FIELDS) {
    const label = labels[field];
    if (!label) continue;
    search: for (const cells of lines) {
      for (let i = 0; i < cells.length; i++) {
        const cell = (cells[i] ?? '').trim();
        if (!cell) continue;
        if (same(stripLabel(cell), label)) {
          const value = cells.slice(i + 1).map((c) => (c ?? '').trim()).find((c) => c !== '');
          if (value) {
            out[field] = value.slice(0, 100);
            break search;
          }
        }
        const inline = cell.match(/^(.*?)\s*[:=]\s*(.+)$/);
        if (inline && same(inline[1], label)) {
          out[field] = inline[2].trim().slice(0, 100);
          break search;
        }
      }
    }
  }
  return out;
}

/** Read a table-style report with a profile's settings. Throws FileParseError with a message for the person when it cannot. */
export function parseReport(fileName: string, buf: Uint8Array, settings: TableSettings): ParsedReport {
  const table = readTable(fileName, buf, settings).map((cells) => cells.map((c) => (c ?? '').trim()));
  if (table.length > MAX_LINES) throw new FileParseError(`The file has more than ${MAX_LINES.toLocaleString('en-GB')} lines`);
  const c = settings.columns;
  const valueHeading = c.actual ?? c.passFail!;

  // The line of the column headings.
  let headingIndex: number;
  if (settings.headingRow === 'auto') {
    headingIndex = table.findIndex((cells) => cells.some((x) => same(x, c.feature)) && cells.some((x) => same(x, valueHeading)));
    if (headingIndex < 0) throw new FileParseError(`Could not find a line with the columns "${c.feature}" and "${valueHeading}"; check the profile's column names`);
  } else {
    headingIndex = settings.headingRow - 1;
    if (!table[headingIndex]?.some((x) => x)) throw new FileParseError(`Line ${settings.headingRow} of the file is empty; it should hold the column headings`);
  }
  const headings = table[headingIndex];
  const col = (heading: string | undefined) => (heading ? headings.findIndex((h) => same(h, heading)) : -1);
  const idx = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, col(v as string)])) as Record<keyof typeof c, number>;

  const missingRequired = [c.feature, c.actual, c.passFail].filter((h, i) => h && [idx.feature, idx.actual, idx.passFail][i] < 0) as string[];
  if (missingRequired.length) throw new FileParseError(`The file has no column ${missingRequired.map((h) => `"${h}"`).join(' or ')}; check the profile's column names`);
  const warnings: string[] = [];
  for (const [key, heading] of Object.entries(c)) {
    if (heading && idx[key as keyof typeof c] < 0 && !['feature', 'actual', 'passFail'].includes(key)) warnings.push(`The file has no column "${heading}"`);
  }

  const header = readHeader(table.slice(0, headingIndex), settings.header);
  const cell = (cells: string[], i: number) => (i >= 0 ? (cells[i] ?? '').trim() : '');
  const passValues = settings.passValues.map((v) => v.toLowerCase());
  const failValues = settings.failValues.map((v) => v.toLowerCase());
  const passOf = (text: string): boolean | null => {
    const t = text.trim().toLowerCase();
    if (!t) return null;
    if (passValues.includes(t)) return true;
    if (failValues.includes(t)) return false;
    return null;
  };

  const units = new Map<string, ParsedUnit>();
  let position = 0;
  for (let i = headingIndex + 1; i < table.length; i++) {
    const cells = table[i];
    if (!cells.some((x) => x)) continue;
    const feature = cell(cells, idx.feature);
    const actualText = idx.actual >= 0 ? cell(cells, idx.actual) : null;
    const passText = cell(cells, idx.passFail);
    if (!feature && !actualText && !passText) continue;
    position += 1;
    if (position > MAX_FEATURES) throw new FileParseError(`The file has more than ${MAX_FEATURES.toLocaleString('en-GB')} features`);

    const axis = cell(cells, idx.axis);
    const featureName = ([feature || `Line ${i + 1}`, axis].filter(Boolean).join(' ')).slice(0, 200);
    const actual = parseMeasurement(actualText, settings.decimal);
    const pass = passOf(passText) ?? (actual === null && actualText ? passOf(actualText) : null);
    const nominal = parseMeasurement(cell(cells, idx.nominal), settings.decimal);
    const upTol = parseMeasurement(cell(cells, idx.upperTolerance), settings.decimal);
    const loTol = parseMeasurement(cell(cells, idx.lowerTolerance), settings.decimal);
    let upper = parseMeasurement(cell(cells, idx.upperLimit), settings.decimal);
    let lower = parseMeasurement(cell(cells, idx.lowerLimit), settings.decimal);
    if (upper === null && nominal !== null && upTol !== null) upper = nominal + (settings.lowerTolerance === 'minus' ? Math.abs(upTol) : upTol);
    if (lower === null && nominal !== null && loTol !== null) lower = nominal + (settings.lowerTolerance === 'minus' ? -Math.abs(loTol) : loTol);
    const round = (n: number | null) => (n === null ? null : Number(n.toPrecision(12)));

    const raw: Record<string, string> = {};
    let bytes = 0;
    for (let k = 0; k < headings.length && Object.keys(raw).length < RAW_CELLS; k++) {
      const v = (cells[k] ?? '').trim();
      const h = (headings[k] || `Column ${k + 1}`).slice(0, 60);
      if (!v || h === '__proto__') continue;
      const short = v.slice(0, RAW_CELL_LENGTH);
      bytes += h.length + short.length + 6;
      if (bytes > RAW_BYTES) break;
      raw[h] = short;
    }

    const split = cell(cells, idx.unitSplit);
    const key = idx.unitSplit >= 0 ? split.toLowerCase() : '';
    let unit = units.get(key);
    if (!unit) {
      if (units.size >= MAX_UNITS) throw new FileParseError(`The file holds more than ${MAX_UNITS} parts`);
      unit = { position: units.size + 1, reference: (idx.unitSplit >= 0 ? split : header.serial ?? '').slice(0, 60) || null, features: [] };
      units.set(key, unit);
    }
    unit.features.push({
      position,
      line: i + 1,
      featureName,
      balloon: settings.balloonFrom === 'column' ? cell(cells, idx.balloon) || null : settings.balloonFrom === 'feature' ? balloonFromFeature(feature) : null,
      raw,
      actualText: (actualText ?? passText ?? '').slice(0, 100) || null,
      actual,
      pass,
      unit: normaliseUnit(cell(cells, idx.unit)) ?? normaliseUnit(settings.unit),
      nominal: round(nominal),
      lower: round(lower),
      upper: round(upper),
    });
  }
  if (position === 0) throw new FileParseError('No measured features were found under the column headings');
  return { header, headings: headings.filter(Boolean), headingRow: headingIndex + 1, units: [...units.values()], featureCount: position, warnings };
}
