import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

/** Management review (docs/risk-management-plan.md): quality objectives (MR1). */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "management-review", ...rest];

/** The fixed list of measures, with whether the caller may read what each counts. It never changes, so it is kept. */
export const useObjectiveMeasures = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "measures"),
    queryFn: () => apiFetch("/quality-objective-measures", { organisationId }),
    enabled: !!organisationId,
    staleTime: 1000 * 60 * 10,
    retry: false,
  });
};

export const useQualityObjectives = ({ all = false } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "objectives", all),
    queryFn: () => apiFetch(`/quality-objectives${all ? "?all=true" : ""}`, { organisationId }),
    enabled: !!organisationId,
    placeholderData: keepPreviousData,
    retry: false,
  });
};

export const useQualityObjective = (id, periods = 12) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "objective", id, periods),
    queryFn: () => apiFetch(`/quality-objectives/${id}?periods=${periods}`, { organisationId }),
    enabled: !!organisationId && !!id,
    placeholderData: keepPreviousData,
    retry: false,
  });
};

/** Every write answers with the whole objective; the organisation's cached data is refreshed afterwards. */
export const useObjectiveMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const send = (path, method = "POST") => apiFetch(path, { method, body, organisationId });
      switch (action) {
        case "create":
          return send("/quality-objectives");
        case "update":
          return send(`/quality-objectives/${id}`, "PATCH");
        case "retire":
          return send(`/quality-objectives/${id}/retire`);
        case "reactivate":
          return send(`/quality-objectives/${id}/reactivate`);
        case "recordValue":
          return send(`/quality-objectives/${id}/values`);
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    onSuccess: () => refreshOrganisation(queryClient, organisationId),
  });
};
