import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";
import { useToast } from "../contexts/ToastProvider";
import { updateById } from "../lib/optimistic";
import { commandGuessHandlers, setFields } from "../lib/guessCommands";

/** FMEA (docs/fmea-plan.md): the register, an FMEA with its revisions, a revision with its team and scope. */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "fmea", ...rest];

const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params ?? {}).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && p.set(k, v));
  return p.toString();
};

/** The register: filters and paging are the server's. */
export const useFmeas = (params, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "list", params),
    queryFn: () => apiFetch(`/fmeas?${qs(params)}`, { organisationId }),
    enabled: !!organisationId && enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
};

/** FMEAs that cover one thing (a part, family, control plan or machine): for the cards and banners on those pages. */
export const useFmeasCovering = (params, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "covering", params),
    queryFn: () => apiFetch(`/fmeas?${qs({ ...params, status: "draft,active", pageSize: 50 })}`, { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

export const useFmea = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "fmea", id),
    queryFn: () => apiFetch(`/fmeas/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

export const useFmeaRevision = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "revision", id),
    queryFn: () => apiFetch(`/fmea-revisions/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** Members who may be named on a team or as approver, and whether each can approve. */
export const useFmeaPeople = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "people"),
    queryFn: () => apiFetch("/fmea-people", { organisationId }),
    enabled: !!organisationId && enabled,
    staleTime: 60_000,
    retry: false,
    select: (r) => r.data,
  });
};

/** The commands shown before the server answers; the others wait (starting, submitting, approving: the database decides). */
export const FMEA_GUESSED = new Set(["update", "updateRevision", "setLinks", "setTeam", "setApprover"]);

/** Cached FMEA data as it will be after a command (`show`: the links, team or approver with their labels, for the commands that replace them). */
export const guessFmea = (data, { action, id, body = {}, show = {} }) => {
  switch (action) {
    case "update":
    case "updateRevision":
      return updateById(data, id, (x) => setFields(x, body));
    case "setLinks":
      return show.links ? updateById(data, id, (r) => ("links" in r ? { ...r, links: show.links } : r)) : data;
    case "setTeam":
      return show.team ? updateById(data, id, (r) => ("team" in r ? { ...r, team: show.team } : r)) : data;
    case "setApprover":
      return updateById(data, id, (r) => ("approver" in r ? { ...r, approver: show.approver ?? null } : r));
    default:
      return data;
  }
};

/** One command at a time: { action, id, body, show }. Every one refreshes the organisation's cached data. */
export const useFmeaMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const send = (path, method = "POST") => apiFetch(path, { method, body, organisationId });
      switch (action) {
        case "create":
          return send("/fmeas");
        case "update":
          return send(`/fmeas/${id}`, "PATCH");
        case "startRevision":
          return send(`/fmeas/${id}/revisions`);
        case "withdraw":
          return send(`/fmeas/${id}/withdraw`);
        case "review":
          return send(`/fmeas/${id}/reviews`);
        case "updateRevision":
          return send(`/fmea-revisions/${id}`, "PATCH");
        case "setTeam":
          return send(`/fmea-revisions/${id}/team`, "PUT");
        case "setLinks":
          return send(`/fmea-revisions/${id}/links`, "PUT");
        case "setApprover":
          return send(`/fmea-revisions/${id}/approver`, "PUT");
        case "submit":
          return send(`/fmea-revisions/${id}/submit`);
        case "approve":
          return send(`/fmea-revisions/${id}/approve`);
        case "sendBack":
          return send(`/fmea-revisions/${id}/send-back`);
        case "recall":
          return send(`/fmea-revisions/${id}/recall`);
        case "discard":
          return send(`/fmea-revisions/${id}/discard`);
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    // The guessed commands show at once; a refusal puts the record back and says why in a toast.
    ...commandGuessHandlers({ queryClient, prefix: key(organisationId), guess: guessFmea, guessed: FMEA_GUESSED, showToast: toast?.showToast }),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/**
 * One command on the analysis of a draft revision: { action, id, body } where `id` is what the command acts on (the revision to add an item to, the item to
 * add a function to, the node to change or remove). The database scores the causes, so the screen waits for the answer, which is the whole revision.
 */
export const useFmeaNodeMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const call = (path, method = "POST") => apiFetch(path, { method, body, organisationId });
      switch (action) {
        case "addItem":
          return call(`/fmea-revisions/${id}/items`);
        case "updateItem":
          return call(`/fmea-items/${id}`, "PATCH");
        case "removeItem":
          return call(`/fmea-items/${id}`, "DELETE");
        case "addFunction":
          return call(`/fmea-items/${id}/functions`);
        case "updateFunction":
          return call(`/fmea-functions/${id}`, "PATCH");
        case "removeFunction":
          return call(`/fmea-functions/${id}`, "DELETE");
        case "addFailureMode":
          return call(`/fmea-functions/${id}/failure-modes`);
        case "updateFailureMode":
          return call(`/fmea-failure-modes/${id}`, "PATCH");
        case "removeFailureMode":
          return call(`/fmea-failure-modes/${id}`, "DELETE");
        case "addEffect":
          return call(`/fmea-failure-modes/${id}/effects`);
        case "updateEffect":
          return call(`/fmea-effects/${id}`, "PATCH");
        case "removeEffect":
          return call(`/fmea-effects/${id}`, "DELETE");
        case "addCause":
          return call(`/fmea-failure-modes/${id}/causes`);
        case "updateCause":
          return call(`/fmea-causes/${id}`, "PATCH");
        case "removeCause":
          return call(`/fmea-causes/${id}`, "DELETE");
        case "useLatestModel":
          return call(`/fmea-revisions/${id}/use-latest-model`);
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    // The answer is the whole revision: put it where the page reads it at once, then refresh the rest.
    onSuccess: (revision) => queryClient.setQueryData(key(organisationId, "revision", revision.id), revision),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

// ---- the rating model (FM2) ----------------------------------------------------------------------------------

/** The current rating model with its versions. It changes rarely, so it is kept for a few minutes. */
export const useFmeaModel = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "model"),
    queryFn: () => apiFetch("/fmea-model", { organisationId }),
    enabled: !!organisationId,
    retry: false,
    staleTime: 1000 * 60 * 5,
  });
};

