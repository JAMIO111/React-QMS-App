import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { generateSignedUrl, removeOrganisationFile, uploadToPath } from "../api/supabaseApi";
import { useAuth } from "../contexts/AuthProvider";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";
import { guessCache, pendingId, rollbackGuess } from "../lib/optimistic";

/** GET /me — profile, memberships and effective permissions (requires the API). */
export const useMe = (options = {}) => {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["api", "me", user?.id],
    queryFn: () => apiFetch("/me"),
    enabled: !!user,
    staleTime: 1000 * 60,
    retry: false,
    // e.g. { refetchInterval } while someone waits for a seat (docs/seats-and-member-onboarding-plan.md SM4)
    ...options,
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

/**
 * Whether the current organisation may be used (accessState: open | needs_subscription | lapsed) and where the owner's set-up wizard is
 * (onboarding: none | in_progress | complete). Both come from GET /me.
 */
export const useOrganisationAccess = () => {
  const { organisationId } = useOrganisation();
  const me = useMe();
  const membership = me.data?.memberships?.find((m) => m.organisation.id === organisationId);
  return { accessState: membership?.accessState ?? "open", onboarding: membership?.onboarding ?? "none", isLoading: me.isLoading };
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
    queryFn: () => generateSignedUrl("org-logos", path, 60 * 60),
    enabled: !!organisationId && !!path,
    staleTime: 4 * 60 * 1000, // links last five minutes while network restrictions are enforced
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
  await uploadToPath(file, "org-logos", organisationId, path, file.type);
  return path;
};

/** Removes a replaced or cleared logo file (best effort; the setting is what the app uses). */
export const removeOrganisationLogoFile = async (path) => {
  if (path) await removeOrganisationFile("org-logos", path);
};

/**
 * PATCH /organisations/current. Optimistic: the organisation's details (and its name in /me, for the switcher) change at once and go back if
 * the server refuses (pass `guess: false` to wait instead). The server's answer replaces the details only when no later change is still waiting, so quick toggles never flicker back.
 */
export const useUpdateOrganisation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const mutationKey = ["organisation-update", organisationId];
  return useMutation({
    mutationKey,
    // Updates to one organisation run one after another, so responses cannot arrive out of order.
    scope: { id: `organisation-update-${organisationId}` },
    mutationFn: ({ body, reason }) =>
      apiFetch("/organisations/current", { method: "PATCH", body, organisationId, reason }),
    // `guess: false` waits for the server (security settings such as requiring two-factor).
    onMutate: async ({ body, guess = true }) => {
      if (!guess) return { optimistic: false, snapshot: [] };
      const details = await guessCache(queryClient, orgKey(organisationId, "details"), (data) => guessOrganisation(data, body));
      const me = body?.name ? await guessCache(queryClient, ["api", "me"], (data) => guessMyOrganisationName(data, organisationId, body.name)) : { snapshot: [] };
      return { optimistic: details.optimistic || me.optimistic, snapshot: [...details.snapshot, ...me.snapshot] };
    },
    onError: (_error, _vars, context) => rollbackGuess(queryClient, context),
    onSuccess: (data) => {
      // This mutation is still counted; more than one means a later change is waiting and its guess should stay on screen.
      if (queryClient.isMutating({ mutationKey }) <= 1) queryClient.setQueryData(orgKey(organisationId, "details"), data);
    },
    onSettled: () => refreshOrganisation(queryClient, organisationId, { me: true }),
  });
};

/** The organisation's details as they will be after `body` is saved: top-level fields and `settings` keys are taken as sent. */
export const guessOrganisation = (data, body = {}) => {
  if (!data || typeof data !== "object" || !body || typeof body !== "object") return data;
  const { settings, ...top } = body;
  const next = { ...data };
  let changed = false;
  for (const [k, v] of Object.entries(top)) {
    if (v !== undefined && next[k] !== v) {
      next[k] = v;
      changed = true;
    }
  }
  if (settings && typeof settings === "object") {
    const merged = { ...(data.settings ?? {}) };
    for (let [k, v] of Object.entries(settings)) {
      // The server stores these in capitals.
      if ((k === "baseCurrency" || k === "ncrReferencePrefix") && typeof v === "string") v = v.trim().toUpperCase();
      if (v !== undefined && merged[k] !== v) {
        merged[k] = v;
        changed = true;
      }
    }
    next.settings = merged;
  }
  return changed ? next : data;
};

