import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DASHBOARD_STALE_MS } from "@/lib/dashboardPeriod";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";
import { useToast } from "../contexts/ToastProvider";
import { pendingId, updateById } from "../lib/optimistic";
import { commandGuessHandlers, nowIso, setFields } from "../lib/guessCommands";

/** Risk register (docs/risk-management-plan.md): the matrix, categories, risks and their assessments. */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "risk", ...rest];

const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params ?? {}).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && p.set(k, v));
  return p.toString();
};

/** The current matrix with its versions. It changes rarely, so it is kept for a few minutes. */
export const useRiskModel = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "model"),
    queryFn: () => apiFetch("/risk-model", { organisationId }),
    enabled: !!organisationId,
    retry: false,
    staleTime: 1000 * 60 * 5,
  });
};

export const useRiskCategories = ({ all = false } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "categories", all),
    queryFn: () => apiFetch(`/risk-categories?${qs({ all: all ? "true" : "" })}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
  });
};

/** Live risks per cell of the matrix: `phase` inherent | residual | effective (default), optional `kind`, `categoryId`, `owner=me`. */
export const useRiskHeatmap = (params) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "heatmap", params),
    queryFn: () => apiFetch(`/risk-heatmap?${qs(params)}`, { organisationId }),
    enabled: !!organisationId,
    placeholderData: keepPreviousData,
    retry: false,
  });
};

/** The risk dashboard for a period (`period` from useDashboardPeriod). */
export const useRiskDashboard = (period) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "dashboard", period?.fromIso, period?.toIso),
    queryFn: () => apiFetch(`/risks-dashboard?${qs({ from: period.fromIso, to: period.toIso })}`, { organisationId }),
    staleTime: DASHBOARD_STALE_MS,
    enabled: !!organisationId && !!period?.fromIso,
    placeholderData: keepPreviousData,
    retry: false,
  });
};

/** My risks due for review, my open actions and acceptances waiting for me. */
export const useMyRiskWork = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "work", "mine"),
    queryFn: () => apiFetch("/risk-work/mine", { organisationId }),
    enabled: !!organisationId,
    retry: false,
  });
};

/** Counts of what needs me now (the menu badge comes from `useBadges`). */
export const useMyRiskCount = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "work", "count"),
    queryFn: () => apiFetch("/risk-work/count", { organisationId }),
    enabled: !!organisationId && enabled,
    staleTime: 60_000,
    retry: false,
  });
};

/** The register: filters and paging are the server's. */
export const useRisks = (params) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "list", params),
    queryFn: () => apiFetch(`/risks?${qs(params)}`, { organisationId }),
    enabled: !!organisationId,
    placeholderData: keepPreviousData,
    retry: false,
  });
};

export const useRisk = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "risk", id),
    queryFn: () => apiFetch(`/risks/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** Risks linked to one record (for that record's page): { data, canRaise }. */
export const useLinkedRisks = (kind, id, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "linked", kind, id),
    queryFn: () => apiFetch(`/risks/linked?${qs({ kind, id })}`, { organisationId }),
    enabled: !!organisationId && !!id && enabled,
    retry: false,
  });
};

/** What a risk raised from a non-conformance, an 8D or an audit finding starts with (nothing saved). */
export const useRiskDraft = (kind, id, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "draft", kind, id),
    queryFn: () => apiFetch(`/risk-draft?${qs({ kind, id })}`, { organisationId }),
    enabled: !!organisationId && !!id && enabled,
    retry: false,
    staleTime: 0,
  });
};

