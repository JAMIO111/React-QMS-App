import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DASHBOARD_STALE_MS } from "@/lib/dashboardPeriod";
import { apiFetch, describeApiError } from "../lib/api-client";
import { guessCache, optimisticHandlers, rollbackGuess, settle } from "../lib/optimistic";
import { useToast } from "../contexts/ToastProvider";
import { refreshOrganisation } from "../lib/refresh";
import { useOrganisation } from "../contexts/OrganisationProvider";

const key = (organisationId, ...rest) => ["api", "org", organisationId, "ncr", ...rest];

const toQuery = (params) => {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) return;
    qs.set(k, Array.isArray(v) ? v.join(",") : String(v));
  });
  return qs.toString();
};

/** Register page: { data, page, pageSize, total }. Keeps the previous page while the next loads. */
export const useNcrs = (params) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "list", params),
    queryFn: () => apiFetch(`/ncrs?${toQuery(params)}`, { organisationId }),
    enabled: !!organisationId,
    placeholderData: keepPreviousData,
    retry: false,
  });
};

export const useNcr = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "detail", id),
    queryFn: () => apiFetch(`/ncrs/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

export const useNcrHistory = (id, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "history", id),
    queryFn: () => apiFetch(`/ncrs/${id}/history`, { organisationId }).then((r) => r.data),
    enabled: !!organisationId && !!id && enabled,
    retry: false,
  });
};

export const useClassifications = ({ includeInactive = false } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "classifications", { includeInactive }),
    queryFn: () => apiFetch(`/ncr-classifications${includeInactive ? "?includeInactive=true" : ""}`, { organisationId }).then((r) => r.data),
    enabled: !!organisationId,
    staleTime: 60_000,
    retry: false,
    select: (all) => ({
      all,
      failureModes: all.filter((c) => c.kind === "failure_mode"),
      subFailureModes: all.filter((c) => c.kind === "sub_failure_mode"),
      categories: all.filter((c) => c.kind === "category"),
    }),
  });
};

export const useEmployees = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "employees"),
    queryFn: () => apiFetch("/employees/lookup", { organisationId }).then((r) => r.data),
    enabled: !!organisationId,
    staleTime: 60_000,
    retry: false,
  });
};

/** Highest total cost and quantity in a register: { cost: { max }, quantity: { max }, baseCurrency }. */
export const useNcrRanges = (source) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "ranges", source),
    queryFn: () => apiFetch(`/ncrs/ranges${source ? `?source=${source}` : ""}`, { organisationId }),
    enabled: !!organisationId,
    staleTime: 60_000,
    retry: false,
  });
};

/** NC dashboard figures for a period ({ source?, siteId?, from, to } — YYYY-MM-DD). Costs are net, in the site's currency or (all sites) the organisation's. */
export const useNcDashboard = ({ source, siteId, from, to }) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "dashboard", source ?? "all", siteId ?? "all-sites", from, to),
    queryFn: () => apiFetch(`/ncr-dashboard?${toQuery({ source, siteId, from, to })}`, { organisationId }),
    staleTime: DASHBOARD_STALE_MS,
    enabled: !!organisationId && !!from && !!to,
    placeholderData: keepPreviousData,
    retry: false,
  });
};

/**
 * What an automatic conversion would use, for the cost form: { rate, rateDate, state: "published" | "not_published" | "unavailable" }. Nothing is saved.
 * Asks only for a foreign currency and a whole date.
 */
export const useRatePreview = ({ from, to, date }) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "rate-preview", from, to, date),
    queryFn: () => apiFetch(`/exchange-rates/preview?${toQuery({ from, to, date })}`, { organisationId }),
    enabled: !!organisationId && !!from && !!to && from !== to && /^\d{4}-\d{2}-\d{2}$/.test(date ?? ""),
    staleTime: 5 * 60_000,
    retry: false,
  });
};

/** Costs of an NCR: { data, totals: { baseCurrency, orgCurrency, net, gross, netOrg, grossOrg, count, byCurrency, rates } }. */
export const useNcrCosts = (id, { deleted = "exclude" } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "costs", id, deleted),
    queryFn: () => apiFetch(`/ncrs/${id}/costs?deleted=${deleted}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** Files attached to an NCR (metadata; the files themselves are in the nc-files bucket). */
export const useNcrAttachments = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "attachments", id),
    queryFn: () => apiFetch(`/ncrs/${id}/attachments`, { organisationId }).then((r) => r.data),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/**
 * Any NCR or classification change: { path, method, body, reason }. Refreshes every NCR query
 * (lists, detail, history) of the organisation.
 */
