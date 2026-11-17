import { useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DASHBOARD_STALE_MS } from "@/lib/dashboardPeriod";
import { apiFetch, describeApiError } from "../lib/api-client";
import { useToast } from "../contexts/ToastProvider";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";
import { tookTheirs, withVersion } from "../lib/editConflicts";
import { guessCache, pendingId, rollbackGuess, settle, updateById } from "../lib/optimistic";
import { DOCUMENT_GUESSED } from "../lib/documents";

export { DOCUMENT_GUESSED };

/** Document control (docs/document-control-plan.md): types, documents and their revisions. */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "documents", ...rest];

const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params ?? {}).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && p.set(k, v));
  return p.toString();
};

/** `all` includes switched-off types (the settings page); the new-document dialog uses the active ones. */
export const useDocumentTypes = ({ all = false, enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "types", all),
    queryFn: () => apiFetch(`/document-types?${qs({ all: all ? "true" : "" })}`, { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

/** The register: filters and paging are the server's. */
export const useDocuments = (params) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "list", params),
    queryFn: () => apiFetch(`/documents?${qs(params)}`, { organisationId }),
    enabled: !!organisationId,
    placeholderData: keepPreviousData,
    retry: false,
  });
};

export const useDocument = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "document", id),
    queryFn: () => apiFetch(`/documents/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

export const useDocumentRevision = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "revision", id),
    queryFn: () => apiFetch(`/document-revisions/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};


const FILE_ACTIONS = new Set(["removeFile", "restoreFile"]);

/**
 * One command at a time: { action, id, body, show?, failed? }. Every one refreshes the organisation's cached data. A guessed command
 * (DOCUMENT_GUESSED) changes the screen at once and, if refused, is put back with an error toast titled `failed` (default "Not saved").
 */
export const useDocumentMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const send = (path, method = "POST") => apiFetch(path, { method, body, organisationId });
      switch (action) {
        case "createType":
          return send("/document-types");
        case "updateType":
          return send(`/document-types/${id}`, "PATCH");
        case "createDocument":
          return send("/documents");
        case "updateDocument":
          return send(`/documents/${id}`, "PATCH");
        case "updateRevision":
          return send(`/document-revisions/${id}`, "PATCH");
        case "discardRevision":
          return send(`/document-revisions/${id}/discard`);
        case "removeFile":
          return send(`/document-files/${id}/delete`);
        case "restoreFile":
          return send(`/document-files/${id}/restore`);
        case "setSigners":
          return send(`/document-revisions/${id}/signers`, "PUT");
        case "submit":
          return send(`/document-revisions/${id}/submit`);
        case "review":
          return send(`/document-revisions/${id}/review`);
        case "approve":
          return send(`/document-revisions/${id}/approve`);
        case "sendBack":
          return send(`/document-revisions/${id}/send-back`);
        case "startRevision":
          return send(`/documents/${id}/revisions`);
        case "withdraw":
          return send(`/documents/${id}/withdraw`);
        case "setReaders":
          return send(`/documents/${id}/readers`, "PUT");
        case "setSkills":
          return send(`/documents/${id}/skills`, "PUT");
        case "acknowledge":
          return send(`/document-revisions/${id}/acknowledge`);
        case "addRecipient":
          return send(`/document-revisions/${id}/recipients`);
        case "recordReview":
          return send(`/documents/${id}/reviews`);
        case "setLinks":
          return send(`/documents/${id}/links`, "PUT");
        case "raiseChangeRequest":
          return send(`/documents/${id}/change-requests`);
        case "acceptChangeRequest":
          return send(`/document-change-requests/${id}/accept`);
        case "declineChangeRequest":
          return send(`/document-change-requests/${id}/decline`);
        case "withdrawChangeRequest":
          return send(`/document-change-requests/${id}/withdraw`);
        case "issueExternal":
          return send(`/document-revisions/${id}/issue-external`);
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    // Quick edits show at once (see guessDocuments); `show` carries what the screen needs that the server only takes ids for.
    // Files are guessed too, but AttachmentDrop tells its own errors.
    onMutate: (vars) => (DOCUMENT_GUESSED.has(vars?.action) || FILE_ACTIONS.has(vars?.action) ? guessCache(queryClient, ["api", "org", organisationId], (data, queryKey) => guessDocuments(data, vars, queryKey)) : { optimistic: false }),
    onError: (error, vars, context) => {
      rollbackGuess(queryClient, context);
      if (DOCUMENT_GUESSED.has(vars?.action) && !error?.cancelled) toast?.showToast({ type: "error", title: vars.failed ?? "Not saved", message: describeApiError(error) });
    },
    // Commands that were not guessed wait for the refetch, so the screen has moved on when the caller's onSuccess runs.
    onSettled: (_data, _error, _vars, context) => settle(queryClient, organisationId, context),
  });
};

