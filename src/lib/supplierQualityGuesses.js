/**
 * What the screen shows straight after a supplier quality, purchasing, incoming inspection or material certificate action, before the server answers
 * (docs: CLAUDE.md "Optimistic UI"). Each `guess…(data, vars)` takes one cached query's data and the mutation's variables and returns the data as it will
 * be, or the same object when it does not apply. The server's answer (merged by `mergeResponse`) and the refetch replace the guess; a refusal puts the
 * old data back (`rollbackGuess`). Only what can be known from the request is guessed: scores, numbers, stamps and names the server works out are left.
 */
import { describeApiError } from "./api-client";
import { guessCache, pendingId, rollbackGuess, updateById } from "./optimistic";
import { refreshOrganisation } from "./refresh";

/**
 * Mutation options that show an action at once: `guess(data, vars, queryKey)` is applied to every cached query of the organisation for the
 * actions in `actions`; a refusal puts the old data back and says why in a toast (the dialog is already closed). Every action refreshes the organisation.
 */
export const guessed = (queryClient, organisationId, toast, actions, guess) => ({
  onMutate: (vars) => (actions.has(vars.action) ? guessCache(queryClient, ["api", "org", organisationId], (data, queryKey) => guess(data, vars, queryKey)) : undefined),
  onError: (error, vars, context) => {
    rollbackGuess(queryClient, context);
    if (actions.has(vars.action)) toast?.showToast({ type: "error", title: "Not saved", message: describeApiError(error) });
  },
  onSettled: () => refreshOrganisation(queryClient, organisationId),
});

const now = () => new Date().toISOString();
const isPrimitive = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);

/** `row` with the flat values of `body` for keys it already has (never `rowVersion`). Nested values and new keys wait for the server. */
export const mergeFlat = (row, body = {}) => {
  let changed = false;
  const next = { ...row };
  for (const [k, v] of Object.entries(body ?? {})) {
    if (k === "rowVersion" || v === undefined || !(k in row) || !isPrimitive(v) || !isPrimitive(row[k]) || row[k] === v) continue;
    next[k] = v;
    changed = true;
  }
  return changed ? next : row;
};

/** Walk any cached data and give every object for which `test(object)` holds to `change(object)`. Unchanged branches keep their identity. */
export const mapWhere = (node, test, change) => {
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((item) => {
      const n = mapWhere(item, test, change);
      if (n !== item) changed = true;
      return n;
    });
    return changed ? out : node;
  }
  if (!node || typeof node !== "object") return node;
  let changed = false;
  const next = {};
  for (const [k, v] of Object.entries(node)) {
    const n = mapWhere(v, test, change);
    if (n !== v) changed = true;
    next[k] = n;
  }
  const base = changed ? next : node;
  return test(node) ? change(base) : base;
};

/** A picked part as the lists show it: pickers give "PN · Name" as the option's name. */
export const partFromOption = (id, item) => {
  if (!id) return null;
  const [partNumber, ...rest] = String(item?.name ?? "…").split(" · ");
  return { id, partNumber, name: rest.join(" · ") };
};

const withKey = (key, change) => (row) => (key in row ? change(row) : row);

// ---- suppliers (useSupplierMutation) -------------------------------------------------------------------------------------------------------

/** Actions of useSupplierMutation shown before the server answers. */
export const SUPPLIER_OPTIMISTIC = new Set(["update", "status", "classifications", "addContact", "updateContact", "addProduct", "updateProduct", "createClassification", "updateClassification"]);

