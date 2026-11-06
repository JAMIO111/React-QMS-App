import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import supabase from "../supabase-client";
import { useAuth } from "../contexts/AuthProvider";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

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

/**
 * The organisation's logo as a short-lived link to the private org-logos bucket, or null when the
 * organisation has none. Every member may read it (storage policy), so the menu can show it.
 */
export const useOrganisationLogo = () => {
  const { organisationId } = useOrganisation();
  const { data: org } = useOrganisationDetails();
  const path = org?.settings?.logoPath ?? null;
  return useQuery({
    queryKey: orgKey(organisationId, "logo", path),
    queryFn: async () => {
      const { data, error } = await supabase.storage.from("org-logos").createSignedUrl(path, 60 * 60);
      if (error) throw error;
      return data?.signedUrl ?? null;
    },
    enabled: !!organisationId && !!path,
    staleTime: 50 * 60 * 1000,
    retry: false,
  });
};

/** Logo files: PNG, JPG, WebP or SVG up to 1 MB (the bucket enforces the same). */
export const LOGO_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" };
export const LOGO_MAX_BYTES = 1024 * 1024;

/** Uploads a logo to <organisation id>/logo/<random>.<ext> and returns its path. */
export const uploadOrganisationLogo = async (file, organisationId) => {
  const ext = LOGO_TYPES[file.type];
  if (!ext) throw new Error("Use a PNG, JPG, WebP or SVG image.");
  if (file.size > LOGO_MAX_BYTES) throw new Error("The logo must be 1 MB or smaller.");
  const path = `${organisationId}/logo/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from("org-logos").upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return path;
};

/** Removes a replaced or cleared logo file (best effort; the setting is what the app uses). */
export const removeOrganisationLogoFile = async (path) => {
  if (path) await supabase.storage.from("org-logos").remove([path]);
};

export const useUpdateOrganisation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    // Updates to one organisation run one after another, so responses cannot arrive out of order.
    scope: { id: `organisation-update-${organisationId}` },
    mutationFn: ({ body, reason }) =>
      apiFetch("/organisations/current", { method: "PATCH", body, organisationId, reason }),
    onSuccess: (data) => {
      queryClient.setQueryData(orgKey(organisationId, "details"), data);
      refreshOrganisation(queryClient, organisationId, { me: true });
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

/** Every department of the organisation, across sites (for choosing where people belong). */
export const useAllDepartments = ({ includeInactive = false } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: orgKey(organisationId, "departments", "all", { includeInactive }),
    queryFn: () => apiFetch(`/departments?limit=200${includeInactive ? "&includeInactive=true" : ""}`, { organisationId }),
    enabled: !!organisationId,
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
    // Sites and departments appear in members, alerts, machines and more, so refresh the whole organisation.
    onSuccess: () => refreshOrganisation(queryClient, organisationId),
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

export const useMembers = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: orgKey(organisationId, "members"),
    queryFn: () => apiFetch("/members", { organisationId }),
    enabled: !!organisationId && enabled,
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
    mutationFn: ({ action, membershipId, assignmentId, departmentMembershipId, body }) => {
      switch (action) {
        case "invite":
          return apiFetch("/members/invitations", { method: "POST", body, organisationId });
        case "status":
          return apiFetch(`/members/${membershipId}`, { method: "PATCH", body, organisationId });
        case "assign":
          return apiFetch(`/members/${membershipId}/role-assignments`, { method: "POST", body, organisationId });
        case "unassign":
          return apiFetch(`/role-assignments/${assignmentId}`, { method: "DELETE", organisationId });
        case "addDepartment":
          return apiFetch(`/members/${membershipId}/departments`, { method: "POST", body, organisationId });
        case "setPrimaryDepartment":
          return apiFetch(`/department-memberships/${departmentMembershipId}`, { method: "PATCH", body: { primary: true }, organisationId });
        case "endDepartment":
          return apiFetch(`/department-memberships/${departmentMembershipId}`, { method: "DELETE", organisationId });
        default:
          throw new Error(`Unknown member action ${action}`);
      }
    },
    onSuccess: () => {
      // Departments and roles decide who an alert reaches and what people may do.
      refreshOrganisation(queryClient, organisationId, { me: true });
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
