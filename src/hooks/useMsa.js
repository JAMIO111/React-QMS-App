import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { guessCache, rollbackGuess, settle } from "../lib/optimistic";
import { requestGuessHandlers } from "../lib/guessRequest";
import { cellKey, isFilled, toNumberText } from "../lib/msa";
import { useOrganisation } from "../contexts/OrganisationProvider";

const key = (organisationId, ...rest) => ["api", "org", organisationId, "msa", ...rest];

const toQuery = (params) => {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) return;
    qs.set(k, Array.isArray(v) ? v.join(",") : String(v));
  });
  return qs.toString();
};

const useOrgQuery = (parts, path, { enabled = true, keepPrevious, select } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, ...parts),
    queryFn: () => apiFetch(path, { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
    ...(select ? { select } : {}),
    ...(keepPrevious ? { placeholderData: keepPreviousData } : {}),
  });
};

/** The register's page of studies: `{ data, page, pageSize, total }`. */
export const useMsaStudies = (params) => useOrgQuery(["list", params], `/msa/studies?${toQuery(params)}`, { keepPrevious: true });
/** One study with its design, appraisers, parts and the cells of the run sheet. */
export const useMsaStudy = (id) => useOrgQuery(["study", id], `/msa/studies/${id}`, { enabled: !!id });
/** The analysis: worked out from the readings now while collecting, the frozen result once completed. */
export const useMsaAnalysis = (id, { enabled = true } = {}) => useOrgQuery(["study", id, "analysis"], `/msa/studies/${id}/analysis`, { enabled: !!id && enabled });
export const useMsaReport = (id) => useOrgQuery(["study", id, "report"], `/msa/studies/${id}/report`, { enabled: !!id });
/** `{ current, open, earlier }` for one gauge's page. */
export const useGaugeMsa = (gaugeId, { enabled = true } = {}) => useOrgQuery(["gauge", gaugeId], `/gauges/${gaugeId}/msa`, { enabled: !!gaugeId && enabled });

/**
 * Any change to a study that is not entering readings: `{ path, method, body }` (create, design, start, complete, cancel, repeat). Flat edits show at once;
 * what the database decides (a number, the cells made at the start, the frozen result) arrives with the answer.
 */
export const useMsaMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, method = "POST", body }) => apiFetch(path, { method, body, organisationId }),
    ...requestGuessHandlers(queryClient, key(organisationId)),
    onSettled: (_data, _error, _request, context) => settle(queryClient, organisationId, context),
  });
};

/** A study with these readings in its cells (and the count of filled cells), for the guess made while they save. */
export const withReadings = (study, readings) => {
  if (!study || !Array.isArray(study.cells)) return study;
  const given = new Map(readings.map((r) => [cellKey(r.appraiser, r.part, r.trial), r]));
  let changed = false;
  const cells = study.cells.map((c) => {
    const r = given.get(cellKey(c.appraiser, c.part, c.trial));
    if (!r) return c;
    changed = true;
    return { ...c, value: r.value !== undefined ? toNumberText(r.value) : c.value, decision: r.decision !== undefined ? r.decision : c.decision, source: "grid" };
  });
  if (!changed) return study;
  return { ...study, cells, progress: { filled: cells.filter(isFilled).length, total: study.progress?.total ?? cells.length } };
};

/**
 * Entering readings while a study is collecting: `{ cells: [{ appraiser, part, trial, value | decision }], source }`. The cell shows what was typed at
 * once and goes back if the server refuses it; the analysis follows with the refetch.
 */
export const useRecordMeasurements = (studyId) => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ cells, source = "grid" }) => apiFetch(`/msa/studies/${studyId}/measurements`, { method: "PUT", body: { cells, source }, organisationId }),
    onMutate: ({ cells }) => guessCache(queryClient, key(organisationId, "study", studyId), (data) => (Array.isArray(data?.cells) ? withReadings(data, cells) : data)),
    onError: (_error, _request, context) => rollbackGuess(queryClient, context),
    onSettled: (_data, _error, _request, context) => settle(queryClient, organisationId, context),
  });
};

/** Pasted text read by the server (nothing saved): `{ ok, cells, problems, rows }`. */
export const useParsePaste = (studyId) => {
  const { organisationId } = useOrganisation();
  return useMutation({
    mutationFn: (text) => apiFetch(`/msa/studies/${studyId}/measurements/parse`, { method: "POST", body: { text }, organisationId }),
  });
};
