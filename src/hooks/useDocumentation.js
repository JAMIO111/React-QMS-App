import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";

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

/**
 * action: create | update | discard | issue | withdraw | revise | acknowledge | addRecipient. Every command answers with the alert (revise answers the new
 * draft), which is put in the cache; lists refresh.
 */
export const useAlertMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
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
    onSuccess: (data) => {
      if (data?.id) queryClient.setQueryData(key(organisationId, "detail", data.id), data);
      // Every view of alerts depends on these commands (the register, My alerts and the menu badge, the banners where work happens,
      // who has acknowledged), so refresh them all rather than guess which one the person looked at.
      queryClient.invalidateQueries({ queryKey: key(organisationId) });
    },
  });
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
    onSettled: () => queryClient.invalidateQueries({ queryKey: key(organisationId, "attachments") }),
  });
};
