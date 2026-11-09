import { CatalogueField, EntityCatalogue } from './catalogue';

/**
 * The mapping engine (plan §8: a closed set of transforms — no expressions, no code). A mapping names the key column (the record's identifier at the source)
 * and, for each canonical field, where its value comes from and how it is cleaned. Values are then converted and checked against the field's type.
 */
export const TRANSFORMS = ['none', 'upper', 'lower', 'map', 'constant', 'concat'] as const;
export type TransformKind = (typeof TRANSFORMS)[number];
export const DATE_FORMATS = ['iso', 'dmy', 'mdy', 'excel'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];
export const OWNERSHIP = ['source_wins', 'qms_wins', 'manual_review'] as const;

export interface FieldMapping {
  target: string;
  /** The source column (most transforms). */
  source?: string | null;
  /** The source columns joined by a concat. */
  sources?: string[];
  transform?: TransformKind;
  /** map: source value → value (matched ignoring case and spaces at the ends). */
  values?: Record<string, string>;
  /** constant: the value every record gets. */
  value?: string;
  /** concat: put between the parts (default one space). */
  separator?: string;
  /** Date fields: how dates are written in the source (default ISO, yyyy-mm-dd). */
  dateFormat?: DateFormat;
  /** Number fields: the decimal mark in the source (default "."). */
  decimal?: '.' | ',';
  /** Used when the source value is empty. */
  default?: string | null;
  /** Who owns the field once the record exists (IN5); stored now, source_wins by default. */
  ownership?: (typeof OWNERSHIP)[number];
}

export interface MappingSpec {
  keyField: string;
  fields: FieldMapping[];
}

export interface FieldError {
  field: string | null;
  message: string;
}

/** Problems with a mapping before it is saved (unknown targets, a required field with nowhere to come from, a column the file does not have…). */
export function mappingProblems(catalogue: EntityCatalogue, spec: MappingSpec, headers?: string[]): string[] {
  const problems: string[] = [];
  const byKey = new Map(catalogue.fields.map((f) => [f.key, f]));
  const columns = headers ? new Set(headers) : null;
  if (!spec.keyField?.trim()) problems.push('Choose the column that identifies each record');
  else if (columns && !columns.has(spec.keyField)) problems.push(`The key column "${spec.keyField}" is not in the file`);
  const seen = new Set<string>();
  for (const m of spec.fields) {
    const f = byKey.get(m.target);
    if (!f) {
      problems.push(`"${m.target}" is not a field of ${catalogue.label.toLowerCase()}`);
      continue;
    }
    if (seen.has(m.target)) problems.push(`${f.label} is mapped twice`);
    seen.add(m.target);
    const kind = m.transform ?? 'none';
    if (!TRANSFORMS.includes(kind)) problems.push(`${f.label}: unknown transform "${kind}"`);
    const cols = kind === 'concat' ? (m.sources ?? []) : kind === 'constant' ? [] : m.source ? [m.source] : [];
    if (kind === 'concat' && cols.length < 2) problems.push(`${f.label}: join at least two columns`);
    if (kind === 'constant' && (m.value ?? '') === '') problems.push(`${f.label}: give the value every record gets`);
    if (kind !== 'constant' && kind !== 'concat' && !m.source && (m.default ?? '') === '') problems.push(`${f.label}: choose a column or a default`);
    if (kind === 'map' && (!m.values || Object.keys(m.values).length === 0)) problems.push(`${f.label}: list the values to translate`);
    if (columns) for (const c of cols) if (!columns.has(c)) problems.push(`${f.label}: the column "${c}" is not in the file`);
    if (m.dateFormat && !DATE_FORMATS.includes(m.dateFormat)) problems.push(`${f.label}: unknown date format`);
    if (m.ownership && !OWNERSHIP.includes(m.ownership)) problems.push(`${f.label}: unknown ownership`);
  }
  for (const f of catalogue.fields) if (f.required && !seen.has(f.key)) problems.push(`${f.label} is required: map a column to it`);
  return problems;
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoDate = (y: number, m: number, d: number): string | null => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};

/** A date written in the given way, as yyyy-mm-dd (null when it is not a real date). */
export function parseDate(raw: string, format: DateFormat = 'iso'): string | null {
  const s = raw.trim();
  if (format === 'excel' || /^\d{5}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return new Date(Math.round((n - 25569) * 86_400_000)).toISOString().slice(0, 10);
  }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) return isoDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (!m || format === 'iso') return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return format === 'dmy' ? isoDate(year, +m[2], +m[1]) : isoDate(year, +m[1], +m[2]);
}