const now = () => new Date().toISOString();

/** The body's plain values written onto the object, for the keys it already has (the version is the server's to move). */
const mergeFlat = (obj, body = {}) => {
  let changed = false;
  const out = { ...obj };
  for (const [k, v] of Object.entries(body)) {
    if (k === "rowVersion" || !(k in obj) || v === undefined || obj[k] === v) continue;
    if (v !== null && typeof v === "object") continue;
    out[k] = v;
    changed = true;
  }
  return changed ? out : obj;
};

/**
 * Any cached documents data as it will be after a command of useDocumentMutation (one cached query at a time; `queryKey` says which).
 * Commands whose outcome the database decides (submit, review, approve, issue, withdraw, accept, start a revision, create) are left alone.
 */
export const guessDocuments = (data, { action, id, body = {}, show = {} } = {}, queryKey = []) => {
  if (!id) return data;
  switch (action) {
    case "updateType":
    case "updateDocument":
    case "updateRevision":
      // `show` gives joined values the body only names by id (e.g. owner).
      return updateById(data, id, (o) => mergeFlat(Object.keys(show).some((k) => k in o) ? { ...o, ...Object.fromEntries(Object.entries(show).filter(([k]) => k in o)) } : o, body));
    case "removeFile":
      return updateById(data, id, (o) => ({ ...o, deletedAt: now(), deleteReason: body.reason ?? null }));
    case "restoreFile":
      return updateById(data, id, (o) => ({ ...o, deletedAt: null, deleteReason: null }));
    case "setReaders":
      return show.targets ? updateById(data, id, (o) => ("targets" in o ? { ...o, targets: show.targets } : o)) : data;
    case "setSkills":
      return show.skills ? updateById(data, id, (o) => ("skills" in o ? { ...o, skills: show.skills } : o)) : data;
    case "setLinks":
      return show.links ? updateById(data, id, (o) => ("links" in o ? { ...o, links: show.links.map((l) => (l.id ? l : { ...l, id: pendingId() })) } : o)) : data;
    case "withdrawChangeRequest":
      return updateById(data, id, (o) => ({ ...o, status: "withdrawn" }));
    case "declineChangeRequest":
      return updateById(data, id, (o) => ({ ...o, status: "declined", decisionReason: body.reason ?? null }));
    case "acknowledge": {
      const at = now();
      const note = body.note ?? null;
      let next = updateById(data, id, (o) => (o.myReading ? { ...o, myReading: { ...o.myReading, acknowledgedAt: at, note } } : o));
      // My documents: it leaves "to read" and heads "read lately"; the badge counts one fewer.
      if (Array.isArray(next?.toRead)) {
        const item = next.toRead.find((x) => x.revision?.id === id);
        if (item) next = { ...next, toRead: next.toRead.filter((x) => x !== item), acknowledged: [{ ...item, acknowledgedAt: at, note }, ...(next.acknowledged ?? [])] };
      }
      if (queryKey[3] === "documents" && queryKey.includes("mine-count") && typeof next?.toRead === "number" && next.toRead > 0) next = { ...next, toRead: next.toRead - 1, total: Math.max(0, (next.total ?? 1) - 1) };
      return next;
    }
    case "addRecipient": {
      if (!(queryKey.includes("recipients") && queryKey.at(-1) === id && Array.isArray(data))) return data;
      if (data.some((x) => x.person?.id === body.userId)) return data;
      return [...data, { id: pendingId(), person: { id: body.userId, name: show.name ?? "…" }, reachedVia: ["Added"], dueOn: null, overdue: false, viewedAt: null, acknowledgedAt: null, note: null }];
    }
    default:
      return data;
  }
};

