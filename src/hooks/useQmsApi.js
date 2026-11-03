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