/** /me with the organisation's new name in its membership (the organisation switcher and tab title read it). */
export const guessMyOrganisationName = (data, organisationId, name) => {
  if (!Array.isArray(data?.memberships)) return data;
  let changed = false;
  const memberships = data.memberships.map((m) => {
    if (m.organisation?.id !== organisationId || m.organisation.name === name) return m;
    changed = true;
    return { ...m, organisation: { ...m.organisation, name } };
  });
  return changed ? { ...data, memberships } : data;
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

/**
 * Create/update for sites and departments. Optimistic: an edit (rename, time zone, currency, switch on or off) shows at once in every site and
 * department list, and a new department appears in its site's lists as a placeholder row (no actions until the server has made it); a refusal
 * puts the lists back. A new site waits for the server (its departments need its id).
 */
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
    onMutate: async (vars) => {
      if (!vars.id && vars.resource !== "departments") return { optimistic: false, snapshot: [] };
      const guesses = [];
      for (const list of ["sites", "departments"]) {
        guesses.push(await guessCache(queryClient, orgKey(organisationId, list), (data, queryKey) => guessStructure(data, vars, queryKey)));
      }
      return { optimistic: guesses.some((g) => g.optimistic), snapshot: guesses.flatMap((g) => g.snapshot) };
    },
    onError: (_error, _vars, context) => rollbackGuess(queryClient, context),
    // Sites and departments appear in members, alerts, machines and more, so refresh the whole organisation.
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/**
 * A cached site or department list (`{ data: [...] }`, key `[…, "sites" | "departments", …]`) as it will be after a structure change: an edit
 * merges the body into the row with that id; a new department is added to the lists of its site (and the organisation-wide ones), not to a list
 * of active ones only when it would not show there. Anything else is left alone.
 */
export const guessStructure = (data, { resource, id, body = {} }, queryKey = []) => {
  const rows = data?.data;
  if (!Array.isArray(rows)) return data;
  const kind = queryKey[3];
  if (id) {
    if (kind !== resource) return data;
    let changed = false;
    const next = rows.map((r) => {
      if (r.id !== id) return r;
      changed = true;
      return { ...r, ...body };
    });
    // A list of active ones only loses a row switched off.
    const options = queryKey.find((k) => k && typeof k === "object" && "includeInactive" in k);
    const kept = options && !options.includeInactive && body.active === false ? next.filter((r) => r.id !== id) : next;
    return changed ? { ...data, data: kept } : data;
  }
  if (resource !== "departments" || kind !== "departments") return data;
  const forSite = queryKey[4];
  if (forSite !== "all" && forSite !== body.siteId) return data;
  const row = { id: pendingId(), code: body.code ?? "", name: body.name ?? "", siteId: body.siteId ?? null, active: true };
  return { ...data, data: [...rows, row] };
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

export const useRoles = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: orgKey(organisationId, "roles"),
    queryFn: () => apiFetch("/roles", { organisationId }),
    enabled: !!organisationId && enabled,
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
        case "inviteMany":
          return apiFetch("/members/invitations/bulk", { method: "POST", body, organisationId });
        case "resend":
          return apiFetch(`/members/${membershipId}/invitation/resend`, { method: "POST", organisationId });
        case "revoke":
          return apiFetch(`/members/${membershipId}/invitation/revoke`, { method: "POST", organisationId });
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
    // The person's card changes at once; `show` carries the names for a chip that is added (the server only gets ids).
    onMutate: (vars) => guessCache(queryClient, orgKey(organisationId, "members"), (data) => guessMembers(data, vars)),
    onError: (_error, _vars, context) => rollbackGuess(queryClient, context),
    onSettled: () => {
      // Departments and roles decide who an alert reaches and what people may do.
      refreshOrganisation(queryClient, organisationId, { me: true });
    },
  });
};

