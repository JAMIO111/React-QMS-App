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