/**
 * Saving a draft's text or change summary as it is typed: the cached revision is updated at once (so the editor never jumps back),
 * then the server's answer replaces it; on error the previous copy comes back.
 */
export const useSaveDraft = (revisionId) => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const revKey = key(organisationId, "revision", revisionId);
  // Edit conflicts (EC3): every save says it is based on the draft as this page loaded it (lib/editConflicts.js follows this person's own saves
  // from there), so text someone else saved meanwhile is never overwritten unasked. When the person loads theirs, `reloads` goes up so the
  // editor can start again from the saved text.
  const base = useRef(null);
  const [reloads, setReloads] = useState(0);
  const mutation = useMutation({
    mutationFn: async (body) => {
      if (!base.current || base.current.id !== revisionId) {
        const cached = queryClient.getQueryData(revKey);
        base.current = { id: revisionId, rowVersion: cached?.rowVersion ?? null };
      }
      const answer = await apiFetch(`/document-revisions/${revisionId}`, { method: "PATCH", body: withVersion(base.current, body), organisationId });
      if (tookTheirs(answer) && answer?.rowVersion) {
        base.current = { id: revisionId, rowVersion: answer.rowVersion };
        setReloads((n) => n + 1);
      }
      return answer;
    },
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: revKey });
      const previous = queryClient.getQueryData(revKey);
      if (previous) queryClient.setQueryData(revKey, { ...previous, ...body });
      return { previous };
    },
    onError: (_err, _body, context) => context?.previous && queryClient.setQueryData(revKey, context.previous),
    onSuccess: (data) => {
      queryClient.setQueryData(revKey, data);
      return refreshOrganisation(queryClient, organisationId);
    },
  });
  return { ...mutation, reloads };
};

/** The shape `AttachmentDrop` expects: `mutate({ path, body })` for `/document-files/<id>/delete|restore`. */
export const useDocumentFileMutation = () => {
  const mutation = useDocumentMutation();
  return {
    mutate: ({ path, body }, options) => mutation.mutate({ action: path.endsWith("/restore") ? "restoreFile" : "removeFile", id: path.split("/").at(-2), body }, options),
    reset: mutation.reset,
    isPending: mutation.isPending,
    error: mutation.error,
  };
};

/** Switching a type on or off: shown at once, put back on error, then refreshed. */
export const useToggleDocumentType = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const typesKey = key(organisationId, "types");
  return useMutation({
    mutationFn: ({ id, active }) => apiFetch(`/document-types/${id}`, { method: "PATCH", body: { active }, organisationId }),
    onMutate: async ({ id, active }) => {
      await queryClient.cancelQueries({ queryKey: typesKey });
      const previous = queryClient.getQueriesData({ queryKey: typesKey });
      queryClient.setQueriesData({ queryKey: typesKey }, (old) => (old?.data ? { ...old, data: old.data.map((t) => (t.id === id ? { ...t, active } : t)) } : old));
      return { previous };
    },
    onError: (_err, _vars, context) => context?.previous?.forEach(([k, v]) => queryClient.setQueryData(k, v)),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** Members who may be named as reviewers or approver (`canApprove`), for document managers. */
export const useDocumentSigners = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "signers"),
    queryFn: () => apiFetch("/document-signers", { organisationId }).then((r) => r.data),
    enabled: !!organisationId && enabled,
    staleTime: 1000 * 60 * 5,
  });
};

/** Revisions waiting for the signed-in person to review or approve. */
export const useWaitingReviews = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "waiting"),
    queryFn: () => apiFetch("/document-reviews/mine", { organisationId }).then((r) => r.data),
    enabled: !!organisationId,
    retry: false,
  });
};

/** A revision compared with the one it was started from (or `withId`). */
export const useDocumentCompare = (revisionId, { withId, enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "compare", revisionId, withId ?? null),
    queryFn: () => apiFetch(`/document-revisions/${revisionId}/compare${withId ? `?with=${withId}` : ""}`, { organisationId }),
    enabled: !!organisationId && !!revisionId && enabled,
    retry: false,
  });
};

