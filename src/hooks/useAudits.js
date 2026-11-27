import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DASHBOARD_STALE_MS } from "@/lib/dashboardPeriod";
import { apiFetch, describeApiError } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { useToast } from "../contexts/ToastProvider";
import { refreshOrganisation } from "../lib/refresh";
import { guessCache, optimisticTarget, rollbackGuess, settle, updateById } from "../lib/optimistic";
import { provisionalResult } from "../lib/audits";

/** Audits (the Audits module): the register of audit definitions, one audit, and the changes made to them. */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "documentation", "audits", ...rest];

const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && p.set(k, v));
  return p.toString();
};

export const useAudits = (params = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "list", params),
    queryFn: () => apiFetch(`/audits?${qs(params)}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
    placeholderData: keepPreviousData,
  });
};

export const useAudit = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "detail", id),
    queryFn: () => apiFetch(`/audits/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** Audits dashboard figures for a period ({ from, to } — YYYY-MM-DD). */
export const useAuditsDashboard = ({ from, to }) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "dashboard", from, to),
    queryFn: () => apiFetch(`/audits-dashboard?from=${from}&to=${to}`, { organisationId }),
    staleTime: DASHBOARD_STALE_MS,
    enabled: !!organisationId && !!from && !!to,
    retry: false,
    placeholderData: keepPreviousData,
  });
};

/** The history of an audit: every version, newest first. */
export const useAuditVersions = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "versions", id),
    queryFn: () => apiFetch(`/audits/${id}/versions`, { organisationId }).then((r) => r.data),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** One version, whole, with what it changed from the one before. */
export const useAuditVersion = (id, version) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "versions", id, version),
    queryFn: () => apiFetch(`/audits/${id}/versions/${version}`, { organisationId }),
    enabled: !!organisationId && !!id && !!version,
    retry: false,
  });
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Commands the screen shows before the server answers: [path pattern, what changes]. */
const AUDIT_COMMANDS = [
  [new RegExp(`^/audit-occurrences/(${UUID})/skip$`, "i"), (o, body) => ({ ...o, state: "skipped", ...("skippedReason" in o ? { skippedReason: body?.reason ?? null } : {}) })],
  [new RegExp(`^/audit-occurrences/(${UUID})/unskip$`, "i"), (o) => ({ ...o, state: (o.daysFromToday ?? 0) >= 0 ? "upcoming" : "overdue", ...("skippedReason" in o ? { skippedReason: null } : {}) })],
  [new RegExp(`^/audits/(${UUID})/retire$`, "i"), (o, body) => ({ ...o, status: "retired", ...("retired" in o ? { retired: { at: new Date().toISOString(), by: null, reason: body?.reason ?? "" } } : {}) })],
  [new RegExp(`^/audits/(${UUID})/reactivate$`, "i"), (o) => ({ ...o, status: "active", ...("retired" in o ? { retired: null } : {}) })],
  [new RegExp(`^/audit-records/(${UUID})/abandon$`, "i"), (o, body) => ({ ...o, status: "abandoned", ...("abandonReason" in o ? { abandonReason: body?.reason ?? null } : {}) })],
  [new RegExp(`^/audit-findings/(${UUID})/withdraw$`, "i"), (o) => ({ ...o, status: "withdrawn" })],
  [new RegExp(`^/audit-findings/(${UUID})/reopen$`, "i"), (o) => ({ ...o, status: "open" })],
  [new RegExp(`^/audit(?:-finding)?-attachments/(${UUID})/delete$`, "i"), (o, body) => ({ ...o, deletedAt: new Date().toISOString(), deleteReason: body?.reason ?? null })],
  [new RegExp(`^/audit(?:-finding)?-attachments/(${UUID})/restore$`, "i"), (o) => ({ ...o, deletedAt: null, deleteReason: null })],
];

const isFileCommand = (path = "") => /^\/audit(?:-finding)?-attachments\//.test(path);

/**
 * Cached audits data as it will be after `{ path, method, body }` of useAuditMutation: a flat PATCH of one record (its plain fields), a DELETE,
 * or one of AUDIT_COMMANDS. Anything else (creating, completing, raising a non-conformance, closing a finding) is left to the server: returns `data`.
 */
export const guessAudits = (data, { path, method = "POST", body } = {}) => {
  const target = optimisticTarget({ path, method, body });
  if (target?.remove) return updateById(data, target.id, (o) => o, { remove: true });
  if (target) {
    return updateById(data, target.id, (o) => {
      let changed = false;
      const out = { ...o };
      for (const [k, v] of Object.entries(body)) {
        if (k === "rowVersion" || !(k in o) || v === undefined || o[k] === v) continue;
        out[k] = v;
        changed = true;
      }
      return changed ? out : o;
    });
  }
  if (method !== "POST") return data;
  for (const [pattern, change] of AUDIT_COMMANDS) {
    const m = String(path).match(pattern);
    if (m) return updateById(data, m[1], (o) => change(o, body));
  }
  return data;
};

