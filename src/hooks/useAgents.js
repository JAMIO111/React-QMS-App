import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";
import { jobRunning } from "../lib/agents";

// Connector agents (docs/connector-agent-plan.md AG1): the organisation's agents, registrations, and jobs given to an agent.

const key = (organisationId, ...rest) => ["api", "org", organisationId, "integrations", "agents", ...rest];

export const useAgents = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "list"),
    queryFn: () => apiFetch("/integrations/agents", { organisationId }),
    enabled: !!organisationId && enabled,
    refetchInterval: 30_000,
  });
};

/** One agent; refetched every 5 seconds while its page is open so online / offline and jobs show within moments. */
export const useAgent = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "detail", id),
    queryFn: () => apiFetch(`/integrations/agents/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    refetchInterval: 5_000,
    retry: false,
  });
};

export const useAgentRegistrations = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "registrations"),
    queryFn: () => apiFetch("/integrations/agent-registrations", { organisationId }),
    enabled: !!organisationId && enabled,
  });
};

/** A job given to an agent, polled every 2 seconds until it is done. */
export const useAgentJob = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "job", id),
    queryFn: () => apiFetch(`/integrations/agent-jobs/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    refetchInterval: (query) => (jobRunning(query.state.data?.status) || !query.state.data ? 2_000 : false),
  });
};

const request = ({ action, id, body }) => {
  switch (action) {
    case "rename":
      return { path: `/integrations/agents/${id}`, method: "PATCH", body };
    case "revoke":
      return { path: `/integrations/agents/${id}/revoke`, method: "POST", body };
    case "ping":
      return { path: `/integrations/agents/${id}/ping`, method: "POST", body: body ?? {} };
    case "rotateKeys":
      return { path: `/integrations/agents/${id}/rotate-keys`, method: "POST", body: body ?? {} };
    case "diagnostics":
      return { path: `/integrations/agents/${id}/diagnostics`, method: "POST", body: body ?? {} };
    case "wake":
      return { path: `/integrations/agents/${id}/wake`, method: "POST" };
    case "register":
      return { path: "/integrations/agent-registrations", method: "POST", body };
    case "cancelRegistration":
      return { path: `/integrations/agent-registrations/${id}/cancel`, method: "POST" };
    default:
      throw new Error(`Unknown agent action ${action}`);
  }
};

/**
 * Every change to agents and registrations. Renaming shows at once (optimistic) and is put back if refused; the rest answer with the new state and
 * refresh the organisation's data. Waking the agent (its page was opened) refreshes nothing.
 */
export const useAgentMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars) => {
      const { path, method, body } = request(vars);
      return apiFetch(path, { method, body, organisationId });
    },
    onMutate: async (vars) => {
      if (vars.action !== "rename") return {};
      const detailKey = key(organisationId, "detail", vars.id);
      await queryClient.cancelQueries({ queryKey: detailKey });
      const previous = queryClient.getQueryData(detailKey);
      if (previous) queryClient.setQueryData(detailKey, { ...previous, name: vars.body.name, location: vars.body.location ?? null });
      return { previous, detailKey };
    },
    onError: (_e, _v, context) => {
      if (context?.previous) queryClient.setQueryData(context.detailKey, context.previous);
    },
    onSuccess: (data, vars) => {
      if (data && data.id && (vars.action === "rename" || vars.action === "revoke")) queryClient.setQueryData(key(organisationId, "detail", vars.id), data);
    },
    onSettled: (_d, _e, vars) => {
      if (vars?.action !== "wake") refreshOrganisation(queryClient, organisationId);
    },
  });
};
