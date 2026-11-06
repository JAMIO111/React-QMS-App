import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";

/** SPC control charts (PC6): read live from the inspection measurements; baselines are saved limits. */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "spc", ...rest];

const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && p.set(k, v));
  // An empty rules list means "none", which is different from absent ("the baseline's / all"), so keep it.
  if (params.rules === "") p.set("rules", "");
  return p.toString();
};

/** `partId`, or `{ partFamilyId, all }` to list every characteristic with readings in a family (analysis). */
export const useSpcCharacteristics = (partId, { partFamilyId, all = false } = {}) => {
  const { organisationId } = useOrganisation();
  const scope = partId ? { partId } : { partFamilyId };
  return useQuery({
    queryKey: key(organisationId, "characteristics", partId, partFamilyId, all),
    queryFn: () => apiFetch(`/spc/characteristics?${qs({ ...scope, all: all ? "true" : undefined })}`, { organisationId }),
    enabled: !!organisationId && !!(partId || partFamilyId),
    retry: false,
  });
};

/** One characteristic compared between machines or the parts of a family. */
export const useSpcAnalysis = (params, enabled = true) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "analysis", params),
    queryFn: () => apiFetch(`/spc/analysis?${qs(params)}`, { organisationId }),
    enabled: !!organisationId && !!params.characteristicKey && !!(params.partId || params.partFamilyId) && enabled,
    retry: false,
  });
};

/** `params`: partId, characteristicKey, operationCode, from, to, machineId, lot, rules. */
export const useSpcChart = (params, enabled = true) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "chart", params),
    queryFn: () => apiFetch(`/spc/chart?${qs(params)}`, { organisationId }),
    enabled: !!organisationId && !!params.partId && !!params.characteristicKey && enabled,
    retry: false,
  });
};

export const useSpcBaselines = ({ partId, characteristicKey, operationCode }, enabled = true) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "baselines", partId, characteristicKey, operationCode),
    queryFn: () => apiFetch(`/spc/baselines?${qs({ partId, characteristicKey, operationCode })}`, { organisationId }),
    enabled: !!organisationId && !!partId && !!characteristicKey && enabled,
    retry: false,
  });
};

export const useCreateBaseline = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch("/spc/baselines", { method: "POST", body, organisationId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(organisationId) }),
  });
};

/** Alerts raised by control-chart signals: `status` open | acknowledged | all. */
export const useSpcAlerts = (status = "open", partId) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "alerts", status, partId),
    queryFn: () => apiFetch(`/spc/alerts?${qs({ status, partId })}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
  });
};

export const useAcknowledgeAlert = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }) => apiFetch(`/spc/alerts/${id}/acknowledge`, { method: "POST", body: { note }, organisationId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(organisationId, "alerts") }),
  });
};
