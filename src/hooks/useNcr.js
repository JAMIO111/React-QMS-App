import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { optimisticHandlers, settle } from "../lib/optimistic";
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
      processes: all.filter((c) => c.kind === "process"),
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

/** NC dashboard figures for a period ({ source?, from, to } — YYYY-MM-DD). */
export const useNcDashboard = ({ source, from, to }) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "dashboard", source ?? "all", from, to),
    queryFn: () => apiFetch(`/ncr-dashboard?${toQuery({ source, from, to })}`, { organisationId }),
    enabled: !!organisationId && !!from && !!to,
    placeholderData: keepPreviousData,
    retry: false,
  });
};

/** Costs of an NCR: { data, totals: { baseCurrency, net, gross, count } }. */
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
  return useMutation({
    mutationFn: ({ path, method = "POST", body, reason }) => apiFetch(path, { method, body, organisationId, reason }),
    ...optimisticHandlers(queryClient, key(organisationId)),
    onSuccess: (_data, _request, context) => settle(queryClient, organisationId, context),
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
