import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

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

/** One command at a time: { action, id, body }. Every one refreshes the organisation's cached data. */
export const useDocumentMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
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
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    onSuccess: () => refreshOrganisation(queryClient, organisationId),
  });
};

/**
 * Saving a draft's text or change summary as it is typed: the cached revision is updated at once (so the editor never jumps back),
 * then the server's answer replaces it; on error the previous copy comes back.
 */
export const useSaveDraft = (revisionId) => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const revKey = key(organisationId, "revision", revisionId);
  return useMutation({
    mutationFn: (body) => apiFetch(`/document-revisions/${revisionId}`, { method: "PATCH", body, organisationId }),
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
