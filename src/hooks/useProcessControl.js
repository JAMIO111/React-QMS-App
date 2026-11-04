import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { key, usePagedList } from "./useMasterData";

/**
 * Process control (docs/process-control-plan.md): machines and part families (master data), part
 * revision specification values and control plans. Everything lives under the master-data query
 * key so a change anywhere refreshes parts, families and plans together.
 */
const useDetail = (path, enabled = true) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "detail", path),
    queryFn: () => apiFetch(path, { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

export const useMachines = ({ q = "", includeInactive = false, siteId } = {}) => usePagedList("machines", { q, includeInactive, siteId });
export const usePartFamilies = ({ q = "", includeInactive = false } = {}) => usePagedList("part-families", { q, includeInactive });
export const usePartFamily = (id) => useDetail(`/part-families/${id}`, !!id);
export const useSpecValues = (revisionId) => {
  const query = useDetail(`/part-revisions/${revisionId}/characteristics`, !!revisionId);
  return { ...query, data: query.data?.data };
};

export const useControlPlans = ({ q = "", includeInactive = false, partFamilyId, status } = {}) =>
  usePagedList("control-plans", { q, includeInactive, partFamilyId, status });
export const useControlPlan = (id) => useDetail(`/control-plans/${id}`, !!id);
export const useControlPlanHistory = (id) => {
  const query = useDetail(`/control-plans/${id}/history`, !!id);
  return { ...query, data: query.data?.data };
};

/** `request` is { path, method, body, reason }; refreshes all master data and plans on success. */
export const useProcessControlMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, method = "POST", body, reason }) => apiFetch(path, { method, body, organisationId, reason }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(organisationId) }),
  });
};

export const REVISION_STATUS = {
  draft: { label: "Draft", className: "bg-warning-color/15 text-primary-text" },
  pending_approval: { label: "Awaiting approval", className: "bg-brand-primary/15 text-primary-text" },
  approved: { label: "Approved", className: "bg-success-color/10 text-success-color" },
  effective: { label: "Effective", className: "bg-success-color/20 text-success-color font-medium" },
  superseded: { label: "Superseded", className: "bg-border-color text-secondary-text" },
  obsolete: { label: "Obsolete", className: "bg-border-color text-secondary-text line-through" },
};

export const useControlPlanRevision = (id) => useDetail(`/control-plan-revisions/${id}`, !!id);
export const useRevisionComparison = (id, enabled = true) => useDetail(`/control-plan-revisions/${id}/comparison`, !!id && enabled);

/** Which plan applies to a part and its resolved requirements (or why it is blocked). */
export const useResolution = ({ partId, operationCode, siteId } = {}, enabled = true) => {
  const qs = new URLSearchParams({ partId: partId ?? "" });
  if (operationCode) qs.set("operationCode", operationCode);
  if (siteId) qs.set("siteId", siteId);
  return useDetail(`/control-plan-resolution?${qs}`, !!partId && enabled);
};
