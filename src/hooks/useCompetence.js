import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DASHBOARD_STALE_MS } from "@/lib/dashboardPeriod";
import { apiFetch, describeApiError } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { useToast } from "../contexts/ToastProvider";
import { guessCache, pendingId, rollbackGuess, settle, updateById } from "../lib/optimistic";
import { COMPETENCE_GUESSED } from "../lib/competence";

export { COMPETENCE_GUESSED };

/** Competence (docs/competence-plan.md): categories, skills and positions. */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "competence", ...rest];

const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && p.set(k, v));
  return p.toString();
};

const useList = (name, path, params, enabled = true) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, name, params),
    queryFn: () => apiFetch(`/competence/${path}?${qs(params)}`, { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

/** `all` includes switched-off / retired ones (the settings page); pickers use the active ones. */
export const useCompetenceCategories = ({ all = false, enabled = true } = {}) => useList("categories", "categories", { all: all ? "true" : "" }, enabled);
export const useCompetenceSkills = ({ all = false, categoryId, q, enabled = true } = {}) => useList("skills", "skills", { all: all ? "true" : "", categoryId, q }, enabled);
export const useCompetencePositions = ({ all = false, enabled = true } = {}) => useList("positions", "positions", { all: all ? "true" : "" }, enabled);

/** The skills matrix: employees by skills (filters and paging are the server's). */
export const useCompetenceMatrix = (params) => useList("matrix", "matrix", params);
/** One person's standing, for people who may read competence. */
export const useCompetencePerson = (employeeId) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "person", employeeId),
    queryFn: () => apiFetch(`/competence/people/${employeeId}`, { organisationId }),
    enabled: !!organisationId && !!employeeId,
    retry: false,
  });
};
/** The caller's own record (any member); `{ linked: false }` when their sign-in is not linked to an employee. */
export const useMyCompetence = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "me"),
    queryFn: () => apiFetch("/competence/me", { organisationId }),
    enabled: !!organisationId,
    retry: false,
  });
};

