import { CatalogueField, EntityCatalogue } from './catalogue';
import { DATE_FORMATS, DateFormat, parseDate } from './mapping-dates';
import { checkFormula, runFormula } from './formula';
import { applySteps, Step, stepColumns, stepProblems, stepsGive } from './steps';

export { DATE_FORMATS, parseDate };
export type { DateFormat };

/**
 * The mapping engine (plan §8: a closed set of transforms — no expressions, no code). A mapping names the key column (the record's identifier at the source)
 * and, for each canonical field, where its value comes from and how it is cleaned. Values are then converted and checked against the field's type.
 */
export const TRANSFORMS = ['none', 'upper', 'lower', 'map', 'constant', 'concat'] as const;
export type TransformKind = (typeof TRANSFORMS)[number];
export const OWNERSHIP = ['source_wins', 'qms_wins', 'manual_review'] as const;
export const REF_MATCH = ['code', 'source'] as const;

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
  /**
   * Who owns the field once the record exists (IN5, plan §6.5): `source_wins` (default) an update writes it; `qms_wins` it is set when the record is created
   * and never again by an import; `manual_review` a value that would change the record is parked for a person to accept or reject. The database enforces it.
   */
  ownership?: (typeof OWNERSHIP)[number];
  /** A reference field (D10): matched by the Fortress code (default) or by the id the source gave the record in an earlier import. */
  match?: (typeof REF_MATCH)[number];
  /** Steps applied in order after the value is taken (core/steps.ts). */
  steps?: Step[];
  /** A formula (core/formula) used instead of the column and the original transforms; the steps still follow it. */
  formula?: string | null;
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
    if (m.formula) {
      const check = checkFormula(m.formula, columns);
      if (check.error) problems.push(`${f.label}: ${check.error.message}`);
      problems.push(...stepProblems(m.steps, f.label, columns));
      if (m.match && !REF_MATCH.includes(m.match)) problems.push(`${f.label}: unknown way of matching`);
      else if (m.match && !f.ref) problems.push(`${f.label} is not a link to another record`);
      else if (m.match === 'source' && !f.ref?.source) problems.push(`${f.label} can only be matched by its Fortress code`);
      continue;
    }
    const kind = m.transform ?? 'none';
    if (!TRANSFORMS.includes(kind)) problems.push(`${f.label}: unknown transform "${kind}"`);
    const cols = kind === 'concat' ? (m.sources ?? []) : kind === 'constant' ? [] : m.source ? [m.source] : [];
    if (kind === 'concat' && cols.length < 2) problems.push(`${f.label}: join at least two columns`);
    if (kind === 'constant' && (m.value ?? '') === '') problems.push(`${f.label}: give the value every record gets`);
    const fillsItself = (m.steps ?? []).some((s) => s.kind === 'join' || s.kind === 'coalesce' || s.kind === 'default' || (s.kind === 'if' && (s.test === 'empty' || (s.test === 'not_empty' && s.else != null))));
    if (kind !== 'constant' && kind !== 'concat' && !m.source && (m.default ?? '') === '' && !fillsItself) problems.push(`${f.label}: choose a column or a default`);
    problems.push(...stepProblems(m.steps, f.label, columns));
    if (kind === 'map' && (!m.values || Object.keys(m.values).length === 0)) problems.push(`${f.label}: list the values to translate`);
    if (columns) for (const c of cols) if (!columns.has(c)) problems.push(`${f.label}: the column "${c}" is not in the file`);
    if (m.dateFormat && !DATE_FORMATS.includes(m.dateFormat)) problems.push(`${f.label}: unknown date format`);
    if (m.ownership && !OWNERSHIP.includes(m.ownership)) problems.push(`${f.label}: unknown ownership`);
    else if (m.ownership === 'manual_review' && (f.custom || f.noReview)) problems.push(`${f.label}: its new values cannot be held for review; choose "Source wins" or "Fortress wins"`);
    if (m.match && !REF_MATCH.includes(m.match)) problems.push(`${f.label}: unknown way of matching`);
    else if (m.match && !f.ref) problems.push(`${f.label} is not a link to another record`);
    else if (m.match === 'source' && !f.ref?.source) problems.push(`${f.label} can only be matched by its Fortress code`);
  }
  for (const f of catalogue.fields) if (f.required && !seen.has(f.key)) problems.push(`${f.label} is required: map a column to it`);
  return problems;
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
      if (field.min !== undefined && (field.minExclusive ? n <= field.min : n < field.min)) return { error: `"${raw}" must be ${field.minExclusive ? 'more than' : 'at least'} ${field.min}` };
      if (field.max !== undefined && n > field.max) return { error: `"${raw}" must be at most ${field.max}` };
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
      if (!EMAIL.test(raw)) return { error: `"${raw}" is not an email address` };
      return field.maxLength && raw.length > field.maxLength ? { error: `Longer than ${field.maxLength} characters` } : { value: raw };
    case 'url':
      if (!(/^https?:\/\/\S+$/i.test(raw) || /^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(raw))) return { error: `"${raw}" is not a web address` };
      return field.maxLength && raw.length > field.maxLength ? { error: `Longer than ${field.maxLength} characters` } : { value: raw };
    default:
      if (field.maxLength && raw.length > field.maxLength) return { error: `Longer than ${field.maxLength} characters` };
      if (field.pattern && !new RegExp(field.pattern).test(raw)) return { error: `"${raw}" is not in the form Fortress allows for ${field.label.toLowerCase()}` };
      return { value: raw };
  }
}