/** The members list as it will be after a member action (see useMemberMutation). Unknown actions leave it alone. */
export const guessMembers = (data, { action, membershipId, assignmentId, departmentMembershipId, body = {}, show = {} }) => {
  const rows = data?.data;
  if (!Array.isArray(rows)) return data;
  const mapMember = (match, change) => {
    let changed = false;
    const next = rows.map((m) => {
      if (!match(m)) return m;
      const n = change(m);
      if (n !== m) changed = true;
      return n;
    });
    return changed ? { ...data, data: next } : data;
  };
  switch (action) {
    case "status":
      return body.status ? mapMember((m) => m.membershipId === membershipId, (m) => ({ ...m, status: body.status })) : data;
    case "revoke":
      return mapMember((m) => m.membershipId === membershipId, (m) => ({ ...m, status: "removed" }));
    case "assign":
      return mapMember(
        (m) => m.membershipId === membershipId,
        (m) => ({ ...m, roles: [...(m.roles ?? []), { assignmentId: pendingId(), roleId: body.roleId, roleKey: show.roleKey ?? null, roleName: show.roleName ?? "…", siteId: body.siteId ?? null }] }),
      );
    case "unassign":
      return mapMember((m) => (m.roles ?? []).some((r) => r.assignmentId === assignmentId), (m) => ({ ...m, roles: m.roles.filter((r) => r.assignmentId !== assignmentId) }));
    case "addDepartment":
      return mapMember(
        (m) => m.membershipId === membershipId,
        (m) => {
          const list = m.departments ?? [];
          const added = { id: pendingId(), departmentId: body.departmentId, code: show.code ?? null, name: show.name ?? "…", siteId: show.siteId ?? null, siteName: show.siteName ?? null, isPrimary: list.length === 0 };
          return { ...m, departments: [...list, added] };
        },
      );
    case "setPrimaryDepartment":
      return mapMember(
        (m) => (m.departments ?? []).some((d) => d.id === departmentMembershipId),
        (m) => ({ ...m, departments: m.departments.map((d) => ({ ...d, isPrimary: d.id === departmentMembershipId })) }),
      );
    case "endDepartment":
      return mapMember(
        (m) => (m.departments ?? []).some((d) => d.id === departmentMembershipId),
        (m) => ({ ...m, departments: m.departments.filter((d) => d.id !== departmentMembershipId) }),
      );
    default:
      return data;
  }
};

/** PATCH /me: the signed-in person's own name and job title. Optimistic: /me shows the new name at once and goes back if the save fails. */
export const useUpdateProfile = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch("/me", { method: "PATCH", body }),
    onMutate: (body) => guessCache(queryClient, ["api", "me"], (data) => guessProfile(data, body)),
    onError: (_error, _body, context) => rollbackGuess(queryClient, context),
    // Names show on every screen of the organisation.
    onSettled: () => refreshOrganisation(queryClient, organisationId, { me: true }),
  });
};

/** /me with the profile fields in `body` (firstName, surname, jobTitle) as sent. */
export const guessProfile = (data, body = {}) => {
  if (!data?.profile || !body || typeof body !== "object") return data;
  const profile = { ...data.profile };
  let changed = false;
  for (const k of ["firstName", "surname", "jobTitle"]) {
    if (body[k] !== undefined && profile[k] !== body[k]) {
      profile[k] = body[k];
      changed = true;
    }
  }
  return changed ? { ...data, profile } : data;
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
 * Whether to show a menu item that needs `permission` (or any of a list of permissions). While permissions are unknown (loading, or
 * the API is not reachable) items stay visible — the server still refuses what is not allowed.
 */
export const useCanSee = () => {
  const { can, isLoading, error } = usePermissions();
  // `permission` may be a list: any one of them is enough.
  return (permission) => !permission || isLoading || !!error || (Array.isArray(permission) ? permission.some(can) : can(permission));
};