/** Training sessions (page-based list) and one session with its attendees and files. */
export const useTrainingSessions = (params) => useList("training", "training-sessions", params);
export const useTrainingSession = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "training-session", id),
    queryFn: () => apiFetch(`/competence/training-sessions/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** Dashboard figures for a period ({ from, to } — YYYY-MM-DD). Gaps and expiry are as of today; training is for the period. */
export const useCompetenceDashboard = ({ from, to }) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "dashboard", from, to),
    queryFn: () => apiFetch(`/competence-dashboard?from=${from}&to=${to}`, { organisationId }),
    staleTime: DASHBOARD_STALE_MS,
    enabled: !!organisationId && !!from && !!to,
    retry: false,
    placeholderData: keepPreviousData,
  });
};

/** Every page of the matrix for the current filters (≤ 100 people a page), for the CSV export. */
export const useMatrixExport = () => {
  const { organisationId } = useOrganisation();
  return async (params) => {
    let page = 1;
    let first = null;
    const data = [];
    for (;;) {
      const res = await apiFetch(`/competence/matrix?${qs({ ...params, page, pageSize: 100 })}`, { organisationId });
      first ??= res;
      data.push(...res.data);
      if (page * res.pageSize >= res.total || page >= 10) return { ...first, data };
      page += 1;
    }
  };
};

const FILE_ACTIONS = new Set(["removeFile", "restoreFile"]);

/** One command at a time: { action, id, body, show?, failed? }. Every one refreshes the organisation's cached data. */
export const useCompetenceMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const send = (path, method = "POST") => apiFetch(path, { method, body, organisationId });
      switch (action) {
        case "createCategory":
          return send("/competence/categories");
        case "updateCategory":
          return send(`/competence/categories/${id}`, "PATCH");
        case "createSkill":
          return send("/competence/skills");
        case "updateSkill":
          return send(`/competence/skills/${id}`, "PATCH");
        case "retireSkill":
          return send(`/competence/skills/${id}/retire`);
        case "reactivateSkill":
          return send(`/competence/skills/${id}/reactivate`);
        case "createPosition":
          return send("/competence/positions");
        case "updatePosition":
          return send(`/competence/positions/${id}`, "PATCH");
        case "setPositionSkills":
          return send(`/competence/positions/${id}/skills`, "PUT");
        case "retirePosition":
          return send(`/competence/positions/${id}/retire`);
        case "reactivatePosition":
          return send(`/competence/positions/${id}/reactivate`);
        case "assignPosition":
          return send(`/competence/people/${id}/positions`);
        case "endPosition":
          return send(`/competence/employee-positions/${id}/end`);
        case "assess":
          return send(`/competence/people/${id}/assessments`);
        case "createSession":
          return send("/competence/training-sessions");
        case "updateSession":
          return send(`/competence/training-sessions/${id}`, "PATCH");
        case "addAttendee":
          return send(`/competence/training-sessions/${id}/attendees`);
        case "recordAttendees":
          return send(`/competence/training-sessions/${id}/record`);
        case "removeAttendee":
          return send(`/competence/session-attendees/${id}/remove`);
        case "voidAttendee":
          return send(`/competence/session-attendees/${id}/void`);
        case "closeSession":
          return send(`/competence/training-sessions/${id}/close`);
        case "reopenSession":
          return send(`/competence/training-sessions/${id}/reopen`);
        case "cancelSession":
          return send(`/competence/training-sessions/${id}/cancel`);
        case "removeFile":
          return send(`/competence/competence-attachments/${id}/delete`);
        case "restoreFile":
          return send(`/competence/competence-attachments/${id}/restore`);
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    onMutate: (vars) =>
      COMPETENCE_GUESSED.has(vars?.action) || FILE_ACTIONS.has(vars?.action) ? guessCache(queryClient, ["api", "org", organisationId], (data) => guessCompetence(data, vars)) : { optimistic: false },
    onError: (error, vars, context) => {
      rollbackGuess(queryClient, context);
      if (COMPETENCE_GUESSED.has(vars?.action) && !error?.cancelled) toast?.showToast({ type: "error", title: vars.failed ?? "Not saved", message: describeApiError(error) });
    },
    // Commands that were not guessed wait for the refetch, so the screen has moved on when the caller's onSuccess runs.
    onSettled: (_data, _error, _vars, context) => settle(queryClient, organisationId, context),
  });
};

/** The body's plain values written onto the object, for the keys it already has. */
const mergeFlat = (obj, body = {}) => {
  let changed = false;
  const out = { ...obj };
  for (const [k, v] of Object.entries(body ?? {})) {
    if (k === "rowVersion" || !(k in obj) || v === undefined || obj[k] === v || (v !== null && typeof v === "object")) continue;
    out[k] = v;
    changed = true;
  }
  return changed ? out : obj;
};

/** Any cached competence data as it will be after a guessed command of useCompetenceMutation. Others are left alone. */
export const guessCompetence = (data, { action, id, body = {}, show = {} } = {}) => {
  if (!id) return data;
  const now = new Date().toISOString();
  switch (action) {
    case "updateCategory":
    case "updateSkill":
    case "updatePosition":
    case "updateSession":
      return updateById(data, id, (o) => mergeFlat(o, body));
    case "reactivateSkill":
    case "reactivatePosition":
      return updateById(data, id, (o) => ("active" in o ? { ...o, active: true, ...("retiredReason" in o ? { retiredReason: null } : {}) } : o));
    case "setPositionSkills":
      return show.skills ? updateById(data, id, (o) => ("skills" in o ? { ...o, skills: show.skills } : o)) : data;
    case "endPosition":
      return updateById(data, id, (o) => ("endedOn" in o ? { ...o, endedOn: body.endedOn ?? o.endedOn } : o));
    case "addAttendee":
      return updateById(data, id, (o) =>
        Array.isArray(o.attendees)
          ? { ...o, attendees: [...o.attendees, { id: pendingId(), status: "enrolled", employee: { id: body.employeeId, name: show.name ?? "…" }, completedOn: null, note: null, reason: null, recordedBy: null, files: [] }] }
          : o,
      );
    case "recordAttendees": {
      const ids = new Set(body.attendeeIds ?? []);
      return updateById(data, id, (o) => {
        if (!Array.isArray(o.attendees)) return o;
        const attendees = o.attendees.map((a) => (ids.has(a.id) ? { ...a, status: body.outcome, completedOn: body.outcome === "absent" ? null : (body.completedOn ?? null), note: body.note ?? null } : a));
        const added = body.outcome === "completed" ? o.attendees.filter((a) => ids.has(a.id) && a.status !== "completed").length : 0;
        return { ...o, attendees, ...(typeof o.completedCount === "number" ? { completedCount: o.completedCount + added } : {}) };
      });
    }
    case "removeAttendee":
      return updateById(data, id, (a) => ("status" in a ? { ...a, status: "removed", reason: body.reason ?? null } : a));
    case "voidAttendee":
      return updateById(data, id, (a) => ("status" in a ? { ...a, status: "voided", reason: body.reason ?? null } : a));
    case "removeFile":
      return updateById(data, id, (f) => ({ ...f, deletedAt: now, deleteReason: body.reason ?? null }));
    case "restoreFile":
      return updateById(data, id, (f) => ({ ...f, deletedAt: null, deleteReason: null }));
    default:
      return data;
  }
};
