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

/** Management reviews (MR2). */
export const useManagementReviews = (status) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "reviews", status ?? ""),
    queryFn: () => apiFetch(`/management-reviews${status ? `?status=${status}` : ""}`, { organisationId }),
    enabled: !!organisationId,
    placeholderData: keepPreviousData,
    retry: false,
  });
};

export const useManagementReview = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "review", id),
    queryFn: () => apiFetch(`/management-reviews/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

const REVIEW_COMMANDS = {
  plan: ({ body }) => ["/management-reviews", "POST", body],
  update: ({ id, body }) => [`/management-reviews/${id}`, "PATCH", body],
  start: ({ id }) => [`/management-reviews/${id}/start`, "POST"],
  gather: ({ id, body }) => [`/management-reviews/${id}/gather`, "POST", body ?? {}],
  setAttendees: ({ id, body }) => [`/management-reviews/${id}/attendees`, "PUT", body],
  setMinutes: ({ id, body }) => [`/management-reviews/${id}/minutes`, "PUT", body],
  addDecision: ({ id, body }) => [`/management-reviews/${id}/decisions`, "POST", body],
  updateDecision: ({ id, body }) => [`/management-review-decisions/${id}`, "PATCH", body],
  removeDecision: ({ id }) => [`/management-review-decisions/${id}`, "DELETE"],
  addAction: ({ id, body }) => [`/management-reviews/${id}/actions`, "POST", body],
  updateAction: ({ id, body }) => [`/management-review-actions/${id}`, "PATCH", body],
  completeAction: ({ id, body }) => [`/management-review-actions/${id}/complete`, "POST", body],
  cancelAction: ({ id, body }) => [`/management-review-actions/${id}/cancel`, "POST", body],
  reopenAction: ({ id }) => [`/management-review-actions/${id}/reopen`, "POST"],
  complete: ({ id, body }) => [`/management-reviews/${id}/complete`, "POST", body ?? {}],
  cancel: ({ id, body }) => [`/management-reviews/${id}/cancel`, "POST", body],
};

/** Every review command answers with the whole review (closing an action as its owner may not); the review's cache is replaced, then the organisation refreshed. */
export const useReviewMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (command) => {
      const make = REVIEW_COMMANDS[command.action];
      if (!make) throw new Error(`Unknown action ${command.action}`);
      const [path, method, body] = make(command);
      return apiFetch(path, { method, body, organisationId });
    },
    onSuccess: (review) => {
      if (review?.inputs) queryClient.setQueryData(key(organisationId, "review", review.id), review);
      return refreshOrganisation(queryClient, organisationId);
    },
  });
};

/** Commentary and "reviewed" on one section show at once and are put back if the server refuses. */
export const useReviewInput = (reviewId) => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const detailKey = key(organisationId, "review", reviewId);
  return useMutation({
    mutationFn: ({ inputId, commentary, reviewed }) => apiFetch(`/management-review-inputs/${inputId}`, { method: "PATCH", body: { commentary, reviewed }, organisationId }),
    onMutate: async ({ inputId, commentary, reviewed }) => {
      await queryClient.cancelQueries({ queryKey: detailKey });
      const previous = queryClient.getQueryData(detailKey);
      queryClient.setQueryData(detailKey, (old) => (old ? { ...old, inputs: old.inputs.map((i) => (i.id === inputId ? { ...i, commentary, reviewed } : i)) } : old));
      return { previous };
    },
    onError: (_err, _vars, context) => context?.previous && queryClient.setQueryData(detailKey, context.previous),
    onSuccess: (review) => queryClient.setQueryData(detailKey, review),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};