const YES = new Set(['yes', 'y', 'true', 't', '1', 'active', 'on']);
const NO = new Set(['no', 'n', 'false', 'f', '0', 'inactive', 'off']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Convert and check one value for its field. Returns the canonical value, or an error message. */
export function convert(field: CatalogueField, raw: string, m: FieldMapping): { value: unknown } | { error: string } {
  switch (field.type) {
    case 'number':
    case 'integer': {
      const s = raw.replace(/\s/g, '');
      const normal = m.decimal === ',' ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
      if (!/^-?\d+(\.\d+)?$/.test(normal)) return { error: `"${raw}" is not a number` };
      const n = Number(normal);
      if (field.type === 'integer' && !Number.isInteger(n)) return { error: `"${raw}" is not a whole number` };
      return { value: n };
    }
    case 'date': {
      const d = parseDate(raw, m.dateFormat);
      return d ? { value: d } : { error: `"${raw}" is not a date written as ${m.dateFormat === 'dmy' ? 'day/month/year' : m.dateFormat === 'mdy' ? 'month/day/year' : 'year-month-day'}` };
    }
    case 'boolean': {
      const s = raw.toLowerCase();
      if (YES.has(s)) return { value: true };
      if (NO.has(s)) return { value: false };
      return { error: `"${raw}" is not yes or no` };
    }
    case 'enum': {
      const s = raw.toLowerCase().replace(/[\s-]+/g, '_');
      const opt = field.options?.find((o) => o.value === s || o.label.toLowerCase() === raw.toLowerCase());
      return opt ? { value: opt.value } : { error: `"${raw}" is not one of: ${field.options?.map((o) => o.label).join(', ')}` };
    }
    case 'country': {
      const s = raw.toUpperCase();
      return /^[A-Z]{2}$/.test(s) ? { value: s } : { error: `"${raw}" is not a two-letter country code` };
    }
    case 'email':
      return EMAIL.test(raw) ? { value: raw } : { error: `"${raw}" is not an email address` };
    case 'url':
      return /^https?:\/\/\S+$/i.test(raw) || /^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(raw) ? { value: raw } : { error: `"${raw}" is not a web address` };
    default:
      return field.maxLength && raw.length > field.maxLength ? { error: `Longer than ${field.maxLength} characters` } : { value: raw };
  }
}

/** The raw text a mapping takes for one field from one source record (before conversion). */
function rawValue(m: FieldMapping, record: Record<string, unknown>): string {
  const get = (c: string | null | undefined) => (c ? String(record[c] ?? '').trim() : '');
  const kind = m.transform ?? 'none';
  let v: string;
  if (kind === 'constant') v = m.value ?? '';
  else if (kind === 'concat') v = (m.sources ?? []).map(get).filter(Boolean).join(m.separator ?? ' ');
  else v = get(m.source);
  if (kind === 'upper') v = v.toUpperCase();
  if (kind === 'lower') v = v.toLowerCase();
  if (kind === 'map' && v !== '') {
    const hit = Object.entries(m.values ?? {}).find(([from]) => from.trim().toLowerCase() === v.toLowerCase());
    if (hit) v = hit[1];
  }
  return v === '' ? (m.default ?? '').trim() : v;
}

/** Apply a mapping to one source record: its identifier, the canonical record, and every problem found (the row is rejected when there is one). */
export function applyMapping(catalogue: EntityCatalogue, spec: MappingSpec, record: Record<string, unknown>): { externalId: string | null; canonical: Record<string, unknown>; errors: FieldError[] } {
  const byKey = new Map(catalogue.fields.map((f) => [f.key, f]));
  const canonical: Record<string, unknown> = {};
  const errors: FieldError[] = [];
  const externalId = String(record[spec.keyField] ?? '').trim() || null;
  for (const m of spec.fields) {
    const f = byKey.get(m.target);
    if (!f) continue;
    const raw = rawValue(m, record);
    if (raw === '') {
      canonical[f.key] = null;
      if (f.required) errors.push({ field: f.key, message: `${f.label} is required` });
      continue;
    }
    const out = convert(f, raw, m);
    if ('error' in out) errors.push({ field: f.key, message: `${f.label}: ${out.error}` });
    else canonical[f.key] = out.value;
  }
  for (const f of catalogue.fields) if (f.required && !(f.key in canonical)) errors.push({ field: f.key, message: `${f.label} is required` });
  return { externalId, canonical, errors };
}