export const guessSupplier = (data, { action, id, body = {}, show = {} } = {}, queryKey = []) => {
  switch (action) {
    case "update":
      return updateById(data, id, (row) => {
        const merged = mergeFlat(row, body);
        return show.classifications && Array.isArray(row.classifications) ? { ...merged, classifications: show.classifications } : merged;
      });
    case "status":
      return updateById(data, id, withKey("approvalStatus", (row) => ({
        ...row,
        approvalStatus: body.status,
        ...("conditions" in row ? { conditions: body.conditions ?? null } : {}),
        ...("reviewOn" in row ? { reviewOn: body.reviewOn ?? null } : {}),
        ...("approvalStatusChangedAt" in row ? { approvalStatusChangedAt: now() } : {}),
      })));
    case "classifications":
      return updateById(data, id, (row) => {
        if (!Array.isArray(row.classifications)) return row;
        const ids = body.classificationIds ?? [];
        return { ...row, classifications: show.classifications ?? row.classifications.filter((c) => ids.includes(c.id)) };
      });
    case "addContact":
      return updateById(data, id, (row) => {
        if (!Array.isArray(row.contacts)) return row;
        const others = body.isPrimary ? row.contacts.map((c) => (c.isPrimary ? { ...c, isPrimary: false } : c)) : row.contacts;
        return { ...row, contacts: [...others, { id: pendingId(), active: true, isPrimary: false, jobTitle: null, role: "other", email: null, phone: null, notes: null, ...body }] };
      });
    case "updateContact":
      return mapWhere(
        data,
        (o) => Array.isArray(o.contacts) && o.contacts.some((c) => c?.id === id),
        (o) => ({ ...o, contacts: o.contacts.map((c) => (c.id === id ? mergeFlat(c, body) : body.isPrimary && c.isPrimary ? { ...c, isPrimary: false } : c)) }),
      );
    case "addProduct":
      return updateById(data, id, (row) => {
        if (!Array.isArray(row.products)) return row;
        const product = { id: pendingId(), kind: body.kind, part: body.partId ? (show.part ?? { id: body.partId, partNumber: "…", name: "" }) : null, description: body.description ?? null, supplierPartNumber: body.supplierPartNumber ?? null, notes: body.notes ?? null, active: true };
        return { ...row, products: [...row.products, product] };
      });
    case "updateProduct":
    case "updateClassification":
      return updateById(data, id, (row) => mergeFlat(row, body));
    case "createClassification":
      if (!queryKey.includes("classifications") || !Array.isArray(data?.data)) return data;
      return { ...data, data: [...data.data, { id: pendingId(), key: null, label: body.label, description: body.description ?? null, active: true, suppliers: 0 }] };
    default:
      return data;
  }
};

// ---- assessments (useAssessmentMutation) ---------------------------------------------------------------------------------------------------

export const ASSESSMENT_OPTIMISTIC = new Set(["updateTemplate", "completeAssessment", "abandonAssessment"]);

export const guessAssessment = (data, { action, id, body = {}, show = {} } = {}) => {
  switch (action) {
    case "updateTemplate":
      return updateById(data, id, (row) => mergeFlat(row, body));
    case "completeAssessment":
      return updateById(data, id, (row) =>
        row.status !== "in_progress"
          ? row
          : { ...row, status: "completed", score: show.score ?? row.progress?.score ?? row.score ?? null, result: show.result ?? row.progress?.result ?? row.result ?? null, summary: body.summary ?? null, completedAt: now() },
      );
    case "abandonAssessment":
      return updateById(data, id, (row) => (row.status !== "in_progress" ? row : { ...row, status: "abandoned", abandonReason: body.reason ?? null }));
    default:
      return data;
  }
};

// ---- SCARs (useScarMutation) ---------------------------------------------------------------------------------------------------------------

/** Not guessed: create (the page opens the new SCAR), verify and decideExtension (decisions by someone with approval rights, never the requester). */
export const SCAR_OPTIMISTIC = new Set(["update", "issue", "acknowledge", "respond", "startReview", "review", "implement", "extend", "cancel", "linkNcr", "unlinkNcr", "addItem", "removeItem", "withdrawExtension"]);

const isScar = (row) => typeof row.status === "string" && "responseDueOn" in row;
const scarById = (data, id, change) => updateById(data, id, (row) => (isScar(row) ? change(row) : row));