/** One cell of a source record, trimmed ('' when absent). Only the record's own columns are read, never inherited properties such as "constructor". */
export function cell(record: Record<string, unknown>, column: string): string {
  return Object.prototype.hasOwnProperty.call(record, column) ? String(record[column] ?? '').trim() : '';
}

/** The raw text a mapping takes for one field from one source record (before conversion), after its steps. */
export function rawValue(m: FieldMapping, record: Record<string, unknown>, trail?: string[]): { value: string } | { error: string } {
  const get = (c: string) => cell(record, c);
  let taken: string;
  if (m.formula) {
    const r = runFormula(m.formula, get);
    if ('error' in r) return r;
    taken = r.value;
  } else taken = legacyValue(m, record);
  trail?.push(taken);
  return applySteps(m.steps, taken, get, trail);
}

/** Every source column one field row reads (its column, joined columns, formula columns and step columns). */
export function fieldColumns(m: FieldMapping): string[] {
  const cols = new Set<string>();
  if (m.formula) for (const c of checkFormula(m.formula).columns) cols.add(c);
  else if ((m.transform ?? 'none') === 'concat') for (const c of m.sources ?? []) cols.add(c);
  else if (m.transform !== 'constant' && m.source) cols.add(m.source);
  for (const c of stepColumns(m.steps)) cols.add(c);
  return [...cols];
}

/** What the original transforms give (none, upper, lower, map, constant, concat, then the default when empty). */
function legacyValue(m: FieldMapping, record: Record<string, unknown>): string {
  const get = (c: string | null | undefined) => (c ? cell(record, c) : '');
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
  const externalId = cell(record, spec.keyField) || null;
  for (const m of spec.fields) {
    const f = byKey.get(m.target);
    if (!f) continue;
    const taken = rawValue(m, record);
    if ('error' in taken) {
      errors.push({ field: f.key, message: `${f.label}: ${taken.error}` });
      continue;
    }
    const raw = taken.value;
    if (raw === '') {
      canonical[f.key] = null;
      if (f.required) errors.push({ field: f.key, message: `${f.label} is required` });
      continue;
    }
    const out = convert(f, raw, { ...m, ...(stepsGive(m.steps, 'number') ? { decimal: undefined } : {}), ...(stepsGive(m.steps, 'date') ? { dateFormat: undefined } : {}) });
    if ('error' in out) errors.push({ field: f.key, message: `${f.label}: ${out.error}` });
    else canonical[f.key] = out.value;
  }
  for (const f of catalogue.fields) if (f.required && !(f.key in canonical)) errors.push({ field: f.key, message: `${f.label} is required` });
  return { externalId, canonical, errors };
}