/** Naming the reviewers and approver of a draft: shown at once, put back on error. */
export const useSetSigners = (revisionId) => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const revKey = key(organisationId, "revision", revisionId);
  return useMutation({
    mutationFn: ({ reviewerIds, approverId }) => apiFetch(`/document-revisions/${revisionId}/signers`, { method: "PUT", body: { reviewerIds, approverId }, organisationId }),
    onMutate: async ({ reviewers, approver }) => {
      await queryClient.cancelQueries({ queryKey: revKey });
      const previous = queryClient.getQueryData(revKey);
      if (previous) queryClient.setQueryData(revKey, { ...previous, reviewers, approver });
      return { previous };
    },
    onError: (_err, _vars, context) => context?.previous && queryClient.setQueryData(revKey, context.previous),
    onSuccess: (data) => queryClient.setQueryData(revKey, data),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** The signed-in person's reading: to acknowledge (overdue first), acknowledged recently, and reviews waiting. */
export const useMyDocuments = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "mine"),
    queryFn: () => apiFetch("/my-documents", { organisationId }),
    enabled: !!organisationId,
    retry: false,
  });
};

/** For the menu badge (polled every 5 minutes, like My alerts). */
export const useMyDocumentCount = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "mine-count"),
    queryFn: () => apiFetch("/my-documents/count", { organisationId }),
    enabled: !!organisationId && enabled,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
};

/** Who was asked to read a revision (managers see everyone). */
export const useDocumentRecipients = (revisionId, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "recipients", revisionId),
    queryFn: () => apiFetch(`/document-revisions/${revisionId}/recipients`, { organisationId }).then((r) => r.data),
    enabled: !!organisationId && !!revisionId && enabled,
    retry: false,
  });
};

/** Restricting a document: shown at once, put back on error. */
export const useSetRestricted = (documentId) => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const docKey = key(organisationId, "document", documentId);
  return useMutation({
    mutationFn: (restricted) => apiFetch(`/documents/${documentId}`, { method: "PATCH", body: { restricted }, organisationId }),
    onMutate: async (restricted) => {
      await queryClient.cancelQueries({ queryKey: docKey });
      const previous = queryClient.getQueryData(docKey);
      if (previous) queryClient.setQueryData(docKey, { ...previous, restricted });
      return { previous };
    },
    onError: (_err, _vars, context) => context?.previous && queryClient.setQueryData(docKey, context.previous),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** Change requests: the person's own, or all of them for document managers. */
export const useChangeRequests = (params) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "change-requests", params),
    queryFn: () => apiFetch(`/document-change-requests?${qs(params)}`, { organisationId }).then((r) => r.data),
    enabled: !!organisationId,
    retry: false,
  });
};

/** Documents in force for a part (and its family), part family, machine or operation, where work happens. */
export const useDocumentsInForce = ({ partId, partFamilyId, machineId, operationCode } = {}, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  const params = { partId, partFamilyId, machineId, operationCode };
  const any = Boolean(partId || partFamilyId || machineId || operationCode);
  return useQuery({
    queryKey: key(organisationId, "in-force", params),
    queryFn: () => apiFetch(`/documents-in-force?${qs(params)}`, { organisationId }).then((r) => r.data),
    enabled: !!organisationId && enabled && any,
    retry: false,
  });
};

/** The documents dashboard (DC5): as of today and for the period. */
export const useDocumentsDashboard = ({ from, to }) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "dashboard", from, to),
    queryFn: () => apiFetch(`/documents-dashboard?from=${from}&to=${to}`, { organisationId }),
    staleTime: DASHBOARD_STALE_MS,
    enabled: !!organisationId && !!from && !!to,
    retry: false,
    placeholderData: keepPreviousData,
  });
};

/**
 * A controlled copy of a PDF (DC5): the API stamps every page with who printed it and when, so it is fetched each time (never cached) and
 * opened in a new tab. Returns `{ open, isPending, error }`.
 */
export const useControlledCopy = () => {
  const { organisationId } = useOrganisation();
  return useMutation({
    mutationFn: async (fileId) => {
      // Open the tab first (inside the click) so a pop-up blocker allows it, then point it at the stamped file.
      const tab = typeof window !== "undefined" ? window.open("", "_blank") : null;
      try {
        const blob = await apiFetch(`/document-files/${fileId}/controlled-copy`, { organisationId, as: "blob" });
        const url = URL.createObjectURL(blob);
        if (tab) tab.location.href = url;
        else window.location.assign(url);
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return true;
      } catch (err) {
        tab?.close();
        throw err;
      }
    },
  });
};
