import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";
import { guessCache, pendingId, rollbackGuess, updateById } from "../lib/optimistic";
import { myName, patchFields } from "../lib/guessRequest";

/** CMM and measurement file imports (docs/cmm-ingestion-plan.md). Query keys under ["api", "org", id, "measurement-imports", …]. */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "measurement-imports", ...rest];

export const useMeasurementProfiles = ({ all = false } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "profiles", all),
    queryFn: () => apiFetch(`/measurement-profiles${all ? "?all=true" : ""}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
  });
};

export const useProfileTemplates = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "templates"),
    queryFn: () => apiFetch("/measurement-profiles/templates", { organisationId }),
    enabled: !!organisationId,
    staleTime: Infinity,
    retry: false,
  });
};

export const useMeasurementProfile = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "profile", id),
    queryFn: () => apiFetch(`/measurement-profiles/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

const PROFILE_ACTIONS = {
  create: ({ body }) => ["/measurement-profiles", "POST", body],
  update: ({ id, body }) => [`/measurement-profiles/${id}`, "PATCH", body],
  retire: ({ id, reason }) => [`/measurement-profiles/${id}/retire`, "POST", { reason }],
  reactivate: ({ id }) => [`/measurement-profiles/${id}/reactivate`, "POST", undefined],
};

/**
 * The cached profiles as they will be after a profile action: retiring and bringing back switch it, a change shows its name and description (and a new
 * version when the reading settings change). Creating is not guessed: the server makes the profile and its first version.
 */
export const guessProfiles = (data, v) => {
  switch (v.action) {
    case "retire":
      return updateById(data, v.id, (p) => ({ ...p, active: false, ...("retiredReason" in p ? { retiredReason: v.reason ?? null } : {}) }));
    case "reactivate":
      return updateById(data, v.id, (p) => ({ ...p, active: true, ...("retiredReason" in p ? { retiredReason: null } : {}) }));
    case "update":
      return updateById(data, v.id, (p) => {
        const next = patchFields(p, { name: v.body?.name, description: v.body?.description, defaultGaugeId: v.body?.defaultGaugeId });
        return v.body?.settings !== undefined && typeof p.currentVersion === "number" ? { ...next, currentVersion: p.currentVersion + 1 } : next;
      });
    default:
      return data;
  }
};

/** { action: create | update | retire | reactivate, id?, body?, reason? } → the profile. Everything but create shows at once and is put back if refused. */
export const useProfileMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v) => {
      const [path, method, body] = PROFILE_ACTIONS[v.action](v);
      return apiFetch(path, { method, body, organisationId });
    },
    onMutate: (v) => (v.action === "create" ? { optimistic: false } : guessCache(queryClient, key(organisationId), (data) => guessProfiles(data, v))),
    onError: (_error, _vars, context) => rollbackGuess(queryClient, context),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** Read a file with settings (nothing is saved): { settings, fileName, contentBase64 } → what was found. */
export const useTryProfile = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch("/measurement-profiles/try", { method: "POST", body, organisationId }),
    // Nothing changes on the server; refreshing keeps the rule that every action refreshes (refresh.test.js).
    onSuccess: () => refreshOrganisation(queryClient, organisationId),
  });
};

export const useInspectionImports = (inspectionId, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "inspection", inspectionId),
    queryFn: () => apiFetch(`/inspections/${inspectionId}/imports`, { organisationId }),
    enabled: !!organisationId && !!inspectionId && enabled,
    retry: false,
  });
};

