import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useAuth } from "../contexts/AuthProvider";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

// The supplier and customer portal (docs/external-portal-plan.md PT1).
//
// Two sides. Staff (Settings → External access) work inside their own organisation like any other settings page. An external person has no
// organisation of their own in the app: the organisation they act in is named per call, so their keys sit under ["api", "portal", ...].

const staffKey = (organisationId, ...rest) => ["api", "org", organisationId, "external-access", ...rest];

/** The portal switch, every supplier and customer with whether they are opted in, and how many people each has. */
export const useExternalAccess = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: staffKey(organisationId, "overview"),
    queryFn: () => apiFetch("/external-access", { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

/** Everyone invited or given access (the access report); `partyId` narrows it to one supplier or customer. */
export const useExternalPeople = ({ partyId, enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: staffKey(organisationId, "people", partyId ?? "all"),
    queryFn: () => apiFetch(`/external-access/people${partyId ? `?partyId=${partyId}` : ""}`, { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

const staffRequest = ({ action, id, body }) => {
  switch (action) {
    case "settings":
      return { path: "/external-access/settings", method: "PUT", body };
    case "party":
      return { path: "/external-access/parties", method: "PUT", body };
    case "invite":
      return { path: "/external-access/people", method: "POST", body };
    case "resend":
      return { path: `/external-access/people/${id}/resend`, method: "POST" };
    case "remove":
      return { path: `/external-access/people/${id}/remove`, method: "POST", body };
    case "suspend":
      return { path: `/external-access/people/${id}/suspend`, method: "POST", body };
    case "restore":
      return { path: `/external-access/people/${id}/restore`, method: "POST" };
    default:
      throw new Error(`Unknown external access action ${action}`);
  }
};

/**
 * Staff actions. Switching the portal or a party on or off shows at once (optimistic) and is put back if the server refuses; the answer replaces
 * the overview. Everything is refreshed afterwards, as for every action.
 */
export const useExternalAccessMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const overviewKey = staffKey(organisationId, "overview");
  return useMutation({
    mutationFn: (vars) => {
      const { path, method, body } = staffRequest(vars);
      return apiFetch(path, { method, body, organisationId });
    },
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: overviewKey });
      const previous = queryClient.getQueryData(overviewKey);
      if (previous && vars.action === "settings") {
        const b = vars.body;
        queryClient.setQueryData(overviewKey, {
          ...previous,
          settings: {
            enabled: b.enabled ?? previous.settings.enabled,
            rankingEnabled: b.rankingEnabled ?? previous.settings.rankingEnabled,
            requireMfa: b.requireMfa ?? previous.settings.requireMfa,
          },
        });
      }
      if (previous && vars.action === "party") {
        queryClient.setQueryData(overviewKey, {
          ...previous,
          parties: previous.parties.map((p) => (p.recordId === vars.body.partyId && p.kind === vars.body.kind ? { ...p, enabled: vars.body.enabled ?? p.enabled } : p)),
        });
      }
      return { previous };
    },
    onError: (_e, _v, context) => {
      if (context?.previous) queryClient.setQueryData(overviewKey, context.previous);
    },
    onSuccess: (data, vars) => {
      if (vars.action === "settings" || vars.action === "party") queryClient.setQueryData(overviewKey, data);
    },
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

// ---- The external person ----

const portalKey = (userId, ...rest) => ["api", "portal", userId, ...rest];

/** Where the signed-in person has portal access. */
export const usePortalAccess = () => {
  const { user } = useAuth();
  return useQuery({
    queryKey: portalKey(user?.id, "me"),
    queryFn: () => apiFetch("/portal/me"),
    enabled: !!user,
    retry: false,
  });
};

/** Portal invitations waiting for the signed-in address. */
export const usePortalInvitations = () => {
  const { user } = useAuth();
  return useQuery({
    queryKey: portalKey(user?.id, "invitations"),
    queryFn: () => apiFetch("/portal/invitations"),
    enabled: !!user,
    retry: false,
  });
};

export const usePortalHome = (organisationId) => {
  const { user } = useAuth();
  return useQuery({
    queryKey: portalKey(user?.id, organisationId, "home"),
    queryFn: () => apiFetch("/portal/home", { organisationId }),
    enabled: !!user && !!organisationId,
    retry: false,
  });
};

/** A party admin's own colleagues. */
export const usePortalPeople = (organisationId, { enabled = true } = {}) => {
  const { user } = useAuth();
  return useQuery({
    queryKey: portalKey(user?.id, organisationId, "people"),
    queryFn: () => apiFetch("/portal/people", { organisationId }),
    enabled: !!user && !!organisationId && enabled,
    retry: false,
  });
};

/** Accept an invitation, invite a colleague, send again, remove: each refreshes the person's portal data and /me. */
export const usePortalMutation = (organisationId) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      switch (action) {
        case "accept":
          return apiFetch(`/portal/invitations/${id}/accept`, { method: "POST" });
        case "invite":
          return apiFetch("/portal/people", { method: "POST", body, organisationId });
        case "resend":
          return apiFetch(`/portal/people/${id}/resend`, { method: "POST", organisationId });
        case "remove":
          return apiFetch(`/portal/people/${id}/remove`, { method: "POST", body, organisationId });
        default:
          throw new Error(`Unknown portal action ${action}`);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["api", "portal", user?.id] });
      queryClient.invalidateQueries({ queryKey: ["api", "me"] });
    },
  });
};