/** What S, O and D come to on a saved version of the model (the database works it out; nothing is saved). */
export const useFmeaPreview = (body, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "model-preview", body),
    queryFn: () => apiFetch("/fmea-model/preview", { method: "POST", body, organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
    placeholderData: keepPreviousData,
  });
};

/** A new version of the model, with a reason. It waits for the server's answer, which carries the new version. */
export const useSaveFmeaModel = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch("/fmea-model", { method: "PUT", body, organisationId }),
    onSuccess: (data) => queryClient.setQueryData(key(organisationId, "model"), data),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** Reads an action priority grid from CSV text. Nothing is saved, so nothing else on screen needs refreshing. */
export const useImportApGrid = () => {
  const { organisationId } = useOrganisation();
  return useMutation({ mutationFn: (csv) => apiFetch("/fmea-model/ap-import", { method: "POST", body: { csv }, organisationId }) });
};

// ---- actions, My actions, comparing (FM4) ------------------------------------------------------------------------

/**
 * One command on an action: { action, id, body } — add (`id` is the cause: the answer is the whole revision), update, complete, cancel or reopen (`id` is the action:
 * the answer is the action, with the figures the database worked out, and is written into every cached copy). It waits for the server: the revised ratings are the
 * database's to work out.
 */
export const useFmeaActionMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const call = (path, method = "POST") => apiFetch(path, { method, body, organisationId });
      switch (action) {
        case "add":
          return call(`/fmea-causes/${id}/actions`);
        case "update":
          return call(`/fmea-actions/${id}`, "PATCH");
        case "complete":
          return call(`/fmea-actions/${id}/complete`);
        case "cancel":
          return call(`/fmea-actions/${id}/cancel`);
        case "reopen":
          return call(`/fmea-actions/${id}/reopen`);
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    onSuccess: (answer, { action }) => {
      if (action === "add") queryClient.setQueryData(key(organisationId, "revision", answer.id), answer);
    },
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** The actions given to the caller (`status` open | done | all): `{ data, openCount, overdueCount }`. */
export const useMyFmeaActions = (status = "open", { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "my-actions", status),
    queryFn: () => apiFetch(`/fmea-actions/mine?${qs({ status })}`, { organisationId }),
    enabled: !!organisationId && enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
};

/** The menu badge: how many actions are open and given to the caller. Polled every five minutes like the other badges. */
export const useMyFmeaActionCount = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "my-actions-count"),
    queryFn: () => apiFetch("/fmea-actions/mine?status=open", { organisationId }),
    enabled: !!organisationId && enabled,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
    select: (r) => ({ open: r.openCount, overdue: r.overdueCount, total: r.openCount }),
  });
};

/** What changed since the revision before this one (or since `withId`). */
export const useFmeaCompare = (id, withId, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "compare", id, withId ?? null),
    queryFn: () => apiFetch(`/fmea-revisions/${id}/compare${withId ? `?${qs({ with: withId })}` : ""}`, { organisationId }),
    enabled: !!organisationId && !!id && enabled,
    retry: false,
  });
};

/** For an FMEA started from a base: what has changed in the base since it was copied. */
export const useFmeaBaseChanges = (id, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "base-changes", id),
    queryFn: () => apiFetch(`/fmea-revisions/${id}/base-changes`, { organisationId }),
    enabled: !!organisationId && !!id && enabled,
    retry: false,
  });
};
