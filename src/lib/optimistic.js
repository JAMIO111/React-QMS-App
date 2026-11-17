/**
 * Optimistic updates for the API mutation hooks. A `PATCH /things/<uuid>` with a flat body is applied
 * straight away to every cached object with that id (lists, pages and details), so toggles and simple
 * edits feel instant; a `DELETE /things/<uuid>` drops that item from every cached list. Only keys the cached object already has, with the same primitive type, are
 * changed — anything the server works out (stamps, numbers, joined names) arrives with the refetch.
 * If the request fails the previous cache is put back.
 */
import { refreshOrganisation } from "./refresh";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isPrimitive = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);

/** { id, remove } for a simple optimistic candidate (flat PATCH, or DELETE of one uuid), else null. */
export const optimisticTarget = ({ path, method, body } = {}) => {
  const id = String(path).split("?")[0].split("/").filter(Boolean).pop();
  if (!UUID.test(id ?? "")) return null;
  if (method === "DELETE") return { id, remove: true };
  if (method !== "PATCH" || !body || typeof body !== "object" || Array.isArray(body)) return null;
  return Object.values(body).every(isPrimitive) ? { id, remove: false } : null;
};

const patchTree = (node, { id, remove }, body) => {
  if (Array.isArray(node)) {
    const kept = remove ? node.filter((item) => !(item && typeof item === "object" && item.id === id)) : node;
    let changed = kept.length !== node.length;
    const next = kept.map((item) => {
      const patched = patchTree(item, { id, remove }, body);
      if (patched !== item) changed = true;
      return patched;
    });
    return changed ? next : node;
  }
  if (!node || typeof node !== "object") return node;
  let changed = false;
  const next = {};
  for (const [k, v] of Object.entries(node)) {
    const patched = patchTree(v, { id, remove }, body);
    if (patched !== v) changed = true;
    next[k] = patched;
  }
  if (!remove && node.id === id) {
    for (const [k, v] of Object.entries(body)) {
      if (k in node && v !== undefined && typeof node[k] === typeof v && node[k] !== v) {
        next[k] = v;
        changed = true;
      }
    }
  }
  return changed ? next : node;
};

/**
 * Mutation options (`onMutate`, `onError`) for a hook whose request is { path, method, body }.
 * `onMutate` returns { optimistic: true } when something was patched, so `onSuccess` can skip waiting
 * for the refetch (see `settle`).
 */
export const optimisticHandlers = (queryClient, rootKey) => ({
  onMutate: async (request) => {
    const target = optimisticTarget(request);
    if (!target) return { optimistic: false };
    await queryClient.cancelQueries({ queryKey: rootKey });
    const snapshot = [];
    for (const [queryKey, data] of queryClient.getQueriesData({ queryKey: rootKey })) {
      if (data === undefined) continue;
      const patched = patchTree(data, target, request.body);
      if (patched !== data) {
        snapshot.push([queryKey, data]);
        queryClient.setQueryData(queryKey, patched);
      }
    }
    return { optimistic: snapshot.length > 0, snapshot };
  },
  onError: (_error, _request, context) => {
    // The refetch in onSettled would also repair this, but rolling back first avoids a flash.
    context?.snapshot?.forEach(([queryKey, data]) => queryClient.setQueryData(queryKey, data));
  },
});

/**
 * Refetch after a mutation; waits for it only when the screen was not already updated optimistically. Refreshes the whole
 * organisation's data, not just `rootKey` (see lib/refresh.js): other modules show what this action changed.
 */
export const settle = (queryClient, organisationId, context, options) => {
  const refetch = refreshOrganisation(queryClient, organisationId, options);
  return context?.optimistic ? undefined : refetch;
};

// ---------------------------------------------------------------------------------------------------------------------------------------
// Guesses: change the cached data straight away, put it back if the request fails.
// ---------------------------------------------------------------------------------------------------------------------------------------

let pendingCounter = 0;
/** An id for a row shown before the server has made it. Rows with such an id offer no actions (a click would send the placeholder). */
export const pendingId = () => `pending-${Date.now().toString(36)}-${(pendingCounter += 1)}`;
export const isPending = (id) => typeof id === "string" && id.startsWith("pending-");

/**
 * Apply `update(data, queryKey)` to every cached query under `prefix` (default: everything the API cached). `update` returns the new data,
 * or the same object to leave it. Returns `{ optimistic, snapshot }` for `rollbackGuess` (use it as the mutation's context).
 */
export const guessCache = async (queryClient, prefix, update) => {
  const key = prefix ?? ["api"];
  await queryClient.cancelQueries({ queryKey: key });
  const snapshot = [];
  for (const [queryKey, data] of queryClient.getQueriesData({ queryKey: key })) {
    if (data === undefined) continue;
    const next = update(data, queryKey);
    if (next !== data && next !== undefined) {
      snapshot.push([queryKey, data]);
      queryClient.setQueryData(queryKey, next);
    }
  }
  return { optimistic: snapshot.length > 0, snapshot };
};

/** Undo a guess (the mutation's `onError`). */
export const rollbackGuess = (queryClient, context) => {
  context?.snapshot?.forEach(([queryKey, data]) => queryClient.setQueryData(queryKey, data));
};

/**
 * Walk any cached data and give every object whose `id` is `id` to `change(object)`, which returns the replacement (or the same object).
 * With `remove: true` such objects are dropped from arrays instead. Unchanged branches keep their identity.
 */
export const updateById = (node, id, change, { remove = false } = {}) => {
  if (Array.isArray(node)) {
    let changed = false;
    const out = [];
    for (const item of node) {
      if (remove && item && typeof item === "object" && item.id === id) {
        changed = true;
        continue;
      }
      const next = updateById(item, id, change, { remove });
      if (next !== item) changed = true;
      out.push(next);
    }
    return changed ? out : node;
  }
  if (!node || typeof node !== "object") return node;
  let changed = false;
  const next = {};
  for (const [k, v] of Object.entries(node)) {
    const n = updateById(v, id, change, { remove });
    if (n !== v) changed = true;
    next[k] = n;
  }
  const base = changed ? next : node;
  if (!remove && node.id === id) return change(base);
  return base;
};

const sameKind = (a, b) =>
  (a === null || ["string", "number", "boolean"].includes(typeof a)) && (b === null || ["string", "number", "boolean"].includes(typeof b))
    ? true
    : Array.isArray(a) === Array.isArray(b) && typeof a === "object" && typeof b === "object";

/**
 * What the server answered, written into every cached copy of that record at once (instead of waiting for the refetch): every cached object
 * with the answer's `id` takes the answer's values for the keys it already has, when the kinds match. A list row keeps its own shape; a detail
 * gets everything. Registered for every mutation in main.jsx; answers without an `id` change nothing.
 */
export const mergeResponse = (queryClient, response, prefix = ["api"]) => {
  if (!response || typeof response !== "object" || Array.isArray(response) || typeof response.id !== "string") return;
  for (const [queryKey, data] of queryClient.getQueriesData({ queryKey: prefix })) {
    if (data === undefined || data === response) continue;
    const next = updateById(data, response.id, (obj) => {
      let changed = false;
      const out = { ...obj };
      for (const [k, v] of Object.entries(response)) {
        if (k in obj && v !== undefined && obj[k] !== v && sameKind(obj[k], v)) {
          out[k] = v;
          changed = true;
        }
      }
      return changed ? out : obj;
    });
    if (next !== data) queryClient.setQueryData(queryKey, next);
  }
};
