/**
 * Optimistic updates for the API mutation hooks. A `PATCH /things/<uuid>` with a flat body is applied
 * straight away to every cached object with that id (lists, pages and details), so toggles and simple
 * edits feel instant; a `DELETE /things/<uuid>` drops that item from every cached list. Only keys the cached object already has, with the same primitive type, are
 * changed — anything the server works out (stamps, numbers, joined names) arrives with the refetch.
 * If the request fails the previous cache is put back.
 */
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

/** Refetch after a mutation; waits for it only when the screen was not already updated optimistically. */
export const settle = (queryClient, rootKey, context) => {
  const refetch = queryClient.invalidateQueries({ queryKey: rootKey });
  return context?.optimistic ? undefined : refetch;
};