/** Whether `guessAudits` would show this request before the server answers. */
export const auditGuessed = (request = {}) => {
  const method = request.method ?? "POST";
  if (optimisticTarget({ ...request, method })) return true;
  return method === "POST" && AUDIT_COMMANDS.some(([pattern]) => pattern.test(String(request.path)));
};

/**
 * Create, change, retire or reactivate an audit, a record, a finding, a slot or a file: { path, method, body, failed? }. Requests that auditGuessed
 * says are guessable change the screen at once; a refusal puts it back with an error toast titled `failed` (files: AttachmentDrop tells its own).
 */
export const useAuditMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ path, method = "POST", body }) => apiFetch(path, { method, body, organisationId }),
    onMutate: (request) => (auditGuessed(request) ? guessCache(queryClient, ["api", "org", organisationId], (data) => guessAudits(data, request)) : { optimistic: false }),
    onError: (error, request, context) => {
      rollbackGuess(queryClient, context);
      if (auditGuessed(request) && !isFileCommand(request?.path) && !error?.cancelled) toast?.showToast({ type: "error", title: request.failed ?? "Not saved", message: describeApiError(error) });
    },
    // Requests that were not guessed wait for the refetch, so the screen has moved on when the caller's onSuccess runs.
    onSettled: (_data, _error, _request, context) => settle(queryClient, organisationId, context),
  });
};

// ---- the schedule and the audit records ----------------------------------------------------------

/** Slots in a window (default: a month either side of today), with their state and the record made for them. The API makes the slots when it is read. */
export const useAuditSchedule = (params = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "schedule", params),
    queryFn: () => apiFetch(`/audit-schedule?${qs(params)}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
    placeholderData: keepPreviousData,
  });
};

export const useAuditRecords = (params = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "records", "list", params),
    queryFn: () => apiFetch(`/audit-records?${qs(params)}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
    placeholderData: keepPreviousData,
  });
};

export const useAuditRecord = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "records", "detail", id),
    queryFn: () => apiFetch(`/audit-records/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/**
 * Saves to one address go out one after another, in the order they were made. Choosing "carried out on" replaces the whole list each time, so two quick
 * ticks sent together could reach the server the wrong way round and the first would undo the second.
 */
const queues = new Map();
/** The longest a save waits for the one before it: a request that hangs must not hold every later save for ever (after this it goes anyway). */
export const MAX_ORDER_WAIT_MS = 20_000;
/** For tests: forget saves still in the queue. */
export const resetSaveOrder = () => queues.clear();
export const inOrder = (queueKey, run) => {
  const before = queues.get(queueKey);
  let next;
  if (before) {
    // Something still saving: start when it has finished (worked or not), or when it has taken too long.
    next = new Promise((resolve, reject) => {
      let started = false;
      const go = () => {
        if (started) return;
        started = true;
        clearTimeout(timer);
        Promise.resolve().then(run).then(resolve, reject);
      };
      const timer = setTimeout(go, MAX_ORDER_WAIT_MS);
      before.then(go, go);
    });
  } else {
    // Nothing waiting: start at once.
    next = new Promise((resolve) => resolve(run()));
  }
  queues.set(queueKey, next);
  next.catch(() => {}).finally(() => {
    if (queues.get(queueKey) === next) queues.delete(queueKey);
  });
  return next;
};

/** Change one record's cached detail straight away; put it back if the save fails; then refresh everything. */
const useRecordEdit = (recordId, request, patch, { ordered = false } = {}) => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const toast = useToast();
  const detailKey = key(organisationId, "records", "detail", recordId);
  return useMutation({
    mutationFn: (arg) => {
      const r = request(arg);
      const send = () => apiFetch(r.path, { method: r.method, body: r.body, organisationId });
      // `ordered`: saves of the same thing go one after another, so an older one can never arrive last and win. A function names the thing within the
      // address (one question's answer), so other questions are not held up.
      return ordered ? inOrder(`${r.method} ${r.path}${typeof ordered === "function" ? `#${ordered(arg)}` : ""}`, send) : send();
    },
    onMutate: async (arg) => {
      await queryClient.cancelQueries({ queryKey: detailKey });
      const previous = queryClient.getQueryData(detailKey);
      if (previous) queryClient.setQueryData(detailKey, patch(previous, arg));
      return { previous };
    },
    onError: (error, _arg, context) => {
      if (context?.previous) queryClient.setQueryData(detailKey, context.previous);
      if (!error?.cancelled) toast?.showToast({ type: "error", title: "Not saved", message: describeApiError(error) });
    },
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** Answer a question: { questionId, answer?, value?, note? } (nothing at all clears the answer). */
export const useAnswerAudit = (recordId) =>
  useRecordEdit(
    recordId,
    (body) => ({ path: `/audit-records/${recordId}/responses`, method: "PUT", body }),
    (record, body) => ({
      ...record,
      questions: record.questions.map((q) => {
        if (q.id !== body.questionId) return q;
        const empty = body.answer == null && body.value == null && !body.note && !body.choice;
        if (empty) return { ...q, response: null };
        return { ...q, response: { id: q.response?.id ?? "pending", ncrs: q.response?.ncrs ?? [], finding: q.response?.finding ?? null, answer: body.answer ?? null, value: body.value ?? null, choice: body.choice ?? null, note: body.note ?? null, result: provisionalResult(q, body) } };
      }),
    }),
    // Each save sends the whole answer and note, so two quick saves for one question must reach the server in the order they were made.
    { ordered: (body) => body.questionId },
  );

/** Choose what the audit was carried out on: an array of the available targets. */
export const useSetAuditTargets = (recordId) =>
  useRecordEdit(
    recordId,
    (chosen) => ({
      path: `/audit-records/${recordId}/targets`,
      method: "PUT",
      body: { targets: chosen.map((t) => (t.kind === "machine" ? { kind: "machine", machineId: t.id } : t.kind === "operation" ? { kind: "operation", operationCode: t.id } : { kind: "department", departmentId: t.id })) },
    }),
    (record, chosen) => ({ ...record, targets: chosen.map(({ kind, id, label }) => ({ kind, id, label })) }),
    { ordered: true },
  );

/** The operation codes to choose from when saying what an audit is relevant to (control plan operations plus those already on an audit). */
export const useOperationCodes = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "operation-codes"),
    queryFn: () => apiFetch("/audits/operation-codes", { organisationId }),
    enabled: !!organisationId,
    retry: false,
    staleTime: 60_000,
    select: (r) => r.data,
  });
};

/** The evidence files of a record (the ones removed too, so they can be put back), optionally for one question. */
export const useAuditAttachments = (recordId, questionId) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "records", "files", recordId, questionId ?? "all"),
    queryFn: () => apiFetch(`/audit-records/${recordId}/attachments?deleted=include${questionId ? `&questionId=${questionId}` : ""}`, { organisationId }),
    enabled: !!organisationId && !!recordId,
    retry: false,
    select: (r) => r.data,
  });
};

// ---- findings (Phase A) --------------------------------------------------------------------------

/** The organisation's finding classifications; `all` includes the ones switched off. */
export const useFindingClassifications = ({ all = false } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "findings", "classifications", all),
    queryFn: () => apiFetch(`/audit-finding-classifications${all ? "?all=true" : ""}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
    select: (r) => r.data,
  });
};

