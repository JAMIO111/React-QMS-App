import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

const key = (organisationId, ...rest) => ["api", "org", organisationId, "integrations", ...rest];
const BASE = "/integrations";

/** The connector providers and what each can do. */
export const useIntegrationProviders = () => {
  const { organisationId } = useOrganisation();
  return useQuery({ queryKey: key(organisationId, "providers"), queryFn: () => apiFetch(`${BASE}/providers`, { organisationId }).then((r) => r.data), enabled: !!organisationId, retry: false, staleTime: 5 * 60_000 });
};

export const useIntegrationConnections = () => {
  const { organisationId } = useOrganisation();
  return useQuery({ queryKey: key(organisationId, "connections"), queryFn: () => apiFetch(`${BASE}/connections`, { organisationId }).then((r) => r.data), enabled: !!organisationId, retry: false });
};

/** One connection with its history, whether a credential is stored (never the value) and what still stops it being made ready. */
export const useIntegrationConnection = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({ queryKey: key(organisationId, "connection", id), queryFn: () => apiFetch(`${BASE}/connections/${id}`, { organisationId }), enabled: !!organisationId && !!id, retry: false });
};

/** The latest import runs of a connection. Polls while one is queued or running. */
export const useIntegrationRuns = (connectionId) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "runs", connectionId),
    queryFn: () => apiFetch(`${BASE}/runs?connectionId=${connectionId}&pageSize=20`, { organisationId }),
    enabled: !!organisationId && !!connectionId,
    retry: false,
    refetchInterval: (q) => (q.state.data?.data?.some((r) => r.status === "queued" || r.status === "running") ? 10_000 : false),
  });
};

/** The latest import runs across every connection (Settings → Integrations). Polls while one is queued or running. */
export const useRecentIntegrationRuns = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "runs", "recent"),
    queryFn: () => apiFetch(`${BASE}/runs?pageSize=8`, { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
    refetchInterval: (q) => (q.state.data?.data?.some((r) => r.status === "queued" || r.status === "running") ? 10_000 : false),
  });
};

/** One run with its errors and its rows by status now. Polls while it is queued or running. */
export const useIntegrationRun = (runId) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "run", runId),
    queryFn: () => apiFetch(`${BASE}/runs/${runId}`, { organisationId }),
    enabled: !!organisationId && !!runId,
    retry: false,
    refetchInterval: (q) => (q.state.data && (q.state.data.status === "queued" || q.state.data.status === "running") ? 10_000 : false),
  });
};

/** The rows a run staged or worked on, filtered by status, a page at a time. */
export const useIntegrationRunRows = (runId, status, page = 1) => {
  const { organisationId } = useOrganisation();
  const params = new URLSearchParams({ page: String(page), pageSize: "50" });
  if (status) params.set("status", status);
  return useQuery({
    queryKey: key(organisationId, "run-rows", runId, status ?? "all", page),
    queryFn: () => apiFetch(`${BASE}/runs/${runId}/rows?${params}`, { organisationId }),
    enabled: !!organisationId && !!runId,
    retry: false,
    placeholderData: (prev) => prev,
  });
};

/** The kinds of record a source can be mapped to, and their Fortress fields (static; cached for long). */
export const useIntegrationEntities = () => {
  const { organisationId } = useOrganisation();
  return useQuery({ queryKey: key(organisationId, "entities"), queryFn: () => apiFetch(`${BASE}/entities`, { organisationId }).then((r) => r.data), enabled: !!organisationId, retry: false, staleTime: 30 * 60_000 });
};

/** Files uploaded to a file connection, newest first. */
export const useIntegrationFiles = (connectionId, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "files", connectionId),
    queryFn: () => apiFetch(`${BASE}/connections/${connectionId}/files`, { organisationId }).then((r) => r.data),
    enabled: !!organisationId && !!connectionId && enabled,
    retry: false,
  });
};

/** One uploaded file with its columns and first rows. */
export const useIntegrationFile = (fileId) => {
  const { organisationId } = useOrganisation();
  return useQuery({ queryKey: key(organisationId, "file", fileId), queryFn: () => apiFetch(`${BASE}/files/${fileId}`, { organisationId }), enabled: !!organisationId && !!fileId, retry: false });
};

/** Every mapping version of a connection (optionally one kind of record), newest first. */
export const useIntegrationMappings = (connectionId, entityType) => {
  const { organisationId } = useOrganisation();
  const qs = entityType ? `?entityType=${entityType}` : "";
  return useQuery({
    queryKey: key(organisationId, "mappings", connectionId, entityType ?? "all"),
    queryFn: () => apiFetch(`${BASE}/connections/${connectionId}/mappings${qs}`, { organisationId }).then((r) => r.data),
    enabled: !!organisationId && !!connectionId,
    retry: false,
  });
};

/** What an import may do for each kind of record on a connection (defaults where none are saved). */
export const useIntegrationSettings = (connectionId) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "settings", connectionId),
    queryFn: () => apiFetch(`${BASE}/connections/${connectionId}/settings`, { organisationId }).then((r) => r.data),
    enabled: !!organisationId && !!connectionId,
    retry: false,
  });
};

/** Save one kind of record's import settings: shown at once, put back with a message if the server refuses. */
export const useSaveImportSettings = (connectionId) => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const queryKey = key(organisationId, "settings", connectionId);
  return useMutation({
    mutationFn: (body) => apiFetch(`${BASE}/connections/${connectionId}/settings`, { method: "PUT", body, organisationId }),
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (old) => old?.map((s) => (s.entityType === body.entityType ? { ...s, ...body, saved: true } : s)));
      return { previous };
    },
    onError: (_e, _b, context) => queryClient.setQueryData(queryKey, context?.previous),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/**
 * Every command on a connection. The credential goes in the body of one request and is never kept: the result is the connection without it.
 * Everything is marked stale afterwards so the list, the detail and the master data overview show what changed.
 */
export const useIntegrationMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const send = (path, method = "POST") => apiFetch(`${BASE}${path}`, { method, body: body ?? {}, organisationId });
      switch (action) {
        case "create":
          return send("/connections");
        case "update":
          return send(`/connections/${id}`, "PATCH");
        case "setCredential":
          return send(`/connections/${id}/credential`, "PUT");
        case "revokeCredential":
          return send(`/connections/${id}/credential/revoke`);
        case "test":
          return send(`/connections/${id}/test`);
        case "ready":
          return send(`/connections/${id}/ready`);
        case "activate":
          return send(`/connections/${id}/activate`);
        case "pause":
          return send(`/connections/${id}/pause`);
        case "resume":
          return send(`/connections/${id}/resume`);
        case "retire":
          return send(`/connections/${id}/retire`);
        case "requestRun":
          return send(`/connections/${id}/runs`);
        case "retryRows":
          return send(`/connections/${id}/retry`);
        case "continueRun":
          return send(`/runs/${id}/continue`);
        case "cancelRun":
          return send(`/runs/${id}/cancel`);
        case "registerFile":
          return send(`/connections/${id}/files`);
        case "saveMapping":
          return send(`/connections/${id}/mapping`, "PUT");
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};
