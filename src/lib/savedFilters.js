/** Saved filters: a person's own named filters for a register (up to five each), kept by the API. */

/** The register's scope name in the API. */
export const NC_SCOPE = "ncr_register";
export const SAVED_FILTER_LIMIT = 5;

/** A comma list in a canonical order, so "open,closed" and "closed,open" are the same filter. */
const norm = (v) =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()
    .join(",");

/** The keys that decide what a filter shows (the "…Label" keys only name a chosen record for the chips). */
const decisive = (keys) => keys.filter((k) => !k.endsWith("Label"));

/** Only the filters that are set, as a flat object of text. */
export const cleanFilters = (values, keys) => Object.fromEntries(keys.filter((k) => values?.[k] !== undefined && values?.[k] !== null && String(values[k]) !== "").map((k) => [k, String(values[k])]));

/** Do two sets of filters show the same records? */
export const sameFilters = (a, b, keys) => decisive(keys).every((k) => norm(a?.[k]) === norm(b?.[k]));

/** Are any filters set? */
export const hasFilters = (values, keys) => decisive(keys).some((k) => norm(values?.[k]) !== "");

/** Every filter key set to its saved value, or to empty: applying a saved filter replaces what was chosen. */
export const toFilterValues = (saved, keys) => Object.fromEntries(keys.map((k) => [k, saved?.filters?.[k] ?? ""]));
