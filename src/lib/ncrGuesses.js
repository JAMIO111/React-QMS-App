/**
 * Guesses for NC actions sent through `useNcrMutation` as `{ path, body, guess }`: each returns `(data, queryKey) => newData` for the cached NC data,
 * so the screen changes before the server answers (a refusal puts it back and is told in a toast; the refetch after every action corrects the rest,
 * such as whether containment is resolved or the cost totals).
 */
import { updateById } from "./optimistic";

const now = () => new Date().toISOString();
const hasKey = (queryKey, part, id) => Array.isArray(queryKey) && queryKey.includes(part) && (id === undefined || queryKey.includes(id));

/** A containment action marked done with what was done (and the quantity contained, when given). */
export const containmentDone = (id, { note, quantityContained } = {}, by) => (data) =>
  updateById(data, id, (a) => ({ ...a, status: "done", doneNote: note ?? null, doneAt: now(), doneBy: by ?? a.doneBy ?? null, ...(quantityContained !== undefined ? { quantityContained } : {}) }));

export const containmentCancel = (id, reason) => (data) => updateById(data, id, (a) => ({ ...a, status: "cancelled", cancelReason: reason ?? null }));

export const containmentReopen = (id) => (data) =>
  updateById(data, id, (a) => ({ ...a, status: "open", doneNote: null, doneAt: null, doneBy: null, cancelReason: null }));

/** The NC's "no containment needed because…" (null clears it), on its containment query only. */
export const containmentReason = (ncrId, reason) => (data, queryKey) =>
  hasKey(queryKey, "containment", ncrId) && data && typeof data === "object" && "notNeededReason" in data ? { ...data, notNeededReason: reason ?? null } : data;

export const lotRemove = (id, reason, by) => (data) => updateById(data, id, (a) => ({ ...a, removedAt: now(), removedReason: reason ?? null, removedBy: by ?? a.removedBy ?? null }));

export const lotRestore = (id) => (data) => updateById(data, id, (a) => ({ ...a, removedAt: null, removedReason: null, removedBy: null }));

export const dispositionCancel = (id, reason, by) => (data) =>
  updateById(data, id, (x) => ({ ...x, status: "cancelled", cancelReason: reason ?? null, cancelledAt: now(), cancelledBy: by ?? x.cancelledBy ?? null }));

/** A cost line deleted: gone from the lists without deleted lines, marked deleted where they are shown. */
export const costDelete = (id, reason) => (data, queryKey) => {
  const showsDeleted = Array.isArray(queryKey) && queryKey.includes("include");
  return showsDeleted ? updateById(data, id, (c) => ({ ...c, deletedAt: now(), deleteReason: reason ?? null })) : updateById(data, id, (c) => c, { remove: true });
};

export const costRestore = (id) => (data) => updateById(data, id, (c) => ({ ...c, deletedAt: null, deleteReason: null }));

/** A deleted NC brought back into the register. */
export const ncrRestore = (id) => (data) => updateById(data, id, (n) => ("deletedAt" in n ? { ...n, deletedAt: null, deleteReason: null, deletedBy: null } : n));

/** An NC deleted (soft, with a reason): gone from register pages that hide deleted records, marked deleted everywhere else. */
export const ncrDelete = (id, reason) => (data, queryKey) => {
  const list = Array.isArray(queryKey) && queryKey.includes("list");
  const params = list ? queryKey[queryKey.length - 1] : null;
  const showsDeleted = params && typeof params === "object" && params.deleted && params.deleted !== "exclude";
  if (list && !showsDeleted) {
    const next = updateById(data, id, (n) => n, { remove: true });
    return next !== data && typeof next?.total === "number" ? { ...next, total: next.total - 1 } : next;
  }
  return updateById(data, id, (n) => ("deletedAt" in n ? { ...n, deletedAt: new Date().toISOString(), deleteReason: reason ?? null } : n));
};
