import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";
import { provisionalResult } from "../lib/audits";

/** Audits (Documentation → Audits): the register of audit definitions, one audit, and the changes made to them. */
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

/** Create, change, retire or reactivate an audit: { path, method, body }. */
export const useAuditMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, method = "POST", body }) => apiFetch(path, { method, body, organisationId }),
    onSuccess: () => refreshOrganisation(queryClient, organisationId),
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

/** Change one record's cached detail straight away; put it back if the save fails; then refresh everything. */
const useRecordEdit = (recordId, request, patch) => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const detailKey = key(organisationId, "records", "detail", recordId);
  return useMutation({
    mutationFn: (arg) => apiFetch(request(arg).path, { method: request(arg).method, body: request(arg).body, organisationId }),
    onMutate: async (arg) => {
      await queryClient.cancelQueries({ queryKey: detailKey });
      const previous = queryClient.getQueryData(detailKey);
      if (previous) queryClient.setQueryData(detailKey, patch(previous, arg));
      return { previous };
    },
    onError: (_e, _arg, context) => {
      if (context?.previous) queryClient.setQueryData(detailKey, context.previous);
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
  const prefix = key(organisationId, "findings", "classifications");
  return useMutation({
    mutationFn: ({ id, body }) => apiFetch(`/audit-finding-classifications/${id}`, { method: "PATCH", body, organisationId }),
    onMutate: async ({ id, body }) => {
      await queryClient.cancelQueries({ queryKey: prefix });
      const previous = queryClient.getQueriesData({ queryKey: prefix });
      queryClient.setQueriesData({ queryKey: prefix }, (old) => old && { ...old, data: old.data.map((c) => (c.id === id ? { ...c, ...body } : c)) });
      return { previous };
    },
    onError: (_e, _vars, context) => context?.previous.forEach(([k, data]) => queryClient.setQueryData(k, data)),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};
