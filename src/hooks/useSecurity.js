import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";
import { useMe } from "./useQmsApi";

// Settings → Security (docs/security-plan.md SE4): the network policy, approved networks and blocked attempts.

const key = (organisationId, ...rest) => ["api", "org", organisationId, "security", ...rest];

/** The policy: mode, networks, the caller's own address as the API sees it and whether a network includes it. */
export const useAccessPolicy = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "policy"),
    queryFn: () => apiFetch("/security/access-policy", { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

/** Requests blocked (enforce) or that would have been (monitor), one row per person, address and hour. */
export const useAccessDenials = ({ enabled = true, mode } = {}) => {
  const { organisationId } = useOrganisation();
  const qs = new URLSearchParams({ limit: "100", ...(mode ? { mode } : {}) });
  return useQuery({
    queryKey: key(organisationId, "denials", mode ?? "all"),
    queryFn: () => apiFetch(`/security/access-denials?${qs}`, { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

const request = ({ action, id, body }) => {
  switch (action) {
    case "setMode":
      return { path: "/security/access-policy", method: "PUT", body };
    case "addNetwork":
      return { path: "/security/networks", method: "POST", body };
    case "updateNetwork":
      return { path: `/security/networks/${id}`, method: "PATCH", body };
    case "removeNetwork":
      return { path: `/security/networks/${id}/remove`, method: "POST", body };
    case "setEmailDomains":
      return { path: "/security/email-domains", method: "PUT", body };
    case "setSessionAge":
      return { path: "/security/session-age", method: "PUT", body };
    case "restoreNetwork":
      return { path: `/security/networks/${id}/restore`, method: "POST" };
    default:
      throw new Error(`Unknown security action ${action}`);
  }
};

/**
 * Every change answers with the whole policy, which replaces the cache. Switching a network on or off and changing the mode show at once
 * (optimistic) and are put back if the server refuses (for example the lockout rule). A change to the mode can change what the person may
 * reach, so /me is refreshed too.
 */
export const useSecurityMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const policyKey = key(organisationId, "policy");
  return useMutation({
    mutationFn: (vars) => {
      const { path, method, body } = request(vars);
      return apiFetch(path, { method, body, organisationId });
    },
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: policyKey });
      const previous = queryClient.getQueryData(policyKey);
      if (previous && vars.action === "setMode") queryClient.setQueryData(policyKey, { ...previous, mode: vars.body.mode });
      if (previous && vars.action === "setEmailDomains") queryClient.setQueryData(policyKey, { ...previous, allowedEmailDomains: vars.body.domains });
      if (previous && vars.action === "setSessionAge") queryClient.setQueryData(policyKey, { ...previous, maxSessionHours: vars.body.hours });
      if (previous && vars.action === "updateNetwork" && Object.keys(vars.body).join() === "active") {
        queryClient.setQueryData(policyKey, { ...previous, networks: previous.networks.map((n) => (n.id === vars.id ? { ...n, active: vars.body.active } : n)) });
      }
      return { previous };
    },
    onError: (_e, _v, context) => {
      if (context?.previous) queryClient.setQueryData(policyKey, context.previous);
    },
    onSuccess: (data) => {
      if (data && data.networks) queryClient.setQueryData(policyKey, data);
    },
    onSettled: (_d, _e, vars) => refreshOrganisation(queryClient, organisationId, { me: vars?.action === "setMode" }),
  });
};

/** The network rule for the organisation being used, from /me: { state: open|allowed|monitored|denied, address }. */
export const useNetworkAccess = () => {
  const { organisationId, organisation } = useOrganisation();
  const id = organisationId ?? organisation?.id;
  const me = useMe();
  const membership = me.data?.memberships?.find((m) => m.organisation.id === id);
  return { state: membership?.network?.state ?? "open", address: membership?.network?.address ?? null, refetch: me.refetch, isLoading: me.isLoading };
};

/** Organisation id → whether the network rule blocks it here (for the organisation switcher). */
export const useBlockedOrganisations = () => {
  const me = useMe();
  return new Set((me.data?.memberships ?? []).filter((m) => m.network?.state === "denied").map((m) => m.organisation.id));
};
