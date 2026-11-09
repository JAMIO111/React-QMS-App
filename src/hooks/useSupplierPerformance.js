import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

const key = (organisationId, ...rest) => ["api", "org", organisationId, "supplier-performance", ...rest];
const BASE = "/supplier-quality";

/** Live figures, score, band and warnings for a supplier over a period. */
export const usePerformance = (id, { from, to } = {}, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "live", id, from, to),
    queryFn: () => apiFetch(`${BASE}/suppliers/${id}/performance?from=${from}&to=${to}`, { organisationId }),
    enabled: !!organisationId && !!id && !!from && !!to && enabled,
    retry: false,
    placeholderData: (previous) => previous,
  });
};

export const useScorecards = (id, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "scorecards", id),
    queryFn: () => apiFetch(`${BASE}/suppliers/${id}/scorecards`, { organisationId }).then((r) => r.data),
    enabled: !!organisationId && !!id && enabled,
    retry: false,
  });
};

export const useScorecard = (id, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "scorecard", id),
    queryFn: () => apiFetch(`${BASE}/scorecards/${id}`, { organisationId }),
    enabled: !!organisationId && !!id && enabled,
    retry: false,
  });
};

export const useScorecardModel = () => {
  const { organisationId } = useOrganisation();
  return useQuery({ queryKey: key(organisationId, "model"), queryFn: () => apiFetch(`${BASE}/performance/model`, { organisationId }), enabled: !!organisationId, retry: false });
};

export const useWatchlist = (days) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "watchlist", days),
    queryFn: () => apiFetch(`${BASE}/performance/watchlist?days=${days}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
    placeholderData: (previous) => previous,
  });
};

/** Save a scorecard or a new model version. Everything is marked stale so the profile, history and watchlist show what changed. */
export const usePerformanceMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      switch (action) {
        case "saveScorecard":
          return apiFetch(`${BASE}/suppliers/${id}/scorecards`, { method: "POST", body, organisationId });
        case "saveModel":
          return apiFetch(`${BASE}/performance/model`, { method: "PUT", body, organisationId });
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    onSuccess: () => refreshOrganisation(queryClient, organisationId),
  });
};
