import { useEffect, useState } from "react";
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

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Import templates (UI2c): organisation-wide, versioned mappings; the server preview; the formula language.
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** Import templates (archived ones only when asked for), by kind of record and name. */
export const useImportTemplates = (entityType, { archived = "exclude", enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  const qs = new URLSearchParams({ archived });
  if (entityType) qs.set("entityType", entityType);
  return useQuery({
    queryKey: key(organisationId, "templates", entityType ?? "all", archived),
    queryFn: () => apiFetch(`${BASE}/templates?${qs}`, { organisationId }).then((r) => r.data),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

/** One template with its current version and whether the caller may change it. */
export const useImportTemplate = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({ queryKey: key(organisationId, "template", id), queryFn: () => apiFetch(`${BASE}/templates/${id}`, { organisationId }), enabled: !!organisationId && !!id, retry: false });
};

/** Every version of a template, newest first. */
export const useTemplateVersions = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({ queryKey: key(organisationId, "template-versions", id), queryFn: () => apiFetch(`${BASE}/templates/${id}/versions`, { organisationId }).then((r) => r.data), enabled: !!organisationId && !!id, retry: false });
};

/** One version of a template as it was saved (frozen: cached for long). */
export const useTemplateVersion = (id, version) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "template-version", id, version),
    queryFn: () => apiFetch(`${BASE}/templates/${id}/versions/${version}`, { organisationId }),
    enabled: !!organisationId && !!id && !!version,
    retry: false,
    staleTime: 60 * 60_000,
  });
};

/** Every command on a template; everything is marked stale afterwards. */
export const useTemplateMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const send = (path, method = "POST") => apiFetch(`${BASE}/templates${path}`, { method, body: body ?? {}, organisationId });
      switch (action) {
        case "create": return send("");
        case "update": return send(`/${id}`, "PATCH");
        case "saveVersion": return send(`/${id}/versions`);
        case "duplicate": return send(`/${id}/duplicate`);
        case "archive": return send(`/${id}/archive`);
        case "restore": return send(`/${id}/restore`);
        case "restoreVersion": return send(`/${id}/restore-version`);
        default: throw new Error(`Unknown action ${action}`);
      }
    },
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/**
 * How the first rows of a file come out with the mapping on screen (T3: only the server works values out). Asked again ~300 ms after the mapping
 * stops changing; the last answer stays on screen while the next one comes.
 */
export const useTemplatePreview = (body, { enabled = true, delay = 300 } = {}) => {
  const { organisationId } = useOrganisation();
  const text = body ? JSON.stringify(body) : null;
  const [debounced, setDebounced] = useState(text);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), delay);
    return () => clearTimeout(t);
  }, [text, delay]);
  return useQuery({
    queryKey: key(organisationId, "template-preview", debounced),
    queryFn: () => apiFetch(`${BASE}/templates/preview`, { method: "POST", body: JSON.parse(debounced), organisationId }),
    enabled: !!organisationId && enabled && !!debounced,
    retry: false,
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  });
};

/** Every function a formula can use (fixed; cached for long). */
export const useFormulaFunctions = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({ queryKey: key(organisationId, "formula-functions"), queryFn: () => apiFetch(`${BASE}/formulas/functions`, { organisationId }).then((r) => r.data), enabled: !!organisationId && enabled, retry: false, staleTime: 60 * 60_000 });
};

/** The server's reading of a formula (its first problem with the position, and its result for a sample row), ~300 ms after typing stops. */
export const useFormulaCheck = (formula, columns, sample, { delay = 300 } = {}) => {
  const { organisationId } = useOrganisation();
  const text = formula?.trim() ? JSON.stringify({ formula, columns, ...(sample ? { sample } : {}) }) : null;
  const [debounced, setDebounced] = useState(text);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), delay);
    return () => clearTimeout(t);
  }, [text, delay]);
  return useQuery({
    queryKey: key(organisationId, "formula-check", debounced),
    queryFn: () => apiFetch(`${BASE}/formulas/check`, { method: "POST", body: JSON.parse(debounced), organisationId }),
    enabled: !!organisationId && !!debounced,
    retry: false,
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  });
};

/**
 * The review queue (IN5): values an import held back because their field is set to "Review". `status` open (default) | decided | all;
 * filters `entityType`, `connectionId`, `runId`, `recordId`; `openCount` is the organisation's waiting total (for badges).
 */
export const useIntegrationConflicts = ({ status = "open", entityType, connectionId, runId, recordId, page = 1, pageSize = 50, enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  const params = new URLSearchParams({ status, page: String(page), pageSize: String(pageSize) });
  if (entityType) params.set("entityType", entityType);
  if (connectionId) params.set("connectionId", connectionId);
  if (runId) params.set("runId", runId);
  if (recordId) params.set("recordId", recordId);
  return useQuery({
    queryKey: key(organisationId, "conflicts", params.toString()),
    queryFn: () => apiFetch(`${BASE}/conflicts?${params}`, { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

/**
 * Accept (the value is written, as the person) or reject (Fortress keeps its own; a reason is needed) a value waiting for review. Optimistic: the value
 * leaves every open list and the counts drop at once; on an error the lists are put back.
 */
export const useDecideConflict = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const lists = key(organisationId, "conflicts");
  return useMutation({
    mutationFn: ({ id, accept, note }) =>
      apiFetch(`${BASE}/conflicts/${id}/${accept ? "accept" : "reject"}`, { method: "POST", body: accept ? (note ? { note } : {}) : { reason: note }, organisationId }),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: lists });
      const previous = queryClient.getQueriesData({ queryKey: lists });
      for (const [k, data] of previous) {
        if (!data?.data || !String(k.at(-1)).includes("status=open")) continue;
        const had = data.data.some((c) => c.id === id);
        queryClient.setQueryData(k, {
          ...data,
          data: data.data.filter((c) => c.id !== id),
          total: had ? Math.max(0, data.total - 1) : data.total,
          openCount: Math.max(0, data.openCount - 1),
        });
      }
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      for (const [k, data] of ctx?.previous ?? []) queryClient.setQueryData(k, data);
    },
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};
