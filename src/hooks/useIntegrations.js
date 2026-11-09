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
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};
