/**
 * Guesses for the `{ path, method, body }` mutation hooks (calibration, process control, master data): the screen changes before the server answers
 * and goes back if the request fails (see "Optimistic UI" in CLAUDE.md). A request may carry its own `guess(data, queryKey) → data` (and `guessKey`, the
 * cache prefix it walks); otherwise a flat `PATCH /things/<uuid>` changes that record's fields wherever it is cached and a `DELETE /things/<uuid>` drops it.
 * Whatever the server works out (joined names, stamps, numbers) arrives with its answer and the refetch.
 */
import { guessCache, optimisticTarget, rollbackGuess, updateById } from "./optimistic";

const isPrimitive = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);

/**
 * `obj` with the fields of a flat body it already has: same kind of value, or a value set or cleared (null). The version (`rowVersion`) is the server's
 * to change, so it is left alone.
 */
export const patchFields = (obj, body) => {
  if (!obj || typeof obj !== "object" || !body) return obj;
  let changed = false;
  const out = { ...obj };
  for (const [k, v] of Object.entries(body)) {
    if (k === "rowVersion" || v === undefined || !(k in obj) || !isPrimitive(v) || !isPrimitive(obj[k])) continue;
    if (obj[k] !== null && v !== null && typeof obj[k] !== typeof v) continue;
    if (obj[k] !== v) {
      out[k] = v;
      changed = true;
    }
  }
  return changed ? out : obj;
};

/** The guess for a request without its own: a flat PATCH changes the record's fields, a DELETE removes it. `null` when there is nothing to guess. */
export const defaultGuess = (request) => {
  const target = optimisticTarget(request);
  if (!target) return null;
  if (target.remove) return (data) => updateById(data, target.id, (o) => o, { remove: true });
  return (data) => updateById(data, target.id, (o) => patchFields(o, request.body));
};

/** `onMutate` / `onError` for a `{ path, method, body, guess?, guessKey? }` mutation hook whose data lives under `rootKey`. */
export const requestGuessHandlers = (queryClient, rootKey) => ({
  onMutate: async (request) => {
    const guess = typeof request?.guess === "function" ? request.guess : defaultGuess(request);
    if (!guess) return { optimistic: false };
    return guessCache(queryClient, request.guessKey ?? rootKey, guess);
  },
  onError: (_error, _request, context) => rollbackGuess(queryClient, context),
});

/** A guess that changes every cached object with `id` through `change(object)`. */
export const changeRecord = (id, change) => (data) => updateById(data, id, change);

/** A guess that adds `item` to the array `listKey` of every cached object with id `ownerId` (at the end, or the start with `first`). */
export const addToList = (ownerId, listKey, item, { first = false } = {}) =>
  changeRecord(ownerId, (o) => (Array.isArray(o[listKey]) ? { ...o, [listKey]: first ? [item, ...o[listKey]] : [...o[listKey], item] } : o));

/**
 * A guess that adds `row` to cached lists (`{ data: [...] }`, or keyset pages `{ pages: [{ data }] }` on the first page) whose query key holds every
 * part of `keyParts`. With `first` it goes at the top.
 */
export const appendRow = (keyParts, row, { first = false } = {}) => (data, queryKey) => {
  if (!Array.isArray(queryKey) || !keyParts.every((p) => queryKey.includes(p))) return data;
  const add = (list) => (first ? [row, ...list] : [...list, row]);
  if (Array.isArray(data?.data)) return { ...data, data: add(data.data), ...(typeof data.total === "number" ? { total: data.total + 1 } : {}) };
  if (Array.isArray(data?.pages) && Array.isArray(data.pages[0]?.data)) return { ...data, pages: [{ ...data.pages[0], data: add(data.pages[0].data) }, ...data.pages.slice(1)] };
  return data;
};

/** A guess that drops every cached object with `id`. */
export const removeRecord = (id) => (data) => updateById(data, id, (o) => o, { remove: true });

/** Which deleted records a cached list shows ("exclude" | "include" | "only"), from its query key; `null` when the key does not say. */
export const deletedFilterOf = (queryKey = []) => {
  for (const part of queryKey) {
    if (part && typeof part === "object" && !Array.isArray(part) && "deleted" in part) return part.deleted || "exclude";
    if (part === "exclude" || part === "include" || part === "only") return part;
  }
  return null;
};

/**
 * A guess for a soft delete (`deletedAt` = when) or a restore (`deletedAt` = null): the record leaves lists that no longer show it (a deleted one leaves
 * lists without deleted records, a restored one leaves "deleted only" lists) and shows its new state everywhere else.
 */
export const softDelete = (id, deletedAt) => (data, queryKey) => {
  const filter = deletedFilterOf(queryKey ?? []);
  const leaves = (filter === "exclude" && !!deletedAt) || (filter === "only" && !deletedAt);
  const next = updateById(data, id, (o) => ({ ...o, deletedAt }), { remove: leaves });
  if (leaves && next !== data && typeof data?.total === "number") return { ...next, total: Math.max(0, data.total - 1) };
  return next;
};

/** Run several guesses one after the other. */
export const guesses = (...list) => (data, queryKey) => list.filter(Boolean).reduce((d, g) => g(d, queryKey), data);

/** The signed-in person's name as cached by `/me` (for "acknowledged by …" shown before the server answers), else "You". */
export const myName = (queryClient) => {
  for (const [, data] of queryClient.getQueriesData({ queryKey: ["api", "me"] })) {
    const p = data?.profile;
    const name = [p?.firstName, p?.surname].filter(Boolean).join(" ") || p?.fullName || p?.name;
    if (name) return name;
  }
  return "You";
};
