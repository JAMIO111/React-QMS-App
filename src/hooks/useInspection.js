import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

/** In-process inspections (PC4). Query keys under ["api", "org", id, "master", …] via usePagedList, and "inspection". */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "inspection", ...rest];

const toQuery = (params) => {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) return;
    qs.set(k, Array.isArray(v) ? v.join(",") : String(v));
  });
  return qs.toString();
};

/** The register page: { data, page, pageSize, total }. Filters, sort and page numbers are the server's. */
export const useInspections = (params = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "list", params),
    queryFn: () => apiFetch(`/inspections?${toQuery(params)}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
    placeholderData: keepPreviousData,
  });
};

export const useInspection = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, id),
    queryFn: () => apiFetch(`/inspections/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** `request` is { path, method, body }; the response (an inspection) replaces the cached detail. */
export const useInspectionMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, method = "POST", body }) => apiFetch(path, { method, body, organisationId }),
    onSuccess: (data) => {
      // Most commands answer with the inspection; raising an NC answers { ncr, inspection }.
      const detail = data?.inspection ?? data;
      if (detail?.id) queryClient.setQueryData(key(organisationId, detail.id), detail);
      // Readings feed SPC charts, alerts and the dashboard; a raised NC appears in the NC views: refresh everything.
      refreshOrganisation(queryClient, organisationId);
    },
  });
};

/** The suggested NC for some failed readings; an empty list is the suggestion for a manual NC. Never cached. */
export const useNcrDraft = (inspectionId, measurementIds, enabled = true) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "ncr-draft", inspectionId, measurementIds.join(",")),
    queryFn: () => apiFetch(`/inspections/${inspectionId}/ncr-draft?measurementIds=${measurementIds.join(",")}`, { organisationId }),
    enabled: !!organisationId && !!inspectionId && enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
};

/** The inspection readings behind a non-conformance (only those the user may read). */
export const useNcrInspectionSource = (ncrId, enabled = true) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "ncr-source", ncrId),
    queryFn: () => apiFetch(`/ncrs/${ncrId}/inspection-source`, { organisationId }),
    enabled: !!organisationId && !!ncrId && enabled,
    retry: false,
  });
};

/** Inspections that used a gauge since its previous calibration (impact assessment). */
export const useGaugeUsage = (calibrationId, enabled = true) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "gauge-usage", calibrationId),
    queryFn: () => apiFetch(`/calibrations/${calibrationId}/gauge-usage`, { organisationId }),
    enabled: !!organisationId && !!calibrationId && enabled,
    retry: false,
  });
};
