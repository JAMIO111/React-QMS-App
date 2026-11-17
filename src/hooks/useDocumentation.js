import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, describeApiError } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { useToast } from "../contexts/ToastProvider";
import { refreshOrganisation } from "../lib/refresh";
import { guessCache, pendingId, rollbackGuess, settle, updateById } from "../lib/optimistic";

/** Quality alerts (DOC1): the register, one alert with its scope and revisions, and the lifecycle actions. */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "documentation", ...rest];

const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && p.set(k, v));
  return p.toString();
};

export const useQualityAlerts = (filters = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "list", filters),
    queryFn: () => apiFetch(`/quality-alerts?${qs(filters)}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
  });
};

export const useQualityAlert = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "detail", id),
    queryFn: () => apiFetch(`/quality-alerts/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** Alerts addressed to the signed-in person. */
export const useMyAlerts = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "mine"),
    queryFn: () => apiFetch("/quality-alerts/mine", { organisationId }),
    enabled: !!organisationId,
    retry: false,
  });
};

/** Just the numbers for the menu badge; checked again every few minutes (there is no push). */
export const useMyAlertCount = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "mine-count"),
    queryFn: () => apiFetch("/quality-alerts/mine/count", { organisationId }),
    enabled: !!organisationId && enabled,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
};

/** Who was asked to acknowledge an alert and who has (documentation.manage). */
export const useRecipients = (id, enabled = true) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "recipients", id),
    queryFn: () => apiFetch(`/quality-alerts/${id}/recipients`, { organisationId }),
    enabled: !!organisationId && !!id && enabled,
    retry: false,
  });
};

/** How many people each target of a draft reaches. */
export const useRecipientsPreview = (id, enabled = true) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "recipients-preview", id),
    queryFn: () => apiFetch(`/quality-alerts/${id}/recipients-preview`, { organisationId }),
    enabled: !!organisationId && !!id && enabled,
    staleTime: 0,
    retry: false,
  });
};

/** Commands shown before the server answers (see guessAlerts); their refusals come back as a toast, as the dialog has closed. */
export const ALERT_GUESSED = new Set(["acknowledge", "addRecipient", "withdraw", "reopen", "discard"]);

/**
 * action: create | update | discard | issue | withdraw | revise | acknowledge | addRecipient. Every command answers with the alert (revise answers the new
 * draft), which is put in the cache; lists refresh. Guessed commands (ALERT_GUESSED) change the screen at once; `show.name` names an added person,
 * `failed` titles the toast if it is refused.
 */
export const useAlertMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      switch (action) {
        case "create":
          return apiFetch("/quality-alerts", { method: "POST", body, organisationId });
        case "update":
          return apiFetch(`/quality-alerts/${id}`, { method: "PATCH", body, organisationId });
        case "discard":
          return apiFetch(`/quality-alerts/${id}`, { method: "DELETE", organisationId });
        case "issue":
          return apiFetch(`/quality-alerts/${id}/issue`, { method: "POST", organisationId });
        case "withdraw":
          return apiFetch(`/quality-alerts/${id}/withdraw`, { method: "POST", body, organisationId });
        case "reopen":
          return apiFetch(`/quality-alerts/${id}/reopen`, { method: "POST", body, organisationId });
        case "revise":
          return apiFetch(`/quality-alerts/${id}/revisions`, { method: "POST", body, organisationId });
        case "acknowledge":
          return apiFetch(`/quality-alerts/${id}/acknowledge`, { method: "POST", body: body ?? {}, organisationId });
        case "addRecipient":
          return apiFetch(`/quality-alerts/${id}/recipients`, { method: "POST", body, organisationId });
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    onMutate: (vars) => (ALERT_GUESSED.has(vars?.action) ? guessCache(queryClient, ["api", "org", organisationId], (data, queryKey) => guessAlerts(data, vars, queryKey)) : { optimistic: false }),
    onError: (error, vars, context) => {
      rollbackGuess(queryClient, context);
      if (ALERT_GUESSED.has(vars?.action) && !error?.cancelled) toast?.showToast({ type: "error", title: vars.failed ?? "Not saved", message: describeApiError(error) });
    },
    onSuccess: (data, vars) => {
      if (data?.id && vars?.action !== "discard") queryClient.setQueryData(key(organisationId, "detail", data.id), data);
    },
    // Every view of alerts depends on these commands (the register, My alerts and the menu badge, the banners where work happens,
    // who has acknowledged), so refresh them all rather than guess which one the person looked at.
    onSettled: (_data, _error, _vars, context) => settle(queryClient, organisationId, context),
  });
};

