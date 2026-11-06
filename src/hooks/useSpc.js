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

export const useSpcCharacteristics = (partId) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "characteristics", partId),
    queryFn: () => apiFetch(`/spc/characteristics?partId=${partId}`, { organisationId }),
    enabled: !!organisationId && !!partId,
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
