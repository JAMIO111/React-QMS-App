import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";

/** Query keys live under ["api", "org", organisationId, …] like the other API hooks. */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "master", ...rest];

const queryString = (params) => {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "" && v !== false) qs.set(k, String(v));
  });
  const s = qs.toString();
  return s ? `?${s}` : "";
};

/** A keyset-paginated list (`{ data, nextCursor }`) with "load more". */
const usePagedList = (resource, params, { enabled = true } = {}) => {
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
export const useParts = ({ q = "", includeInactive = false, customerId } = {}) => usePagedList("parts", { q, includeInactive, customerId });

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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(organisationId) }),
  });
};
