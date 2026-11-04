/**
 * Column order helpers for TanStack's columnOrder state (an array of column ids). Ids missing from
 * a saved order (e.g. a column added later) keep their natural position at the end; ids that no
 * longer exist are dropped.
 */

/** `ids` (natural order) arranged by `order`. */
export const applyOrder = (ids, order = []) => {
  const known = new Set(ids);
  const ordered = order.filter((id) => known.has(id));
  const seen = new Set(ordered);
  return [...ordered, ...ids.filter((id) => !seen.has(id))];
};

/** Moves `from` so it sits before (or after) `to`. */
export const moveColumn = (ids, from, to, after = false) => {
  if (from === to || !ids.includes(from) || !ids.includes(to)) return ids;
  const rest = ids.filter((id) => id !== from);
  const at = rest.indexOf(to) + (after ? 1 : 0);
  return [...rest.slice(0, at), from, ...rest.slice(at)];
};

/** Moves `id` one place within `among` (the ids the user can see in the list), up (-1) or down (+1). */
export const shiftColumn = (ids, id, delta, among = ids) => {
  const i = among.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= among.length) return ids;
  return moveColumn(ids, id, among[j], delta > 0);
};
