import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { key, queryString } from "./useMasterData";

/**
 * Production orders, lots and serial numbers (Phase 3). Reads live under the master-data query key so useMasterDataMutation (which refreshes the whole organisation) keeps them current.
 * The registers are page-based ({ data, page, pageSize, total }); the `lookup` hooks feed pickers (job, non-conformance) with open records only.
 */
const usePage = (resource, params) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "production", resource, params),
    queryFn: () => apiFetch(`/${resource}${queryString(params)}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
    placeholderData: keepPreviousData,
  });
};

export const useProductionOrders = (params = {}) => usePage("production-orders", params);
export const useLots = (params = {}) => usePage("lots", params);
export const useSerialNumbers = (params = {}) => usePage("serial-numbers", params);

export const useProductionOrder = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "production", "production-orders", "detail", id),
    queryFn: () => apiFetch(`/production-orders/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

const useLookup = (resource, params, enabled) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "production", resource, "lookup", params),
    queryFn: () => apiFetch(`/${resource}/lookup${queryString(params)}`, { organisationId }).then((r) => r.data),
    enabled: !!organisationId && enabled,
    retry: false,
    placeholderData: keepPreviousData,
  });
};
export const useOrderLookup = (params = {}, { enabled = true } = {}) => useLookup("production-orders", params, enabled);
export const useLotLookup = (params = {}, { enabled = true } = {}) => useLookup("lots", params, enabled);
export const useSerialLookup = (params = {}, { enabled = true } = {}) => useLookup("serial-numbers", params, enabled);
