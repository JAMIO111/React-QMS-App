/**
 * Comparing two revisions of an FMEA (or a revision with the base it was copied from, or the base as it is now). Pure: it works on rows that carry their lineage.
 *
 * Every analysis row has `prevRowId`, the row it continues from the previous revision. To match a row of the newer revision with one of the older revision, the chain is
 * followed back (through any revisions in between) until it lands on a row of the older revision. A new row whose chain never lands there is *added*; an old row that
 * no new row continues is *removed*; one that is continued with different words or ratings is *changed*, naming each field. Nothing is guessed from the wording.
 */
export type NodeKind = 'item' | 'function' | 'failure_mode' | 'effect' | 'cause';

export interface CompareRow {
  id: string;
  kind: NodeKind;
  revisionId: string;
  prevRowId: string | null;
  /** The row this one hangs under (item → parent item; function → item; failure mode → function; effect and cause → failure mode). */
  parentId: string | null;
  /** The words and ratings shown, keyed by the field's name. */
  fields: Record<string, string | number | null>;
}

export interface FieldChange {
  field: string;
  from: string | number | null;
  to: string | number | null;
}

export interface CompareChange {
  kind: NodeKind;
  change: 'added' | 'removed' | 'changed';
  /** The row in the revision where it exists (the newer one for added and changed, the older one for removed). */
  rowId: string;
  /** Where it sits: "Bracket › Hold the bore › Bore oversize". */
  path: string[];
  /** What it is called: its name or words. */
  label: string;
  fields: FieldChange[];
}

export interface CompareResult {
  changes: CompareChange[];
  counts: { added: number; removed: number; changed: number; same: number };
}

/** The field that names a row of each kind. */
const LABEL: Record<NodeKind, string> = { item: 'name', function: 'text', failure_mode: 'text', effect: 'text', cause: 'text' };
const KIND_ORDER: NodeKind[] = ['item', 'function', 'failure_mode', 'effect', 'cause'];

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
const labelOf = (row: CompareRow) => String(row.fields[LABEL[row.kind]] ?? '');

/** The ancestors of a row's chain that belong to the revision `target`: the one older row it continues, when there is one. */
function ancestorIn(row: CompareRow, byId: Map<string, CompareRow>, target: string): CompareRow | null {
  const seen = new Set<string>();
  let at: CompareRow | undefined = row;
  while (at && at.prevRowId && !seen.has(at.id)) {
    seen.add(at.id);
    at = byId.get(at.prevRowId);
    if (at && at.revisionId === target) return at;
  }
  return null;
}

function pathOf(row: CompareRow, byId: Map<string, CompareRow>): string[] {
  const out: string[] = [];
  let at = row.parentId ? byId.get(row.parentId) : undefined;
  const seen = new Set<string>();
  while (at && !seen.has(at.id)) {
    seen.add(at.id);
    out.unshift(labelOf(at));
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return out;
}

/**
 * @param rows every row of the revisions involved and of any revisions between them (so a chain can be followed)
 * @param olderId the revision being compared from
 * @param newerId the revision being compared to
 */
export function compareRevisions(rows: CompareRow[], olderId: string, newerId: string): CompareResult {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const older = rows.filter((r) => r.revisionId === olderId);
  const newer = rows.filter((r) => r.revisionId === newerId);
  const changes: CompareChange[] = [];
  const continued = new Set<string>();
  let unchanged = 0;

  for (const row of newer) {
    const was = ancestorIn(row, byId, olderId);
    if (!was || was.kind !== row.kind || continued.has(was.id)) {
      changes.push({ kind: row.kind, change: 'added', rowId: row.id, path: pathOf(row, byId), label: labelOf(row), fields: [] });
      continue;
    }
    continued.add(was.id);
    const fields: FieldChange[] = [];
    for (const key of new Set([...Object.keys(was.fields), ...Object.keys(row.fields)])) {
      if (!same(was.fields[key], row.fields[key])) fields.push({ field: key, from: was.fields[key] ?? null, to: row.fields[key] ?? null });
    }
    if (fields.length === 0) unchanged += 1;
    else changes.push({ kind: row.kind, change: 'changed', rowId: row.id, path: pathOf(row, byId), label: labelOf(row), fields });
  }
  for (const row of older) {
    if (!continued.has(row.id)) changes.push({ kind: row.kind, change: 'removed', rowId: row.id, path: pathOf(row, byId), label: labelOf(row), fields: [] });
  }

  const order = (c: CompareChange) => KIND_ORDER.indexOf(c.kind);
  changes.sort((a, b) => a.path.join('›').localeCompare(b.path.join('›')) || order(a) - order(b) || a.label.localeCompare(b.label));
  return {
    changes,
    counts: {
      added: changes.filter((c) => c.change === 'added').length,
      removed: changes.filter((c) => c.change === 'removed').length,
      changed: changes.filter((c) => c.change === 'changed').length,
      same: unchanged,
    },
  };
}