/** One command at a time: { action, id, body }. Every one refreshes the organisation's cached data. */
export const useRiskMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const send = (path, method = "POST") => apiFetch(path, { method, body, organisationId });
      switch (action) {
        case "saveModel":
          return send("/risk-model", "PUT");
        case "createCategory":
          return send("/risk-categories");
        case "updateCategory":
          return send(`/risk-categories/${id}`, "PATCH");
        case "create":
          return send("/risks");
        case "update":
          return send(`/risks/${id}`, "PATCH");
        case "assess":
          return send(`/risks/${id}/assessments`);
        case "retire":
          return send(`/risks/${id}/retire`);
        case "reactivate":
          return send(`/risks/${id}/reactivate`);
        case "setTreatment":
          return send(`/risks/${id}/treatment`, "PUT");
        case "addAction":
          return send(`/risks/${id}/actions`);
        case "updateAction":
          return send(`/risk-actions/${id}`, "PATCH");
        case "completeAction":
          return send(`/risk-actions/${id}/complete`);
        case "cancelAction":
          return send(`/risk-actions/${id}/cancel`);
        case "reopenAction":
          return send(`/risk-actions/${id}/reopen`);
        case "proposeAcceptance":
          return send(`/risks/${id}/acceptances`);
        case "decideAcceptance":
          return send(`/risk-acceptances/${id}/decide`);
        case "withdrawAcceptance":
          return send(`/risk-acceptances/${id}/withdraw`);
        case "review":
          return send(`/risks/${id}/reviews`);
        case "close":
          return send(`/risks/${id}/close`);
        case "reopen":
          return send(`/risks/${id}/reopen`);
        case "setLinks":
          return send(`/risks/${id}/links`, "PUT");
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    // The guessed commands (RISK_GUESSED) show at once; a refusal puts the risk back and says why in a toast.
    ...commandGuessHandlers({ queryClient, prefix: key(organisationId), guess: guessRisk, guessed: RISK_GUESSED, showToast: toast?.showToast }),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/**
 * The risk commands shown before the server answers. The others wait: the database scores assessments, works out the status, decides acceptances
 * (another person's approval), reviews and closing.
 */
export const RISK_GUESSED = new Set([
  "update", "updateCategory", "retire", "reactivate", "setTreatment", "setLinks", "addAction", "updateAction", "completeAction", "cancelAction", "reopenAction", "withdrawAcceptance",
]);

/** Cached risk data as it will be after a command (`useRiskMutation` vars; `show`: `ownerName`, `links` with their labels, `me` = my name). */
export const guessRisk = (data, { action, id, body = {}, show = {} }) => {
  const now = nowIso();
  const withOwner = (x) => ("ownerId" in body ? { ...x, owner: body.ownerId ? { ...(x.owner ?? {}), id: body.ownerId, name: show.ownerName ?? x.owner?.name ?? "…" } : null } : x);
  switch (action) {
    case "update":
      return updateById(data, id, (risk) => withOwner(setFields(risk, body)));
    case "updateCategory":
      return updateById(data, id, (c) => setFields(c, body));
    case "retire":
      return updateById(data, id, (risk) => ("status" in risk ? { ...risk, status: "retired", retiredReason: body.reason ?? null, retiredAt: now } : risk));
    case "reactivate":
      return updateById(data, id, (risk) => (risk.status === "retired" ? { ...risk, status: risk.inherent ? (risk.strategy ? "treating" : "open") : "draft" } : risk));
    case "setTreatment":
      return updateById(data, id, (risk) => ({ ...risk, strategy: body.strategy ?? risk.strategy, treatmentPlan: body.plan ?? null }));
    case "setLinks":
      return show.links ? updateById(data, id, (risk) => ("links" in risk ? { ...risk, links: show.links } : risk)) : data;
    case "addAction":
      return updateById(data, id, (risk) => {
        if (!Array.isArray(risk.actions)) return risk;
        const action = withOwner({ id: pendingId(), description: body.description ?? "", dueDate: body.dueDate ?? null, status: "open", mine: false, owner: null });
        return { ...risk, actions: [...risk.actions, action], ...(typeof risk.openActions === "number" ? { openActions: risk.openActions + 1 } : {}) };
      });
    case "updateAction":
      return updateById(data, id, (a) => withOwner(setFields(a, body)));
    case "completeAction":
      return updateById(data, id, (a) => ({ ...a, status: "done", doneNote: body.note ?? null, doneAt: now, doneBy: show.me ?? a.doneBy ?? null }));
    case "cancelAction":
      return updateById(data, id, (a) => ({ ...a, status: "cancelled", cancelReason: body.reason ?? null, cancelledAt: now, cancelledBy: show.me ?? a.cancelledBy ?? null }));
    case "reopenAction":
      return updateById(data, id, (a) => ({ ...a, status: "open", doneNote: null, doneAt: null, doneBy: null, cancelReason: null, cancelledAt: null, cancelledBy: null }));
    case "withdrawAcceptance":
      return updateById(data, id, (x) => ({ ...x, status: "withdrawn", canDecide: false, canWithdraw: false }));
    default:
      return data;
  }
};

/** Switching a category on or off shows at once and is put back if the server refuses. */
export const useToggleRiskCategory = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const listKey = key(organisationId, "categories");
  return useMutation({
    mutationFn: ({ id, active }) => apiFetch(`/risk-categories/${id}`, { method: "PATCH", body: { active }, organisationId }),
    onMutate: async ({ id, active }) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueriesData({ queryKey: listKey });
      queryClient.setQueriesData({ queryKey: listKey }, (old) => (old?.data ? { ...old, data: old.data.map((c) => (c.id === id ? { ...c, active } : c)) } : old));
      return { previous };
    },
    onError: (_err, _vars, context) => context?.previous?.forEach(([k, v]) => queryClient.setQueryData(k, v)),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};