export const useInspectionImport = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "import", id),
    queryFn: () => apiFetch(`/inspection-imports/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

const IMPORT_ACTIONS = {
  create: ({ inspectionId, body }) => [`/inspections/${inspectionId}/imports`, body],
  confirm: ({ id }) => [`/inspection-imports/${id}/confirm-mismatches`, undefined],
  discard: ({ id, reason }) => [`/inspection-imports/${id}/discard`, { reason: reason || null }],
  apply: ({ id, body }) => [`/inspection-imports/${id}/apply`, body],
};

/**
 * The cached import after confirming its differences (`by` = the person's name) or discarding it. Creating and applying are never guessed: the server reads
 * the file, and applying records readings whose results the database works out.
 */
export const guessImport = (data, v, by, at = new Date().toISOString()) => {
  if (v.action === "confirm") return updateById(data, v.id, (d) => ({ ...d, mismatchesConfirmedAt: at, mismatchesConfirmedBy: by }));
  if (v.action === "discard") return updateById(data, v.id, (d) => ({ ...d, status: "discarded", ...("discardReason" in d || v.reason ? { discardReason: v.reason || null } : {}) }));
  return data;
};

/** { action: create | confirm | discard | apply, … } → the import, which replaces the cached detail. Applying records readings, so everything refreshes. */
export const useImportMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v) => {
      const [path, body] = IMPORT_ACTIONS[v.action](v);
      return apiFetch(path, { method: "POST", body, organisationId });
    },
    // Confirming and discarding show at once and are put back if refused.
    onMutate: (v) =>
      v.action === "confirm" || v.action === "discard" ? guessCache(queryClient, key(organisationId), (data) => guessImport(data, v, myName(queryClient))) : { optimistic: false },
    onError: (_error, _vars, context) => rollbackGuess(queryClient, context),
    onSuccess: (data) => {
      if (data?.id) queryClient.setQueryData(key(organisationId, "import", data.id), data);
    },
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/**
 * Match a feature to a check (or to nothing), shown at once: the row takes the check before the server answers, and is put back if it refuses.
 * The server's answer (results, problems and mismatches worked out by the database) then replaces the import.
 */
export const useMatchFeature = (importId) => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const detailKey = key(organisationId, "import", importId);
  return useMutation({
    mutationFn: ({ rowId, requirementId, remember }) =>
      apiFetch(`/inspection-import-rows/${rowId}/match`, { method: "PUT", body: { requirementId, remember: !!remember }, organisationId }),
    onMutate: async ({ rowId, requirementId }) => {
      await queryClient.cancelQueries({ queryKey: detailKey });
      const previous = queryClient.getQueryData(detailKey);
      if (previous) {
        queryClient.setQueryData(detailKey, {
          ...previous,
          units: previous.units.map((u) => ({
            ...u,
            rows: u.rows.map((r) => (r.id === rowId ? { ...r, requirementId, matchKind: requirementId ? "manual" : "none", expectedResult: null, problem: null, mismatch: false } : r)),
          })),
        });
      }
      return { previous };
    },
    onError: (_e, _v, context) => {
      if (context?.previous) queryClient.setQueryData(detailKey, context.previous);
    },
    onSuccess: (data) => {
      if (data?.id) queryClient.setQueryData(detailKey, data);
      refreshOrganisation(queryClient, organisationId);
    },
  });
};

export const useFeatureMaps = (partId) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "feature-maps", partId),
    queryFn: () => apiFetch(`/parts/${partId}/feature-maps`, { organisationId }),
    enabled: !!organisationId && !!partId,
    retry: false,
  });
};

/**
 * The part's cached feature matches after an action: ending one drops it; saving one replaces the live match for that feature name (and profile) with a
 * placeholder row until the server answers. `show` may carry `{ profile: { id, name } }` for the row.
 */
export const guessFeatureMaps = (data, v, queryKey) => {
  if (v.action === "end") return updateById(data, v.id, (m) => m, { remove: true });
  if (v.action !== "save" || !Array.isArray(data?.data) || !queryKey?.includes(v.partId)) return data;
  const same = (m) => m.featureName?.toLowerCase() === v.body.featureName?.toLowerCase() && (m.profile?.id ?? null) === (v.body.profileId ?? null);
  const row = { id: pendingId(), featureName: v.body.featureName, characteristicKey: v.body.characteristicKey, profile: v.show?.profile ?? null, createdAt: new Date().toISOString(), createdBy: null };
  return { ...data, data: [...data.data.filter((m) => !same(m)), row] };
};

/** { action: save, partId, body, show? } | { action: end, id } → the part's live maps. Shown at once, put back if refused. */
export const useFeatureMapMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v) =>
      v.action === "end"
        ? apiFetch(`/measurement-feature-maps/${v.id}/end`, { method: "POST", organisationId })
        : apiFetch(`/parts/${v.partId}/feature-maps`, { method: "POST", body: v.body, organisationId }),
    onMutate: (v) => guessCache(queryClient, key(organisationId, "feature-maps"), (data, queryKey) => guessFeatureMaps(data, v, queryKey)),
    onError: (_error, _vars, context) => rollbackGuess(queryClient, context),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};
