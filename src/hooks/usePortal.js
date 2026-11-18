import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { uploadPortalScarFile } from "../api/supabaseApi";
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

// ---- Sharing records (PT2) ----

const sharesKey = (organisationId, kind, recordId) => ["api", "org", organisationId, "external-access", "shares", kind, recordId];

/** Who a record (kind "ncr" | "capa") is shared with, how they have used it, and who it could still be shared with. */
export const useShares = (kind, recordId, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: sharesKey(organisationId, kind, recordId),
    queryFn: () => apiFetch(`/external-access/shares?kind=${kind}&recordId=${recordId}`, { organisationId }),
    enabled: !!organisationId && !!recordId && enabled,
    retry: false,
  });
};

/** The conversation on a share, as staff see it. */
export const useShareComments = (shareId, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: ["api", "org", organisationId, "external-access", "comments", shareId],
    queryFn: () => apiFetch(`/external-access/shares/${shareId}/comments`, { organisationId }),
    enabled: !!organisationId && !!shareId && enabled,
    retry: false,
  });
};

/** Who in the party acknowledged a shared document or alert (staff). */
export const useShareAcknowledgements = (shareId, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: ["api", "org", organisationId, "external-access", "acknowledgements", shareId],
    queryFn: () => apiFetch(`/external-access/shares/${shareId}/acknowledgements`, { organisationId }),
    enabled: !!organisationId && !!shareId && enabled,
    retry: false,
  });
};

/** Share, withdraw, comment, withdraw a comment. Every answer is the record's shares or the conversation, which replaces the cache. */
export const useShareMutation = (kind, recordId) => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      switch (action) {
        case "share":
          return apiFetch("/external-access/shares", { method: "POST", body: { kind, recordId, ...body }, organisationId });
        case "withdraw":
          return apiFetch(`/external-access/shares/${id}/withdraw`, { method: "POST", body, organisationId });
        case "comment":
          return apiFetch(`/external-access/shares/${id}/comments`, { method: "POST", body, organisationId });
        case "withdrawComment":
          return apiFetch(`/external-access/comments/${id}/withdraw`, { method: "POST", organisationId });
        default:
          throw new Error(`Unknown share action ${action}`);
      }
    },
    onSuccess: (data, vars) => {
      if (vars.action === "share" || vars.action === "withdraw") queryClient.setQueryData(sharesKey(organisationId, kind, recordId), data);
      if (vars.action === "comment" || vars.action === "withdrawComment") queryClient.setQueryData(["api", "org", organisationId, "external-access", "comments", vars.shareId ?? vars.id], data);
    },
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** Everything shared with the person's supplier or customer in an organisation. */
export const usePortalShares = (organisationId, { enabled = true } = {}) => {
  const { user } = useAuth();
  return useQuery({
    queryKey: portalKey(user?.id, organisationId, "shares"),
    queryFn: () => apiFetch("/portal/shares", { organisationId }),
    enabled: !!user && !!organisationId && enabled,
    retry: false,
  });
};

/** One shared record as the party sees it, with its conversation (opening it records that the person has seen it). */
export const usePortalShare = (organisationId, shareId) => {
  const { user } = useAuth();
  return useQuery({
    queryKey: portalKey(user?.id, organisationId, "share", shareId),
    queryFn: () => apiFetch(`/portal/shares/${shareId}`, { organisationId }),
    enabled: !!user && !!organisationId && !!shareId,
    retry: false,
  });
};

export const usePortalShareMutation = (organisationId, shareId) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      if (action === "comment") return apiFetch(`/portal/shares/${shareId}/comments`, { method: "POST", body, organisationId });
      if (action === "acknowledge") return apiFetch(`/portal/shares/${shareId}/acknowledge`, { method: "POST", body: body ?? {}, organisationId });
      return apiFetch(`/portal/comments/${id}/withdraw`, { method: "POST", organisationId });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["api", "portal", user?.id, organisationId] }),
  });
};

// ---- Corrective action requests (PT3a) ----

/** The SCARs issued to the person's supplier, those awaiting a response first. */
export const usePortalScars = (organisationId, { enabled = true } = {}) => {
  const { user } = useAuth();
  return useQuery({
    queryKey: portalKey(user?.id, organisationId, "scars"),
    queryFn: () => apiFetch("/portal/scars", { organisationId }),
    enabled: !!user && !!organisationId && enabled,
    retry: false,
  });
};

/** One SCAR as the supplier sees it, with what they may do next. */
export const usePortalScar = (organisationId, scarId) => {
  const { user } = useAuth();
  return useQuery({
    queryKey: portalKey(user?.id, organisationId, "scar", scarId),
    queryFn: () => apiFetch(`/portal/scars/${scarId}`, { organisationId }),
    enabled: !!user && !!organisationId && !!scarId,
    retry: false,
  });
};

/**
 * Acknowledge, respond, ask for more time, take that back. The server decides what is allowed, so these wait for its answer (no guess) and the answer is
 * the SCAR, which replaces the cached copy. Everything the person has in the portal is refreshed afterwards.
 */
export const usePortalScarMutation = (organisationId, scarId) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      switch (action) {
        case "acknowledge":
          return apiFetch(`/portal/scars/${scarId}/acknowledge`, { method: "POST", body: body ?? {}, organisationId });
        case "respond":
          return apiFetch(`/portal/scars/${scarId}/respond`, { method: "POST", body, organisationId });
        case "extend":
          return apiFetch(`/portal/scars/${scarId}/extensions`, { method: "POST", body, organisationId });
        case "withdrawExtension":
          return apiFetch(`/portal/scar-extensions/${id}/withdraw`, { method: "POST", body, organisationId });
        case "completeAction":
          return apiFetch(`/portal/scar-actions/${id}/complete`, { method: "POST", body, organisationId });
        case "removeFile":
          return apiFetch(`/portal/scar-files/${id}/remove`, { method: "POST", organisationId });
        case "uploadFile":
          return uploadPortalScarFile(body.file, organisationId, scarId);
        default:
          throw new Error(`Unknown SCAR action ${action}`);
      }
    },
    onSuccess: (data) => queryClient.setQueryData(portalKey(user?.id, organisationId, "scar", scarId), data),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["api", "portal", user?.id, organisationId] }),
  });
};

/** A short link to a file of a SCAR the person may see (ten minutes). Opens in a new tab. */
export const openPortalScarFile = async (organisationId, fileId) => {
  const { url } = await apiFetch(`/portal/scar-files/${fileId}/download-url`, { method: "POST", organisationId });
  window.open(url, "_blank", "noopener");
};

/** A short link (ten minutes) to a file of a shared document; opens it in a new tab. */
export const openPortalDocumentFile = async (organisationId, shareId, fileId) => {
  const res = await apiFetch(`/portal/shares/${shareId}/file-url`, { method: "POST", body: { fileId }, organisationId });
  window.open(res.url, "_blank", "noopener");
};
