import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";
import { key, queryString } from "./useMasterData";
import { useOrganisationDetails } from "./useQmsApi";

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

/** Traceability of one order, lot or serial number (read-only): { subject, order, lots, serials, inspections, ncrs, equipment }. */
export const useTraceability = (type, id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "production", "traceability", type, id),
    queryFn: () => apiFetch(`/traceability${queryString({ type, id })}`, { organisationId }),
    enabled: !!organisationId && !!type && !!id,
    retry: false,
  });
};

/** Orders, lots and serial numbers whose number contains the text: [{ type, id, number, status, part }]. */
export const useTraceSearch = (q) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "production", "traceability", "search", q),
    queryFn: () => apiFetch(`/traceability/search${queryString({ q })}`, { organisationId }).then((r) => r.data),
    enabled: !!organisationId && q.length >= 1,
    retry: false,
    placeholderData: keepPreviousData,
  });
};

/**
 * The organisation's production settings (Settings → Organisation → Production): whether lots and serial numbers are used, whether people who only record inspections may make an
 * order from a job, and whether a job needs a production order to be completed. Until they load, the defaults an organisation starts with.
 */
export const useProductionSettings = () => {
  const { data } = useOrganisationDetails();
  const s = data?.settings ?? {};
  return { useLotsAndSerials: s.useLotsAndSerials ?? true, allowInlineOrders: s.allowInlineOrders ?? false, requireProductionOrder: s.requireProductionOrder ?? false };
};

/** Make an order from a job's order picker: { orderNumber, partId, quantityPlanned, siteId? } → the order. The database says who may. */
export const useCreateInlineOrder = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch("/production-orders/inline", { method: "POST", body, organisationId }),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** Link the typed work orders, lots and serial numbers of existing records to production records: { dryRun } → the report. A dry run changes nothing. */
export const useBackfillProduction = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ dryRun }) => apiFetch("/production/backfill", { method: "POST", body: { dryRun }, organisationId }),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};
