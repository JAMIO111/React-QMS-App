/**
 * Keeps the import catalogue honest against the schema (no app needed, only the migrated database). For each kind of record:
 *  - every column of its table is either imported or listed as left out with a reason (core/columns.ts) — a migration that adds a column fails here
 *    until someone decides; a listed column that no longer exists fails too;
 *  - every catalogue field fills a column that exists, and its import function (app.import_<kind>) writes that column;
 *  - a column that must be given on insert (NOT NULL, no default) is a required field;
 *  - every allowed value the catalogue offers is allowed by the column's own rule, and the limits the API reads from the database are found.
 */
import { Pool } from 'pg';
import { CATALOGUE } from '../src/integrations/core/catalogue';
import { applyRules, CATALOGUE_TABLES, tableRules, TableRules } from '../src/integrations/core/column-rules';
import { ENTITY_COLUMNS } from '../src/integrations/core/columns';
import { requireDb } from './helpers';

let admin: Pool;
let columns: Map<string, Map<string, { notNull: boolean; hasDefault: boolean }>>;
let rules: TableRules;

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  const cols = await admin.query<{ t: string; c: string; not_null: boolean; has_default: boolean }>(
    `select table_name as t, column_name as c, is_nullable = 'NO' as not_null, column_default is not null as has_default
       from information_schema.columns where table_schema = 'public' and table_name = any($1::text[])`,
    [CATALOGUE_TABLES],
  );
  columns = new Map();
  for (const r of cols.rows) {
    if (!columns.has(r.t)) columns.set(r.t, new Map());
    columns.get(r.t)!.set(r.c, { notNull: r.not_null, hasDefault: r.has_default });
  }
  const defs = await admin.query<{ t: string; def: string }>(
    `select c.relname as t, pg_get_constraintdef(k.oid) as def from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
      where k.contype = 'c' and n.nspname = 'public' and c.relname = any($1::text[])`,
    [CATALOGUE_TABLES],
  );
  const byTable = new Map<string, string[]>();
  for (const r of defs.rows) byTable.set(r.t, [...(byTable.get(r.t) ?? []), r.def]);
  rules = Object.fromEntries([...byTable].map(([t, d]) => [t, tableRules(d)]));
});

afterAll(async () => {
  await admin?.end();
});

describe.each(CATALOGUE.map((c) => [c.entityType, c] as const))('the %s import', (entity, catalogue) => {
  const map = ENTITY_COLUMNS[entity]!;

  it('has a column map', () => {
    expect(map).toBeDefined();
  });

  it('classifies every column of its table, and every classified column exists', () => {
    const table = columns.get(map.table);
    expect(table).toBeDefined();
    const imported = Object.values(map.fields).filter((f) => !f.table || f.table === map.table).map((f) => f.column);
    const excluded = Object.keys(map.excluded);
    const unclassified = [...table!.keys()].filter((c) => !imported.includes(c) && !excluded.includes(c));
    expect({ table: map.table, unclassified }).toEqual({ table: map.table, unclassified: [] });
    const missing = [...imported, ...excluded].filter((c) => !table!.has(c));
    expect({ table: map.table, missing }).toEqual({ table: map.table, missing: [] });
    expect(imported.filter((c) => excluded.includes(c))).toEqual([]);
  });

  it('maps every catalogue field to a column, and its import function writes each one', async () => {
    const unmapped = catalogue.fields.map((f) => f.key).filter((k) => !map.fields[k] && !map.virtual?.[k]);
    expect(unmapped).toEqual([]);
    // By name: a production order's import also takes the connection's system code and the source id.
    const fn = (
      await admin.query<{ def: string }>(
        `select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'import_' || $1`,
        [entity],
      )
    ).rows[0].def;
    const notWritten = Object.entries(map.fields)
      .filter(([, f]) => !new RegExp(`\\b${f.column}\\b`).test(fn))
      .map(([k, f]) => `${k} → ${f.table ?? map.table}.${f.column}`);
    expect(notWritten).toEqual([]);
    for (const [k, f] of Object.entries(map.fields)) expect({ field: k, exists: columns.get(f.table ?? map.table)?.has(f.column) }).toEqual({ field: k, exists: true });
  });

  it('asks for every column that must be given on insert', () => {
    const table = columns.get(map.table)!;
    const mustGive = [...table.entries()].filter(([c, i]) => i.notNull && !i.hasDefault && !map.excluded[c]).map(([c]) => c);
    const required = catalogue.fields.filter((f) => f.required).map((f) => map.fields[f.key]?.column);
    expect(mustGive.filter((c) => !required.includes(c))).toEqual([]);
  });

  it('offers only values the database allows, and finds the limits the API will read', () => {
    const effective = applyRules(catalogue, rules);
    for (const f of catalogue.fields.filter((x) => x.type === 'enum' && !x.ref && !map.virtual?.[x.key])) {
      const target = map.fields[f.key];
      const allowed = rules[target.table ?? map.table]?.[target.column]?.options;
      expect({ field: f.key, hasRule: !!allowed }).toEqual({ field: f.key, hasRule: true });
      expect({ field: f.key, stale: (f.options ?? []).map((o) => o.value).filter((v) => !allowed!.includes(v)) }).toEqual({ field: f.key, stale: [] });
    }
    for (const f of effective.fields.filter((x) => x.type === 'text' && !x.ref)) {
      expect({ field: f.key, hasLimit: f.maxLength !== undefined }).toEqual({ field: f.key, hasLimit: true });
    }
  });
});

