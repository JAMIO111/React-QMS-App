import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { optimisticHandlers, settle } from "../lib/optimistic";
import { useOrganisation } from "../contexts/OrganisationProvider";

const key = (organisationId, ...rest) => ["api", "org", organisationId, "calibration", ...rest];

const toQuery = (params) => {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) return;
    qs.set(k, Array.isArray(v) ? v.join(",") : String(v));
  });
  return qs.toString();
};

const useOrgQuery = (parts, path, { enabled = true, select, keepPrevious, staleTime } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, ...parts),
    queryFn: () => apiFetch(path, { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
    ...(select ? { select } : {}),
    ...(keepPrevious ? { placeholderData: keepPreviousData } : {}),
    ...(staleTime ? { staleTime } : {}),
  });
};
const dataOf = (r) => r.data;

/** Gauge register page: { data, page, pageSize, total }. */
export const useGauges = (params) => useOrgQuery(["gauges", params], `/gauges?${toQuery(params)}`, { keepPrevious: true });
export const useGauge = (id) => useOrgQuery(["gauge", id], `/gauges/${id}`, { enabled: !!id });
export const useGaugeCharacteristics = (id, { includeInactive = false } = {}) =>
  useOrgQuery(["gauge", id, "characteristics", includeInactive], `/gauges/${id}/characteristics${includeInactive ? "?includeInactive=true" : ""}`, { enabled: !!id, select: dataOf });
export const useGaugeCalibrations = (id, { deleted = "exclude" } = {}) =>
  useOrgQuery(["gauge", id, "calibrations", deleted], `/gauges/${id}/calibrations?deleted=${deleted}`, { enabled: !!id, select: dataOf });
export const useGaugeHistory = (id) => useOrgQuery(["gauge", id, "history"], `/gauges/${id}/history`, { enabled: !!id, select: dataOf });

export const useCalibration = (id) => useOrgQuery(["record", id], `/calibrations/${id}`, { enabled: !!id });
export const useCalibrationAttachments = (id) => useOrgQuery(["record", id, "attachments"], `/calibrations/${id}/attachments?deleted=include`, { enabled: !!id, select: dataOf });

export const useGaugeTypes = ({ includeInactive = false } = {}) =>
  useOrgQuery(["types", includeInactive], `/gauge-types${includeInactive ? "?includeInactive=true" : ""}`, { select: dataOf, staleTime: 60_000 });
export const useGaugeTypeCharacteristics = (id, { includeInactive = false } = {}) =>
  useOrgQuery(["types", id, "characteristics", includeInactive], `/gauge-types/${id}/characteristics${includeInactive ? "?includeInactive=true" : ""}`, {
    enabled: !!id,
    select: dataOf,
  });

/** Calibration dashboard figures for a period ({ from, to } — YYYY-MM-DD). */
export const useCalibrationDashboard = ({ from, to }) =>
  useOrgQuery(["dashboard", from, to], `/calibration-dashboard?${toQuery({ from, to })}`, { enabled: !!from && !!to, keepPrevious: true });

/**
 * Any calibration change: { path, method, body }. Refreshes every calibration query of the
 * organisation (registers, gauges, records, types, dashboard) and the NC lists (Raise NC).
 */
export const useCalibrationMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, method = "POST", body }) => apiFetch(path, { method, body, organisationId }),
    ...optimisticHandlers(queryClient, key(organisationId)),
    onSuccess: (_data, { path }, context) => {
      if (path.endsWith("/raise-ncr")) queryClient.invalidateQueries({ queryKey: ["api", "org", organisationId, "ncr"] });
      return settle(queryClient, key(organisationId), context);
    },
  });
};
