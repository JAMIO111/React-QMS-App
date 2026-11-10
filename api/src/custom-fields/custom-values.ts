import { SQL, sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import type { Db } from '../database/database.service';
import { CUSTOM_FIELD_KEY, type CustomFieldEntity, type CustomValues, type CustomValuesInput } from './custom-fields.schemas';

type Row = Record<string, unknown>;

/**
 * Helpers the record modules use inside their own transaction (asUser), so a record and its custom values are written together and a field
 * required on save is checked when that transaction ends.
 */

/** Writes custom values for a record (merge; null / "" / [] clears). The database checks the caller's right to edit the record and each value. */
export async function writeCustomValues(db: Db, entity: CustomFieldEntity, recordId: string, values: CustomValuesInput | undefined | null): Promise<CustomValues | undefined> {
  if (!values || Object.keys(values).length === 0) return undefined;
  const res = await db.execute<{ v: CustomValues }>(sql`select app.set_custom_values(${entity}, ${recordId}::uuid, ${JSON.stringify(values)}::jsonb) as v`);
  return res.rows[0]?.v ?? {};
}

/** The custom values of many records the caller can read, by record id (missing = none). */
export async function readCustomValues(db: Db, entity: CustomFieldEntity, ids: string[]): Promise<Map<string, CustomValues>> {
  const out = new Map<string, CustomValues>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return out;
  const res = await db.execute<{ record_id: string; values: CustomValues }>(sql`
    select record_id, "values" from public.custom_field_values
    where entity_type = ${entity} and record_id = any(string_to_array(${unique.join(',')}, ',')::uuid[])`);
  for (const r of res.rows) out.set(r.record_id, r.values ?? {});
  return out;
}

/** Puts `customValues` on each item (by its `id`, or the key given). */
export async function attachCustomValues<T extends object>(db: Db, entity: CustomFieldEntity, items: T[], idOf: (item: T) => string = (i) => (i as Row).id as string): Promise<(T & { customValues: CustomValues })[]> {
  const values = await readCustomValues(db, entity, items.map(idOf));
  return items.map((i) => ({ ...i, customValues: values.get(idOf(i)) ?? {} }));
}

/** One record's custom values (empty when it has none). */
export async function customValuesOf(db: Db, entity: CustomFieldEntity, id: string): Promise<CustomValues> {
  return (await readCustomValues(db, entity, [id])).get(id) ?? {};
}

const FILTER_PREFIX = /^cf_([a-z][a-z0-9_]{0,39})$/;
/** Register filters on custom fields: query keys `cf_<field key>`. */
export function pickCustomFilters(query: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!query || typeof query !== 'object') return out;
  for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
    const m = FILTER_PREFIX.exec(k);
    if (m && typeof v === 'string' && v.trim() !== '' && CUSTOM_FIELD_KEY.test(m[1])) out[m[1]] = v.trim().slice(0, 500);
  }
  return out;
}

/** "a..b", "a..", "..b" → a range; otherwise null. */
const range = (v: string) => {
  const m = /^(.*)\.\.(.*)$/.exec(v);
  return m ? { lo: m[1].trim() || null, hi: m[2].trim() || null } : null;
};

/**
 * A condition for a register's WHERE clause from `cf_<key>` filters, by the field's type:
 *  text — contains (any case); choice / person — one of a comma list; several choices — holds any of a comma list; yes / no — true or false;
 *  number / date — equal, or a range "from..to" (either end may be left out); the value "-" — no value. An unknown key is refused (400).
 * `idColumn` is the record id column of the register's main table (e.g. sql`n.id`).
 */
export async function customFilterSql(db: Db, organisationId: string, entity: CustomFieldEntity, idColumn: SQL, filters: Record<string, string>): Promise<SQL | undefined> {
  const keys = Object.keys(filters);
  if (keys.length === 0) return undefined;
  const defs = await db.execute<{ key: string; field_type: string }>(sql`
    select key, field_type from public.custom_field_definitions
    where organisation_id = ${organisationId}::uuid and entity_type = ${entity} and key = any(string_to_array(${keys.join(',')}, ','))`);
  const types = new Map(defs.rows.map((d) => [d.key, d.field_type]));
  const parts: SQL[] = [];
  for (const [key, value] of Object.entries(filters)) {
    const type = types.get(key);
    if (!type) throw ApiError.badRequest('validation_failed', `There is no custom field "${key}" here`);
    const v = sql`cfv."values" -> ${key}`;
    const t = sql`cfv."values" ->> ${key}`;
    if (value === '-') {
      parts.push(sql`not exists (select 1 from public.custom_field_values cfv where cfv.record_id = ${idColumn} and cfv."values" ? ${key})`);
      continue;
    }
    let cond: SQL;
    const list = value.split(',').map((x) => x.trim()).filter(Boolean);
    switch (type) {
      case 'text':
      case 'long_text':
        cond = sql`${t} ilike ${'%' + value.replace(/[\\%_]/g, (c) => '\\' + c) + '%'}`;
        break;
      case 'choice':
      case 'person':
        cond = sql`${t} = any(string_to_array(${list.join(',')}, ','))`;
        break;
      case 'multi_choice':
        cond = sql`${v} ?| string_to_array(${list.join(',')}, ',')`;
        break;
      case 'boolean':
        if (value !== 'true' && value !== 'false') throw ApiError.badRequest('validation_failed', `Filter ${key} with true or false`);
        cond = sql`${v} = ${value}::jsonb`;
        break;
      case 'number': {
        const r = range(value);
        const isNum = (x: string | null) => x === null || /^-?\d+(\.\d+)?$/.test(x);
        if (r ? !isNum(r.lo) || !isNum(r.hi) : !isNum(value)) throw ApiError.badRequest('validation_failed', `Filter ${key} with a number or a range like 1..5`);
        cond = r
          ? sql`(${t})::numeric between coalesce(${r.lo}::numeric, '-infinity'::numeric) and coalesce(${r.hi}::numeric, 'infinity'::numeric)`
          : sql`(${t})::numeric = ${value}::numeric`;
        break;
      }
      case 'date': {
        const r = range(value);
        const isDate = (x: string | null) => x === null || /^\d{4}-\d{2}-\d{2}$/.test(x);
        if (r ? !isDate(r.lo) || !isDate(r.hi) : !isDate(value)) throw ApiError.badRequest('validation_failed', `Filter ${key} with a date or a range like 2026-01-01..2026-12-31`);
        cond = r ? sql`${t} >= coalesce(${r.lo}, '0000-01-01') and ${t} <= coalesce(${r.hi}, '9999-12-31')` : sql`${t} = ${value}`;
        break;
      }
      default:
        throw ApiError.badRequest('validation_failed', `Custom field "${key}" cannot be filtered`);
    }
    parts.push(sql`exists (select 1 from public.custom_field_values cfv where cfv.record_id = ${idColumn} and cfv."values" ? ${key} and ${cond})`);
  }
  return sql.join(parts, sql` and `);
}
