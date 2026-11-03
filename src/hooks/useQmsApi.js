import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useAuth } from "../contexts/AuthProvider";
import { useOrganisation } from "../contexts/OrganisationProvider";

/** GET /me — profile, memberships and effective permissions (requires the API). */
export const useMe = () => {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["api", "me", user?.id],
    queryFn: () => apiFetch("/me"),
    enabled: !!user,
    staleTime: 1000 * 60,
    retry: false,
  });
};

/**
 * Permissions of the signed-in user in the current organisation. The server enforces them again;
 * this only decides what the UI offers.
 */
export const usePermissions = () => {
  const { organisationId } = useOrganisation();
  const me = useMe();
  const membership = me.data?.memberships?.find((m) => m.organisation.id === organisationId);
  const permissions = new Set(membership?.permissions ?? []);
  return {
    can: (permission) => permissions.has(permission),
    isLoading: me.isLoading,
    error: me.error,
  };
};

const orgKey = (organisationId, ...rest) => ["api", "org", organisationId, ...rest];

export const useOrganisationDetails = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: orgKey(organisationId, "details"),
    queryFn: () => apiFetch("/organisations/current", { organisationId }),
    enabled: !!organisationId,
    retry: false,
  });
};

export const useUpdateOrganisation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ body, reason }) =>
      apiFetch("/organisations/current", { method: "PATCH", body, organisationId, reason }),
    onSuccess: (data) => {
      queryClient.setQueryData(orgKey(organisationId, "details"), data);
      queryClient.invalidateQueries({ queryKey: ["memberships"] });
      queryClient.invalidateQueries({ queryKey: ["api", "me"] });
    },
  });
};

export const useSites = ({ includeInactive = false } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: orgKey(organisationId, "sites", { includeInactive }),
    queryFn: () =>
      apiFetch(`/sites?limit=200${includeInactive ? "&includeInactive=true" : ""}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
  });
};

export const useDepartments = (siteId, { includeInactive = false } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: orgKey(organisationId, "departments", siteId, { includeInactive }),
    queryFn: () =>
      apiFetch(`/departments?limit=200&siteId=${siteId}${includeInactive ? "&includeInactive=true" : ""}`, {
        organisationId,
      }),
    enabled: !!organisationId && !!siteId,
    retry: false,
  });
};

/** Create/update for sites and departments; refreshes the organisation's structure lists. */
export const useStructureMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ resource, id, body }) =>
      apiFetch(id ? `/${resource}/${id}` : `/${resource}`, {
        method: id ? "PATCH" : "POST",
        body,
        organisationId,
      }),
    onSuccess: (_data, { resource }) =>
      queryClient.invalidateQueries({ queryKey: orgKey(organisationId, resource) }),
  });
};

export const useCreateOrganisation = () => {
  const queryClient = useQueryClient();
  const { selectOrganisation } = useOrganisation();
  return useMutation({
    mutationFn: ({ body, idempotencyKey }) =>
      apiFetch("/organisations", { method: "POST", body, idempotencyKey }),
    onSuccess: async (organisation) => {
      selectOrganisation(organisation.id);
      await queryClient.invalidateQueries({ queryKey: ["memberships"] });
      await queryClient.invalidateQueries({ queryKey: ["api", "me"] });
    },
  });
};

// ---------------------------------------------------------------------------
// Members, roles and invitations (Phase 1.5)
// ---------------------------------------------------------------------------

export const useMembers = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: orgKey(organisationId, "members"),
    queryFn: () => apiFetch("/members", { organisationId }),
    enabled: !!organisationId,
    retry: false,
  });
};

export const useRoles = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: orgKey(organisationId, "roles"),
    queryFn: () => apiFetch("/roles", { organisationId }),
    enabled: !!organisationId,
    retry: false,
    staleTime: 1000 * 60 * 5,
  });
};

/**
 * Member administration. `action` is one of: invite, status, assign, unassign.
 * Every change refreshes the directory (and /me, in case the caller changed their own roles).
 */
export const useMemberMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, membershipId, assignmentId, body }) => {
      switch (action) {
        case "invite":
          return apiFetch("/members/invitations", { method: "POST", body, organisationId });
        case "status":
          return apiFetch(`/members/${membershipId}`, { method: "PATCH", body, organisationId });
        case "assign":
          return apiFetch(`/members/${membershipId}/role-assignments`, { method: "POST", body, organisationId });
        case "unassign":
          return apiFetch(`/role-assignments/${assignmentId}`, { method: "DELETE", organisationId });
        default:
          throw new Error(`Unknown member action ${action}`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orgKey(organisationId, "members") });
      queryClient.invalidateQueries({ queryKey: ["api", "me"] });
    },
  });
};

export const useMyInvitations = () => {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["api", "invitations", user?.id],
    queryFn: () => apiFetch("/invitations"),
    enabled: !!user,
    retry: false,
  });
};

export const useAcceptInvitation = () => {
  const queryClient = useQueryClient();
  const { selectOrganisation } = useOrganisation();
  return useMutation({
    mutationFn: (membershipId) => apiFetch(`/invitations/${membershipId}/accept`, { method: "POST" }),
    onSuccess: async ({ organisationId }) => {
      selectOrganisation(organisationId);
      await queryClient.invalidateQueries({ queryKey: ["memberships"] });
      await queryClient.invalidateQueries({ queryKey: ["api"] });
    },
  });
};

/**
 * Whether to show a menu item that needs `permission`. While permissions are unknown (loading, or
 * the API is not reachable) items stay visible — the server still refuses what is not allowed.
 */
export const useCanSee = () => {
  const { can, isLoading, error } = usePermissions();
  return (permission) => !permission || isLoading || !!error || can(permission);
};