export const useNcrMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const toast = useToast();
  const simple = optimisticHandlers(queryClient, key(organisationId));
  return useMutation({
    mutationFn: ({ path, method = "POST", body, reason }) => apiFetch(path, { method, body, organisationId, reason }),
    // `guess(data, queryKey)` (lib/ncrGuesses.js) changes the cached NC data at once; else a flat PATCH or a DELETE of one id is applied as it is.
    // `optimistic: false` (the NC page's own save) shows nothing until the server answers, so the form keeps what was typed if the save is refused.
    onMutate: (request) => (request.guess ? guessCache(queryClient, key(organisationId), request.guess) : request.optimistic === false ? { optimistic: false } : simple.onMutate(request)),
    onError: (error, request, context) => {
      rollbackGuess(queryClient, context);
      // the dialog that sent a guessed action has closed: say why it did not happen
      if (request.guess && !error?.cancelled) toast?.showToast?.({ type: "error", title: request.failed ?? "Not saved", message: describeApiError(error) });
    },
    onSettled: (_data, _error, _request, context) => settle(queryClient, organisationId, context),
  });
};

/** Containment of an NC: { actions, notNeededReason, resolved, problems }. */
export const useNcrContainment = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "containment", id),
    queryFn: () => apiFetch(`/ncrs/${id}/containment`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** Dispositions of an NC: { data, affected, approvedQuantity, proposedQuantity, remaining, canApprove, settled, problems }. */
export const useNcrDispositions = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "dispositions", id),
    queryFn: () => apiFetch(`/ncrs/${id}/dispositions`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** Lots an NC touches: { data (live and removed), affected, assigned, remaining, suggestedLot, problems }. */
export const useNcrAffectedLots = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "affected-lots", id),
    queryFn: () => apiFetch(`/ncrs/${id}/affected-lots`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** What is still needed to reach each later stage: { contained, investigating, dispositioned, awaitingClosure, closed } (lists of sentences). */
export const useNcrGates = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "gates", id),
    queryFn: () => apiFetch(`/ncrs/${id}/gates`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/**
 * What a non-conformance raised by hand starts with, for the chosen source:
 * { severity: "minor", category: { id, name } | null, site: { suggestedId, choices: [{ id, code, name }], organisationHasOneSite } }.
 */
export const useNcrNewDefaults = (source, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "new-defaults", source),
    queryFn: () => apiFetch(`/ncrs/new-defaults?source=${encodeURIComponent(source)}`, { organisationId }),
    enabled: !!organisationId && !!source && enabled,
    retry: false,
    staleTime: 60_000,
  });
};

/** The category suggested for each source: { data: [{ source, label, category }], canManage }. */
export const useSourceCategories = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "source-categories"),
    queryFn: () => apiFetch("/ncr-source-categories", { organisationId }),
    enabled: !!organisationId,
    retry: false,
  });
};

/**
 * Change one source's suggestion: { source, category: { id, name } | null }. Shown straight away; the previous list comes back if the
 * save is refused.
 */
export const useSetSourceCategory = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const listKey = key(organisationId, "source-categories");
  return useMutation({
    mutationFn: ({ source, category }) =>
      apiFetch("/ncr-source-categories", { method: "PUT", body: { source, categoryId: category?.id ?? null }, organisationId }),
    onMutate: async ({ source, category }) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueryData(listKey);
      if (previous) {
        queryClient.setQueryData(listKey, {
          ...previous,
          data: previous.data.map((r) => (r.source !== source ? r : { ...r, category: category ? { ...category, active: true } : null })),
        });
      }
      return { previous };
    },
    onError: (_e, _arg, context) => {
      if (context?.previous) queryClient.setQueryData(listKey, context.previous);
    },
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};
