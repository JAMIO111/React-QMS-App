import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
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
    queryFn: () => apiFetch("/employees", { organisationId }).then((r) => r.data),
    enabled: !!organisationId,
    staleTime: 60_000,
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(organisationId) }),
  });
};