export const guessScar = (data, { action, id, body = {}, show = {} } = {}) => {
  switch (action) {
    case "update":
      return scarById(data, id, (row) => {
        const next = mergeFlat(row, body);
        return {
          ...next,
          ...(show.owner !== undefined && "owner" in row ? { owner: show.owner } : {}),
          ...(show.contact !== undefined && "contact" in row ? { contact: show.contact } : {}),
        };
      });
    case "issue":
      return scarById(data, id, (row) => (row.status === "draft" ? { ...row, status: "issued", issuedAt: now() } : row));
    case "acknowledge":
      return scarById(data, id, (row) => ({ ...row, status: "acknowledged", acknowledgedAt: now(), acknowledgedNote: body.note ?? null }));
    case "startReview":
      return scarById(data, id, (row) => ({ ...row, status: "under_review" }));
    case "review":
      return scarById(data, id, (row) => {
        const responses = Array.isArray(row.responses) && row.responses.length
          ? row.responses.map((r, i, all) => (i === all.length - 1 ? { ...r, review: { decision: body.decision, note: body.note, reviewedAt: now(), reviewedBy: null } } : r))
          : row.responses;
        return { ...row, status: body.decision, ...(responses ? { responses } : {}) };
      });
    case "respond":
      return scarById(data, id, (row) => ({
        ...row,
        status: "response_received",
        ...("overdue" in row ? { overdue: false } : {}),
        ...(Array.isArray(row.responses)
          ? { responses: [...row.responses, { id: pendingId(), seq: row.responses.length + 1, rootCause: null, containment: null, correctiveAction: null, preventiveAction: null, plannedCompletionOn: null, respondedByName: null, extentOfCondition: null, escapePoint: null, responsibleName: null, rootCauseMethod: null, ...body, receivedAt: now(), receivedBy: null, review: null }] }
          : {}),
      }));
    case "implement":
      return scarById(data, id, (row) => ({
        ...row,
        status: row.status === "accepted" ? "verifying" : row.status,
        ...(Array.isArray(row.implementations) ? { implementations: [...row.implementations, { id: pendingId(), evidenceNote: null, ...body, recordedAt: now(), recordedBy: null }] } : {}),
      }));
    case "extend":
      return scarById(data, id, (row) =>
        Array.isArray(row.extensions)
          ? { ...row, extensions: [...row.extensions, { id: pendingId(), previousDueOn: row.responseDueOn, newDueOn: body.newDueOn, reason: body.reason, status: "pending", extendedAt: now(), extendedBy: null, canDecide: false }] }
          : row,
      );
    case "cancel":
      return scarById(data, id, (row) => ({ ...row, status: "cancelled", cancelReason: body.reason ?? null, cancelledAt: now() }));
    case "addItem":
      return scarById(data, id, (row) =>
        Array.isArray(row.items)
          ? {
              ...row,
              items: [...row.items, {
                id: pendingId(),
                part: body.partId ? (show.part ?? { id: body.partId, partNumber: "…", name: "" }) : null,
                lot: body.lotId ? (show.lot ?? { id: body.lotId, lotNumber: "…" }) : null,
                material: body.material ?? null,
                receiptReference: body.receiptReference ?? null,
                quantity: body.quantity ?? null,
                notes: body.notes ?? null,
                endedAt: null,
              }],
            }
          : row,
      );
    case "removeItem":
      return mapWhere(
        data,
        (o) => Array.isArray(o.items) && o.items.some((i) => i?.id === id),
        (o) => ({ ...o, items: o.items.map((i) => (i.id === id ? { ...i, endedAt: now(), endReason: body.reason ?? null } : i)) }),
      );
    case "linkNcr":
      return scarById(data, id, (row) =>
        Array.isArray(row.ncrs)
          ? { ...row, ncrs: [...row.ncrs, { linkId: pendingId(), ncr: show.ncr ?? { id: body.ncrId, reference: "…", title: "", stage: "open" }, endedAt: null }] }
          : row,
      );
    case "unlinkNcr":
      return mapWhere(
        data,
        (o) => Array.isArray(o.ncrs) && o.ncrs.some((n) => n?.linkId === id),
        (o) => ({ ...o, ncrs: o.ncrs.map((n) => (n.linkId === id ? { ...n, endedAt: now(), endReason: body.reason ?? null } : n)) }),
      );
    case "withdrawExtension":
      return updateById(data, id, (row) => (row.status === "pending" ? { ...row, status: "withdrawn", decidedAt: now(), decisionNote: body.reason ?? null } : row));
    default:
      return data;
  }
};

// ---- purchase orders and receipts (useReceivingMutation) -----------------------------------------------------------------------------------

/** Not guessed: createOrder (the new order's page needs its id) and recordReceipt (the server makes lots and inspection decisions). */
export const RECEIVING_OPTIMISTIC = new Set(["closeOrder", "cancelOrder", "agreedDate", "cancelReceipt"]);

