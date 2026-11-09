import { CatalogueField, EntityCatalogue, REF_KIND_WORDS, RefKind } from './catalogue';
import { FieldError, MappingSpec } from './mapping';

/** Looks values up for one kind of record and one way of matching; answers {value: id} for those found ("ambiguous" for a department code used twice). */
export type ReferenceLookup = (kind: RefKind, mode: 'code' | 'source', values: string[]) => Promise<Record<string, string>>;

export interface MappedRecord {
  canonical: Record<string, unknown> | null;
  errors: FieldError[];
}

/**
 * Resolve the reference fields of a page of mapped records (D10), one lookup per field. A resolved reference adds `<key>Id` to the record (a unit adds
 * `<key>Code`); an empty one adds null, so an update can clear it; one that cannot be resolved becomes a row error with the reason. Nothing is guessed:
 * an unknown code never creates a record, and a row with an unresolved reference is rejected before anything is written (in the preview too).
 */
export async function resolveReferences(catalogue: EntityCatalogue, spec: MappingSpec, records: MappedRecord[], lookup: ReferenceLookup): Promise<void> {
  const byKey = new Map(catalogue.fields.map((f) => [f.key, f]));
  for (const m of spec.fields) {
    const field = byKey.get(m.target);
    if (!field?.ref) continue;
    const mode = m.match === 'source' && field.ref.source ? 'source' : 'code';
    const values = [...new Set(records.map((r) => text(r.canonical?.[field.key])).filter((v): v is string => !!v))];
    const found = values.length ? await lookup(field.ref.kind, mode, values) : {};
    for (const r of records) {
      if (!r.canonical || !(field.key in r.canonical)) continue;
      const v = text(r.canonical[field.key]);
      const out = outKey(field);
      if (!v) {
        r.canonical[out] = null;
        continue;
      }
      const id = found[v];
      if (id && id !== 'ambiguous') r.canonical[out] = id;
      else r.errors.push({ field: field.key, message: problem(field, mode, v, id === 'ambiguous') });
    }
  }
}

const text = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
export const outKey = (f: CatalogueField): string => (f.ref?.kind === 'unit' ? `${f.key}Code` : `${f.key}Id`);

function problem(f: CatalogueField, mode: 'code' | 'source', v: string, ambiguous: boolean): string {
  const word = REF_KIND_WORDS[f.ref!.kind];
  if (ambiguous) return `${f.label}: "${v}" is used by more than one ${word}, so it cannot tell which one is meant`;
  if (mode === 'source') return `${f.label}: no ${word} "${v}" has been imported through this connection yet; import the ${word}s first`;
  return `${f.label}: there is no ${word} "${v}" in Fortress`;
}
