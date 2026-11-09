import { CatalogueField, EntityCatalogue } from './catalogue';
import { ENTITY_COLUMNS } from './columns';

/** What the database's CHECK constraints say about one column. */
export interface ColumnRule {
  maxLength?: number;
  /** A JavaScript regular expression source equivalent to the column's own pattern (only simple, safe ones are taken over). */
  pattern?: string;
  options?: string[];
  min?: number;
  max?: number;
  minExclusive?: boolean;
}
export type TableRules = Record<string, Record<string, ColumnRule>>;

const COL = '([a-z_][a-z0-9_]*)';
const LEN = new RegExp(`length\\((?:TRIM\\(BOTH FROM ${COL}\\)|btrim\\(${COL}\\)|${COL})\\) <= (\\d+)`, 'g');
const BETWEEN_TEXT = new RegExp(`\\(${COL} ~ '(\\^[^']*\\$)'::text\\)`, 'g');
const ANY = new RegExp(`\\(${COL} = ANY \\(ARRAY\\[([^\\]]*)\\]\\)\\)`, 'g');
const GE = new RegExp(`\\(${COL} >= \\(?(-?\\d+(?:\\.\\d+)?)\\)?(?:::numeric)?\\)`, 'g');
const LE = new RegExp(`\\(${COL} <= \\(?(-?\\d+(?:\\.\\d+)?)\\)?(?:::numeric)?\\)`, 'g');
const GT = new RegExp(`\\(${COL} > \\(?(-?\\d+(?:\\.\\d+)?)\\)?(?:::numeric)?\\)`, 'g');

/** The longest text a simple anchored pattern allows: `^\S(.{0,N}\S)?$` → N+2, `^[..][..]{0,N}$` → N+1; otherwise unknown. */
export function patternMaxLength(pattern: string): number | undefined {
  let m = pattern.match(/^\^\\S\(\.\{0,(\d+)\}\\S\)\?\$$/);
  if (m) return Number(m[1]) + 2;
  m = pattern.match(/^\^\[[^\]]+\]\[[^\]]+\]\{0,(\d+)\}\$$/);
  if (m) return Number(m[1]) + 1;
  m = pattern.match(/^\^\[[^\]]+\]\{(\d+)\}\$$/);
  if (m) return Number(m[1]);
  return undefined;
}

/** A Postgres pattern is taken over only when it means the same in JavaScript (no POSIX classes or back-references). */
const safePattern = (p: string) => !/\[:|\\[0-9]|\(\?/.test(p);

/** Read one CHECK constraint (as pg_get_constraintdef prints it) into rules for the columns it constrains. */
export function parseConstraint(def: string): Record<string, ColumnRule> {
  const out: Record<string, ColumnRule> = {};
  const rule = (c: string) => (out[c] ??= {});
  for (const m of def.matchAll(LEN)) {
    const c = m[1] ?? m[2] ?? m[3];
    rule(c).maxLength = Math.min(rule(c).maxLength ?? Infinity, Number(m[4]));
  }
  for (const m of def.matchAll(BETWEEN_TEXT)) {
    const len = patternMaxLength(m[2]);
    if (len) rule(m[1]).maxLength = Math.min(rule(m[1]).maxLength ?? Infinity, len);
    if (safePattern(m[2])) rule(m[1]).pattern = m[2];
  }
  for (const m of def.matchAll(ANY)) {
    rule(m[1]).options = [...m[2].matchAll(/'((?:[^']|'')*)'::text/g)].map((x) => x[1].replace(/''/g, "'"));
  }
  for (const m of def.matchAll(GE)) rule(m[1]).min = Number(m[2]);
  for (const m of def.matchAll(LE)) rule(m[1]).max = Number(m[2]);
  for (const m of def.matchAll(GT)) Object.assign(rule(m[1]), { min: Number(m[2]), minExclusive: true });
  return out;
}

/** Merge the rules of every constraint of a table. */
export function tableRules(defs: string[]): Record<string, ColumnRule> {
  const out: Record<string, ColumnRule> = {};
  for (const def of defs) {
    for (const [c, r] of Object.entries(parseConstraint(def))) {
      const cur = (out[c] ??= {});
      if (r.maxLength !== undefined) cur.maxLength = Math.min(cur.maxLength ?? Infinity, r.maxLength);
      if (r.pattern) cur.pattern = r.pattern;
      if (r.options) cur.options = r.options;
      if (r.min !== undefined) Object.assign(cur, { min: r.min, minExclusive: r.minExclusive });
      if (r.max !== undefined) cur.max = r.max;
    }
  }
  return out;
}

const words = (v: string) => v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * The catalogue as the database says it is today: each field that fills a column takes the column's length limit, its pattern, its allowed values (labels
 * kept where the catalogue names them, else made from the value) and its numeric bounds. Which fields are offered, their labels and whether they are
 * required stay as written in the catalogue. Reference fields keep their own limits (the code is looked up, not stored).
 */
export function applyRules(catalogue: EntityCatalogue, rules: TableRules): EntityCatalogue {
  const map = ENTITY_COLUMNS[catalogue.entityType];
  if (!map) return catalogue;
  const fields = catalogue.fields.map((f): CatalogueField => {
    const target = map.fields[f.key];
    if (!target || f.ref) return f;
    const r = rules[target.table ?? map.table]?.[target.column];
    if (!r) return f;
    const next: CatalogueField = { ...f };
    if (r.maxLength !== undefined && ['text', 'email', 'url'].includes(f.type)) next.maxLength = r.maxLength;
    if (r.pattern && f.type === 'text') next.pattern = r.pattern;
    if (r.options && f.type === 'enum') {
      const labels = new Map((f.options ?? []).map((o) => [o.value, o.label]));
      next.options = r.options.map((v) => ({ value: v, label: labels.get(v) ?? words(v) }));
    }
    if (f.type === 'number' || f.type === 'integer') {
      if (r.min !== undefined) Object.assign(next, { min: r.min, minExclusive: !!r.minExclusive });
      if (r.max !== undefined) next.max = r.max;
    }
    return next;
  });
  return { ...catalogue, fields };
}

/** Every table the catalogue writes to. */
export const CATALOGUE_TABLES = [...new Set(Object.values(ENTITY_COLUMNS).flatMap((m) => [m!.table, ...Object.values(m!.fields).map((f) => f.table).filter((t): t is string => !!t)]))];
