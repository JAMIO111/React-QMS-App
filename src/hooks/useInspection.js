import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { usePagedList } from "./useMasterData";

/** In-process inspections (PC4). Query keys under ["api", "org", id, "master", …] via usePagedList, and "inspection". */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "inspection", ...rest];

export const useInspections = ({ q = "", status, result, partId } = {}) => usePagedList("inspections", { q, status, result, partId });

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
      queryClient.invalidateQueries({ queryKey: ["api", "org", organisationId, "master", "inspections"] });
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