/**
 * Import field locks (docs/import-field-locks-plan.md): the database refuses a person's edit of a field an import owns, using its own copy of the
 * catalogue-field → column map (app.integration_field_columns). That copy must say what core/columns.ts says, and every kind of record must be either
 * lockable or listed here with the reason it is not.
 */
const LOCKABLE = ['supplier', 'customer', 'part', 'machine', 'employee', 'gauge_type', 'gauge', 'production_order'];
const NOT_LOCKABLE: Record<string, string> = {
  calibration: 'Legacy calibrations are only ever added, never updated',
  nonconformance: 'Non-conformances are only ever added, never updated',
  goods_receipt: 'Deliveries are only ever added, never updated',
  po_receipt_total: 'Received totals follow the source and are not edited by people',
  purchase_order: 'Order lines are a later step (the agreed date is the one editable field)',
};

describe('import field locks follow the catalogue', () => {
  it.each(LOCKABLE)('the database map for %s equals the catalogue map', async (entity) => {
    const map = ENTITY_COLUMNS[entity as keyof typeof ENTITY_COLUMNS]!;
    const expected = Object.fromEntries(Object.entries(map.fields).filter(([, f]) => !f.table || f.table === map.table).map(([k, f]) => [k, f.column]));
    const r = await admin.query<{ m: Record<string, string>; t: string }>('select app.integration_field_columns($1) as m, app.integration_lock_table($1) as t', [entity]);
    expect(r.rows[0].m).toEqual(expected);
    expect(r.rows[0].t).toBe(map.table);
  });

  it('every kind of record is lockable or says why not', () => {
    const undecided = Object.keys(ENTITY_COLUMNS).filter((k) => !LOCKABLE.includes(k) && !(k in NOT_LOCKABLE));
    expect(undecided).toEqual([]);
  });

  it('has the guard on every lockable table', async () => {
    const tables = LOCKABLE.map((k) => ENTITY_COLUMNS[k as keyof typeof ENTITY_COLUMNS]!.table);
    const r = await admin.query<{ t: string }>(
      `select c.relname as t from pg_trigger g join pg_class c on c.oid = g.tgrelid where g.tgname = 'zz_integration_lock_guard' and not g.tgisinternal`,
    );
    expect(r.rows.map((x) => x.t).sort()).toEqual([...tables].sort());
  });
});
