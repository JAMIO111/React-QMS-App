import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";
import { guessCache, pendingId, rollbackGuess, updateById } from "../lib/optimistic";
import { myName } from "../lib/guessRequest";

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

/**
 * `request` is { path, method, body, guess? }; the response (an inspection) replaces the cached detail. A request with a `guess(data)` changes the cached
 * inspections at once (e.g. acknowledging a failed reading, abandoning) and is put back if the server refuses; readings are never guessed, because the
 * database decides pass or fail.
 */
export const useInspectionMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, method = "POST", body }) => apiFetch(path, { method, body, organisationId }),
    onMutate: (request) => (typeof request?.guess === "function" ? guessCache(queryClient, key(organisationId), request.guess) : { optimistic: false }),
    onError: (_error, _request, context) => rollbackGuess(queryClient, context),
    onSuccess: (data) => {
      // Most commands answer with the inspection; raising an NC answers { ncr, inspection }.
      const detail = data?.inspection ?? data;
      if (detail?.id) queryClient.setQueryData(key(organisationId, detail.id), detail);
    },
    // Readings feed SPC charts, alerts and the dashboard; a raised NC appears in the NC views: refresh everything.
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/**
 * Guess: a sample with `body.readings` added to the inspection. The readings show at once with no result ("checking…"): the database works out
 * pass or fail, gauge state and the sample's number, and its answer replaces the guess.
 */
export const guessSample = (inspectionId, body, at = new Date().toISOString()) => (data) =>
  updateById(data, inspectionId, (i) => {
    if (!Array.isArray(i.samples) || !Array.isArray(i.measurements) || !Array.isArray(body?.readings)) return i;
    const sampleId = pendingId();
    const sampleNumber = Math.max(0, ...i.samples.map((x) => x.sampleNumber ?? 0)) + 1;
    const sample = { id: sampleId, sampleNumber, unitReference: body.unitReference || null, isRetest: !!body.isRetest, triggerType: body.triggerType ?? "manual", sampledAt: at, subgroupNumber: null };
    const readings = body.readings.map((r) => ({
      id: pendingId(),
      sampleId,
      requirementId: r.requirementId,
      valueNumeric: r.valueNumeric ?? null,
      valueCount: r.valueCount ?? null,
      valuePass: r.valuePass ?? null,
      result: null,
      supersededById: null,
      supersedesId: null,
      retestOfId: r.retestOfId ?? null,
      gauge: null,
      importId: null,
      acknowledgement: null,
      recordedAt: at,
    }));
    return { ...i, samples: [...i.samples, sample], measurements: [...i.measurements, ...readings] };
  });

/** Guess: a failed reading acknowledged with `note` by `by` (the person's name) now. */
export const guessAcknowledged = (measurementId, note, by, at = new Date().toISOString()) => (data) =>
  updateById(data, measurementId, (m) => ({ ...m, acknowledgement: { note, at, by: { name: by } } }));

/** Guess: the inspection abandoned with `reason`. */
export const guessAbandoned = (inspectionId, reason) => (data) =>
  updateById(data, inspectionId, (i) => ({ ...i, status: "abandoned", ...("abandonReason" in i ? { abandonReason: reason } : {}) }));

/** The person's name for a guess, from the cached `/me`. */
export const useMyName = () => {
  const queryClient = useQueryClient();
  return () => myName(queryClient);
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
