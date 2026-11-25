import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";
import { useToast } from "../contexts/ToastProvider";
import { pendingId, updateById } from "../lib/optimistic";
import { commandGuessHandlers, nowIso, setFields } from "../lib/guessCommands";

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
  const toast = useToast();
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
    // Changes and retiring show at once; a refusal puts the objective back and says why in a toast.
    ...commandGuessHandlers({ queryClient, prefix: key(organisationId), guess: guessObjective, guessed: OBJECTIVE_GUESSED, showToast: toast?.showToast }),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** Objective commands shown before the server answers. Recording a value waits: the server works out the period's standing against the target. */
export const OBJECTIVE_GUESSED = new Set(["update", "retire", "reactivate"]);

/** Cached objectives as they will be after a command (`show.ownerName` names a new owner). */
export const guessObjective = (data, { action, id, body = {}, show = {} }) => {
  switch (action) {
    case "update":
      return updateById(data, id, (o) => {
        const next = setFields(o, body);
        return "ownerId" in body && o.owner && typeof o.owner === "object" ? { ...next, owner: { ...o.owner, id: body.ownerId, name: show.ownerName ?? o.owner.name } } : next;
      });
    case "retire":
      return updateById(data, id, (o) => ("active" in o ? { ...o, active: false, retiredReason: body.reason ?? null, retiredAt: nowIso() } : o));
    case "reactivate":
      return updateById(data, id, (o) => ("active" in o ? { ...o, active: true, retiredReason: null, retiredAt: null, retiredBy: null } : o));
    default:
      return data;
  }
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
  const toast = useToast();
  return useMutation({
    mutationFn: (command) => {
      const make = REVIEW_COMMANDS[command.action];
      if (!make) throw new Error(`Unknown action ${command.action}`);
      const [path, method, body] = make(command);
      return apiFetch(path, { method, body, organisationId });
    },
    // The guessed commands (REVIEW_GUESSED) show at once; a refusal puts the review back and says why in a toast.
    ...commandGuessHandlers({ queryClient, prefix: key(organisationId), guess: guessReview, guessed: REVIEW_GUESSED, showToast: toast?.showToast }),
    onSuccess: (review) => {
      if (review?.inputs) queryClient.setQueryData(key(organisationId, "review", review.id), review);
    },
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/**
 * Review commands shown before the server answers. The others wait: planning makes the reference, starting and gathering read every module,
 * completing and cancelling freeze the record after the database's checks, and the minutes are saved from the editor, which already shows them.
 */
export const REVIEW_GUESSED = new Set([
  "update", "setAttendees", "addDecision", "updateDecision", "removeDecision", "addAction", "updateAction", "completeAction", "cancelAction", "reopenAction",
]);

/**
 * Cached review data as it will be after a command (`useReviewMutation` vars). `show`: `chairName`, `ownerName`, `attendees` (with `name`) for names
 * the server only gets ids of.
 */
export const guessReview = (data, { action, id, body = {}, show = {} }) => {
  const now = nowIso();
  const withOwner = (x) => ("ownerId" in body ? { ...x, owner: { ...(x.owner ?? {}), id: body.ownerId, name: show.ownerName ?? x.owner?.name ?? "…" } } : x);
  const addTo = (list, item) => updateById(data, id, (r) => (Array.isArray(r[list]) ? { ...r, [list]: [...r[list], item] } : r));
  switch (action) {
    case "update":
      return updateById(data, id, (r) => {
        const next = setFields(r, body);
        return "chairId" in body && r.chair && typeof r.chair === "object" ? { ...next, chair: { ...r.chair, id: body.chairId, name: show.chairName ?? r.chair.name } } : next;
      });
    case "setAttendees":
      return show.attendees ? updateById(data, id, (r) => ("attendees" in r ? { ...r, attendees: show.attendees } : r)) : data;
    case "addDecision":
      return addTo("decisions", { id: pendingId(), description: body.description ?? "", category: body.category ?? null });
    case "updateDecision":
      return updateById(data, id, (d) => setFields(d, body));
    case "removeDecision":
      return updateById(data, id, (d) => d, { remove: true });
    case "addAction":
      return addTo("actions", withOwner({ id: pendingId(), description: body.description ?? "", dueDate: body.dueDate ?? null, decisionId: body.decisionId ?? null, status: "open", mine: false, doneNote: null, cancelReason: null }));
    case "updateAction":
      return updateById(data, id, (a) => withOwner(setFields(a, body)));
    case "completeAction":
      return updateById(data, id, (a) => ({ ...a, status: "done", doneNote: body.note ?? null, doneAt: now }));
    case "cancelAction":
      return updateById(data, id, (a) => ({ ...a, status: "cancelled", cancelReason: body.reason ?? null }));
    case "reopenAction":
      return updateById(data, id, (a) => ({ ...a, status: "open", doneNote: null, doneAt: null, cancelReason: null }));
    default:
      return data;
  }
};

/** Commentary and "reviewed" on one section show at once and are put back if the server refuses. */
export const useReviewInput = (reviewId) => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const detailKey = key(organisationId, "review", reviewId);
  const mutationKey = ["review-input", reviewId];
  return useMutation({
    mutationKey,
    mutationFn: ({ inputId, commentary, reviewed }) => apiFetch(`/management-review-inputs/${inputId}`, { method: "PATCH", body: { commentary, reviewed }, organisationId }),
    onMutate: async ({ inputId, commentary, reviewed }) => {
      await queryClient.cancelQueries({ queryKey: detailKey });
      const previous = queryClient.getQueryData(detailKey);
      queryClient.setQueryData(detailKey, (old) => (old ? { ...old, inputs: old.inputs.map((i) => (i.id === inputId ? { ...i, commentary, reviewed } : i)) } : old));
      return { previous };
    },
    onError: (_err, _vars, context) => context?.previous && queryClient.setQueryData(detailKey, context.previous),
    // Saves can overlap (leaving the commentary box, then ticking): only the last one to finish puts the server's review in the cache, so an older reply never undoes a newer tick.
    onSuccess: (review) => {
      if (queryClient.isMutating({ mutationKey }) <= 1) queryClient.setQueryData(detailKey, review);
    },
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** Management review actions given to me (MR3): any member, no permission needed. Polled like the other "mine" counts. */
export const useMyReviewActions = (status = "open", { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "my-actions", status),
    queryFn: () => apiFetch(`/management-review-actions/mine?status=${status}`, { organisationId }),
    enabled: !!organisationId && enabled,
    staleTime: 60_000,
    retry: false,
  });
};

/** The home page card: next review, last completed, open actions, objectives (management_review.read). */
export const useManagementReviewOverview = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "overview"),
    queryFn: () => apiFetch("/management-review-overview", { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};