/** Cached alert data as it will be after a guessed command of useAlertMutation (`queryKey` says which cached query it is). */
export const guessAlerts = (data, { action, id, body = {}, show = {} } = {}, queryKey = []) => {
  if (!id) return data;
  const now = new Date().toISOString();
  switch (action) {
    case "acknowledge": {
      let wasOpen = false;
      let next = updateById(data, id, (a) => {
        if (!a.me || a.me.acknowledgedAt) return a;
        if (a.state === "open") wasOpen = true;
        return { ...a, me: { ...a.me, acknowledgedAt: now, note: body.note ?? null, overdue: false }, ...(a.state === "open" ? { state: "acknowledged" } : {}) };
      });
      // My alerts and the menu badge count one fewer to acknowledge.
      if (wasOpen && typeof next?.unacknowledged === "number") next = { ...next, unacknowledged: Math.max(0, next.unacknowledged - 1) };
      if (queryKey[3] === "documentation" && queryKey.includes("mine-count") && typeof next?.unacknowledged === "number" && next.unacknowledged > 0) next = { ...next, unacknowledged: next.unacknowledged - 1 };
      return next;
    }
    case "addRecipient": {
      if (!(queryKey.includes("recipients") && queryKey.at(-1) === id && Array.isArray(data?.data))) return data;
      const row = { id: pendingId(), name: show.name ?? "…", reachedVia: ["Added"], firstViewedAt: null, acknowledgedAt: null, note: null, overdue: false };
      return { ...data, data: [...data.data, row], ...(data.totals ? { totals: { ...data.totals, total: (data.totals.total ?? 0) + 1 } } : {}) };
    }
    case "withdraw":
      return updateById(data, id, (a) => ("status" in a ? { ...a, status: "withdrawn" } : a));
    case "reopen":
      return updateById(data, id, (a) => ("status" in a ? { ...a, status: "active", ...("expiryDate" in a ? { expiryDate: body.expiryDate ?? a.expiryDate } : {}) } : a));
    case "discard":
      return queryKey.includes("detail") ? data : updateById(data, id, (a) => a, { remove: true });
    default:
      return data;
  }
};

/**
 * Alerts in force that affect the work on screen: { partId, partFamilyId, machineId, operationCode } (at least one). Read-only; refreshed when
 * the screen is revisited. Needs documentation.read, so pass `enabled` from the permission check.
 */
export const useActiveAlerts = (context, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  const params = { partId: context.partId, partFamilyId: context.partFamilyId, machineId: context.machineId, operationCode: context.operationCode };
  const any = Object.values(params).some(Boolean);
  return useQuery({
    queryKey: key(organisationId, "active", params),
    queryFn: () => apiFetch(`/quality-alerts/active?${qs(params)}`, { organisationId }),
    enabled: !!organisationId && enabled && any,
    staleTime: 30_000,
    retry: false,
    select: (r) => r.data,
  });
};

/** Files on an alert (removed ones included, for the draft editor). */
export const useAlertAttachments = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "attachments", id),
    queryFn: () => apiFetch(`/quality-alerts/${id}/attachments?deleted=include`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
    select: (r) => r.data,
  });
};

/** Remove or restore a file on a draft: mutate({ path: "/quality-alert-attachments/<id>/delete", body }). */
export const useAlertAttachmentMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, method = "POST", body }) => apiFetch(path, { method, body, organisationId }),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};
