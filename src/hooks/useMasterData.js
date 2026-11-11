import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { optimisticHandlers, settle } from "../lib/optimistic";
import { useOrganisation } from "../contexts/OrganisationProvider";

/** Query keys live under ["api", "org", organisationId, …] like the other API hooks. */
export const key = (organisationId, ...rest) => ["api", "org", organisationId, "master", ...rest];

export const queryString = (params) => {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "" && v !== false) qs.set(k, String(v));
  });
  const s = qs.toString();
  return s ? `?${s}` : "";
};

/** A keyset-paginated list (`{ data, nextCursor }`) with "load more". */
export const usePagedList = (resource, params, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useInfiniteQuery({
    queryKey: key(organisationId, resource, params),
    queryFn: ({ pageParam }) =>
      apiFetch(`/${resource}${queryString({ limit: 50, ...params, cursor: pageParam })}`, { organisationId }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!organisationId && enabled,
    retry: false,
    select: (data) => ({ ...data, items: data.pages.flatMap((p) => p.data) }),
  });
};

export const useUnits = () =>
  useQuery({
    queryKey: ["api", "units"],
    queryFn: () => apiFetch("/units").then((r) => r.data),
    staleTime: Infinity,
    retry: false,
  });

/** kind: "customers" | "suppliers" */
export const useParties = (kind, { q = "", includeInactive = false } = {}) => usePagedList(kind, { q, includeInactive });
export const useParts = ({ q = "", includeInactive = false, customerId, partFamilyId } = {}) =>
  usePagedList("parts", { q, includeInactive, customerId, partFamilyId });

export const usePart = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "parts", "detail", id),
    queryFn: () => apiFetch(`/parts/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/**
 * One mutation hook for master data. `request` is { path, method, body, reason }; on success the
 * lists and the part detail are refreshed (a release changes other revisions too).
 */
export const useMasterDataMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, method = "POST", body, reason }) => apiFetch(path, { method, body, organisationId, reason }),
    ...optimisticHandlers(queryClient, key(organisationId)),
    onSuccess: (_data, _request, context) => settle(queryClient, organisationId, context),
  });
};

/** The employees register page: { data, page, pageSize, total }. Search, filters, sort and page numbers are the server's. */
export const useEmployeeRegister = (params = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "employees", params),
    queryFn: () => apiFetch(`/employees${queryString(params)}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
    placeholderData: keepPreviousData,
  });
};

/** Members an employee could be linked to, and whether the caller may link at all (a Controller seat): { canLink, data }. */
export const useEmployeeLoginCandidates = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "employees", "login-candidates"),
    queryFn: () => apiFetch("/employees/login-candidates", { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

/** The master data overview: totals, data-quality checks, growth, shape, recent changes and the change-event stream. */
export const useMasterDataDashboard = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "dashboard"),
    queryFn: () => apiFetch("/master-data-dashboard", { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

/** What ran on the part revision version that a correction replaces (inspections and non-conformances). Ask with the correction or the corrected version. */
export const useCorrectionImpact = (revisionId, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "correction-impact", revisionId),
    queryFn: () => apiFetch(`/part-revisions/${revisionId}/correction-impact`, { organisationId }),
    enabled: !!organisationId && !!revisionId && enabled,
    retry: false,
  });
};