export const useAuditFindings = (params = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "findings", "list", params),
    queryFn: () => apiFetch(`/audit-findings?${qs(params)}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
    placeholderData: keepPreviousData,
  });
};

export const useAuditFinding = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "findings", "detail", id),
    queryFn: () => apiFetch(`/audit-findings/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** The findings of one audit record (withdrawn ones included, so the list says what happened). */
export const useRecordFindings = (recordId) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "findings", "record", recordId),
    queryFn: () => apiFetch(`/audit-records/${recordId}/findings`, { organisationId }),
    enabled: !!organisationId && !!recordId,
    retry: false,
    select: (r) => r.data,
  });
};

/** The evidence files of a finding (the ones removed too, so they can be put back). */
export const useFindingAttachments = (findingId) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "findings", "files", findingId),
    queryFn: () => apiFetch(`/audit-findings/${findingId}/attachments?deleted=include`, { organisationId }),
    enabled: !!organisationId && !!findingId,
    retry: false,
    select: (r) => r.data,
  });
};

/** The audit, finding and evidence behind a non-conformance: `{ available, items }`. */
export const useNcrAuditSource = (ncrId, enabled = true) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "findings", "ncr-source", ncrId),
    queryFn: () => apiFetch(`/ncrs/${ncrId}/audit-source`, { organisationId }),
    enabled: !!organisationId && !!ncrId && enabled,
    retry: false,
  });
};

/** Rename, reorder, set the default severity of, or switch off a classification; the screen follows at once and goes back if the save fails. */
export const useUpdateClassification = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const toast = useToast();
  const prefix = key(organisationId, "findings", "classifications");
  return useMutation({
    mutationFn: ({ id, body }) => apiFetch(`/audit-finding-classifications/${id}`, { method: "PATCH", body, organisationId }),
    onMutate: async ({ id, body }) => {
      await queryClient.cancelQueries({ queryKey: prefix });
      const previous = queryClient.getQueriesData({ queryKey: prefix });
      queryClient.setQueriesData({ queryKey: prefix }, (old) => old && { ...old, data: old.data.map((c) => (c.id === id ? { ...c, ...body } : c)) });
      return { previous };
    },
    onError: (error, _vars, context) => {
      context?.previous.forEach(([k, data]) => queryClient.setQueryData(k, data));
      toast?.showToast({ type: "error", title: "Not saved", message: describeApiError(error) });
    },
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};
