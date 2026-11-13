import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, describeApiError } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";
import { useToast } from "../contexts/ToastProvider";

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

/** The supplier quality dashboard: the base as of today, and non-conformances, deliveries and performance for the period. */
export const useSupplierDashboard = ({ from, to }) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "dashboard", from, to),
    queryFn: () => apiFetch(`${BASE}/dashboard?from=${from}&to=${to}`, { organisationId }),
    enabled: !!organisationId && !!from && !!to,
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

/** Scheduled scorecards: monthly, quarterly and annual (each on or off), which suppliers, the next periods and any problem. */
export const useScorecardSchedule = () => {
  const { organisationId } = useOrganisation();
  return useQuery({ queryKey: key(organisationId, "schedule"), queryFn: () => apiFetch(`${BASE}/performance/schedule`, { organisationId }), enabled: !!organisationId, retry: false });
};

/** A supplier's own scoring settings (empty = follows the model) and what it is scored with now. */
export const useSupplierPerformanceSettings = (id, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "settings", id),
    queryFn: () => apiFetch(`${BASE}/suppliers/${id}/performance/settings`, { organisationId }),
    enabled: !!organisationId && !!id && enabled,
    retry: false,
  });
};

/** INFORMATION ONLY: the incoming inspection level the rules would suggest for a supplier. */
export const useInspectionRecommendation = (id, days = 90, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "recommendation", id, days),
    queryFn: () => apiFetch(`${BASE}/suppliers/${id}/inspection-recommendation?days=${days}`, { organisationId }),
    enabled: !!organisationId && !!id && enabled,
    retry: false,
  });
};

/** Fetch a report for export: read-only, nothing is stored, so nothing is refreshed. `kind` is performance or audits. */
export const useSupplierReport = () => {
  const { organisationId } = useOrganisation();
  return useMutation({ mutationFn: ({ kind, from, to }) => apiFetch(`${BASE}/reports/${kind}?from=${from}&to=${to}`, { organisationId }) });
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
  const { showToast } = useToast();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      switch (action) {
        case "saveScorecard":
          return apiFetch(`${BASE}/suppliers/${id}/scorecards`, { method: "POST", body, organisationId });
        case "saveModel":
          return apiFetch(`${BASE}/performance/model`, { method: "PUT", body, organisationId });
        case "saveSchedule":
          return apiFetch(`${BASE}/performance/schedule`, { method: "PUT", body, organisationId });
        case "saveSupplierSettings":
          return apiFetch(`${BASE}/suppliers/${id}/performance/settings`, { method: "PUT", body, organisationId });
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    // A new model version shows at once on the Settings card; a refusal puts the old one back and says why.
    onMutate: async ({ action, body }) => {
      // A switch on the schedule card moves at once; the server's answer (next periods, whose authority) replaces it.
      if (action === "saveSchedule") {
        const queryKey = key(organisationId, "schedule");
        await queryClient.cancelQueries({ queryKey });
        const previous = queryClient.getQueryData(queryKey);
        if (previous) {
          const { classificationIds, ...rest } = body;
          queryClient.setQueryData(queryKey, { ...previous, ...rest, ...(classificationIds ? { classifications: previous.classifications.filter((c) => classificationIds.includes(c.id)) } : {}) });
        }
        return { previous, queryKey };
      }
      if (action !== "saveModel") return {};
      const queryKey = key(organisationId, "model");
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      if (previous) queryClient.setQueryData(queryKey, { ...previous, config: body.config });
      return { previous, queryKey };
    },
    onSuccess: (data, { action }) => {
      if (action === "saveSchedule") queryClient.setQueryData(key(organisationId, "schedule"), data);
    },
    onError: (error, vars, context) => {
      if (context?.previous) queryClient.setQueryData(context.queryKey, context.previous);
      // A dialog shows its own error; a quick change made from a card has nowhere else to say it.
      if (!vars.dialog) showToast({ type: "error", title: "Not saved", message: describeApiError(error) });
    },
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};