export const guessReceiving = (data, { action, id, body = {} } = {}) => {
  switch (action) {
    case "closeOrder":
      return updateById(data, id, withKey("status", (row) =>
        row.status === "open"
          ? { ...row, status: "closed", closedAt: now(), ...("lateLines" in row ? { lateLines: 0 } : {}), ...(Array.isArray(row.lines) ? { lines: row.lines.map((l) => (l.status === "open" ? { ...l, status: "closed" } : l)) } : {}) }
          : row,
      ));
    case "cancelOrder":
      return updateById(data, id, withKey("status", (row) => ({
        ...row,
        status: "cancelled",
        cancelReason: body.reason ?? null,
        ...("lateLines" in row ? { lateLines: 0 } : {}),
        ...(Array.isArray(row.lines) ? { lines: row.lines.map((l) => (l.status === "open" ? { ...l, status: "cancelled" } : l)) } : {}),
      })));
    case "agreedDate":
      return updateById(data, id, withKey("agreedOn", (row) => ({ ...row, agreedOn: body.agreedOn ?? null })));
    case "cancelReceipt":
      return updateById(data, id, withKey("status", (row) => ({ ...row, status: "cancelled", cancelReason: body.reason ?? null, cancelledAt: now() })));
    default:
      return data;
  }
};

// ---- incoming inspection (useIncomingMutation) ---------------------------------------------------------------------------------------------

/** Not guessed: createRequirement, approveRequirement (someone else approves), startInspection and raiseNcr (the next screen needs the new record), disposition (rights and the lot's hold decide). */
export const INCOMING_OPTIMISTIC = new Set(["updateRequirement", "retireRequirement", "linkNcr", "unlinkNcr"]);

export const guessIncoming = (data, { action, id, body = {}, show = {} } = {}, queryKey = []) => {
  switch (action) {
    case "updateRequirement":
      return updateById(data, id, (row) => mergeFlat(row, body));
    case "retireRequirement":
      return updateById(data, id, withKey("status", (row) => ({ ...row, status: "retired" })));
    case "linkNcr": {
      // The NC's receipt source: { items: [...] } under ["…", "incoming", "ncr-source", <ncr id>].
      if (!queryKey.includes("ncr-source") || queryKey[queryKey.length - 1] !== id || !Array.isArray(data?.items)) return data;
      const l = show.line ?? { id: body.receiptLineId };
      return { ...data, items: [...data.items, { linkId: pendingId(), lineId: l.id, receiptId: l.receiptId ?? null, reference: l.reference ?? "…", lineNumber: l.lineNumber ?? null, receivedOn: l.receivedOn ?? null, deliveryNote: l.deliveryNote ?? null, lotNumber: l.lotNumber ?? null, quantityReceived: l.quantityReceived ?? null }] };
    }
    case "unlinkNcr":
      return mapWhere(
        data,
        (o) => Array.isArray(o.items) && o.items.some((i) => i?.linkId === id),
        (o) => ({ ...o, items: o.items.filter((i) => i.linkId !== id) }),
      );
    default:
      return data;
  }
};

// ---- material certificates (useCertificateMutation) ----------------------------------------------------------------------------------------

/** Not guessed: record (a new row with a server-checked trace; the register page shows it on refetch). */
export const CERTIFICATE_OPTIMISTIC = new Set(["update", "review", "withdraw"]);

export const guessCertificate = (data, { action, id, body = {} } = {}) => {
  switch (action) {
    case "update":
      return updateById(data, id, (row) => mergeFlat(row, body));
    case "review":
      return updateById(data, id, withKey("status", (row) => (row.status === "received" ? { ...row, status: body.accept ? "accepted" : "rejected", reviewNote: body.note ?? null } : row)));
    case "withdraw":
      return updateById(data, id, withKey("status", (row) => ({ ...row, status: "withdrawn", withdrawalReason: body.reason ?? null })));
    default:
      return data;
  }
};

// ---- a supplier's own scoring settings (usePerformanceMutation saveSupplierSettings) -------------------------------------------------------

/** { overrides, effective, … }: the overrides become the body, and every value set overrides what is in force. A cleared one falls back on refetch. */
export const guessSupplierSettings = (settings, body = {}) => {
  if (!settings?.overrides) return settings;
  const effective = { ...settings.effective };
  for (const [k, v] of Object.entries(body)) if (v !== null && v !== undefined && k in effective) effective[k] = v;
  return { ...settings, overrides: { ...settings.overrides, ...body }, effective };
};
