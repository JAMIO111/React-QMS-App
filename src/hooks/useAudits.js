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
        const empty = body.answer == null && body.value == null && !body.note;
        if (empty) return { ...q, response: null };
        return { ...q, response: { id: q.response?.id ?? "pending", ncrs: q.response?.ncrs ?? [], answer: body.answer ?? null, value: body.value ?? null, note: body.note ?? null, result: provisionalResult(q, body) } };
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
