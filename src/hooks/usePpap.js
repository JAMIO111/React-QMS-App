import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DASHBOARD_STALE_MS } from "@/lib/dashboardPeriod";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

/** PPAP (docs/ppap-plan.md): the register, one submission with its elements, the requirements and each customer's rules. */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "ppap", ...rest];

const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params ?? {}).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && p.set(k, v));
  return p.toString();
};

/** The register: filters and paging are the server's. */
export const usePpaps = (params, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "list", params),
    queryFn: () => apiFetch(`/ppaps?${qs(params)}`, { organisationId }),
    enabled: !!organisationId && enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
};

/** The dashboard: figures as of today and what was sent and answered in the period (`GET /ppap-dashboard`). */
export const usePpapDashboard = (period) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "dashboard", period?.fromIso, period?.toIso),
    queryFn: () => apiFetch(`/ppap-dashboard?${qs({ from: period.fromIso, to: period.toIso })}`, { organisationId }),
    staleTime: DASHBOARD_STALE_MS,
    enabled: !!organisationId && !!period?.fromIso,
    placeholderData: keepPreviousData,
    retry: false,
  });
};

export const usePpap = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "ppap", id),
    queryFn: () => apiFetch(`/ppaps/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/**
 * One command at a time: { action, id, body } where `id` is what the command acts on (the submission, an element, a piece of evidence). The database decides
 * what is allowed (readiness, waivers), so the screen waits for the answer, which is the whole submission, and puts it where the page reads it at once.
 */
export const usePpapMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const send = (path, method = "POST") => apiFetch(path, { method, body, organisationId });
      switch (action) {
        case "create":
          return send("/ppaps");
        case "update":
          return send(`/ppaps/${id}`, "PATCH");
        case "setLevel":
          return send(`/ppaps/${id}/level`, "PUT");
        case "ready":
          return send(`/ppaps/${id}/ready`);
        case "reopen":
          return send(`/ppaps/${id}/reopen`);
        case "withdraw":
          return send(`/ppaps/${id}/withdraw`);
        case "updateElement":
          return send(`/ppap-elements/${id}`, "PATCH");
        case "addFile":
          return send(`/ppap-elements/${id}/files`);
        case "addLink":
          return send(`/ppap-elements/${id}/links`);
        case "waive":
          return send(`/ppap-elements/${id}/waive`);
        case "unwaive":
          return send(`/ppap-elements/${id}/unwaive`);
        case "removeEvidence":
          return send(`/ppap-evidence/${id}/remove`);
        case "savePsw":
          return send(`/ppaps/${id}/psw`, "PUT");
        case "signPsw":
          return send(`/ppaps/${id}/psw/sign`);
        case "unsignPsw":
          return send(`/ppaps/${id}/psw/unsign`);
        case "submit":
          return send(`/ppaps/${id}/submit`);
        case "decide":
          return send(`/ppaps/${id}/decisions`);
        case "resubmit":
          return send(`/ppaps/${id}/resubmission`);
        case "review":
          return send(`/ppaps/${id}/reviews`);
        case "askCustomer":
          return send(`/ppaps/${id}/customer-requests`);
        case "askSupplier":
          return send(`/ppaps/${id}/supplier-requests`);
        case "withdrawCustomerRequest":
          return send(`/ppap-customer-requests/${id}/withdraw`);
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    onSuccess: (submission) => submission?.id && queryClient.setQueryData(key(organisationId, "ppap", submission.id), submission),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** The requests put to the customer to answer a sent submission in the portal (PP4), and the customer it can be put to. */
export const usePpapCustomerRequests = (id, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "customer-requests", id),
    queryFn: () => apiFetch(`/ppaps/${id}/customer-requests`, { organisationId }),
    enabled: !!organisationId && !!id && enabled,
    retry: false,
  });
};

/** The organisation's requirement set (which elements each level needs, the study minimums) with its versions. It changes rarely. */
export const useRequirements = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "requirements"),
    queryFn: () => apiFetch("/ppap-requirements", { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
    staleTime: 1000 * 60 * 5,
  });
};

export const useSaveRequirements = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch("/ppap-requirements", { method: "PUT", body, organisationId }),
    onSuccess: (answer) => queryClient.setQueryData(key(organisationId, "requirements"), answer),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** Each customer's own rules: their usual level, extra elements and own minimums. */
export const useCustomerRules = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "customer-rules"),
    queryFn: () => apiFetch("/ppap-customer-rules", { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

export const useSetCustomerRules = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, body }) => apiFetch(`/ppap-customer-rules/${customerId}`, { method: "PUT", body, organisationId }),
    onSuccess: (answer) => queryClient.setQueryData(key(organisationId, "customer-rules"), answer),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** Records of one kind that can be linked to an element (read as the person, with each one's own state). Only asked for while the dialog is open. */
export const usePpapCandidates = ({ elementId, kind, q }, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "candidates", elementId, kind, q ?? ""),
    queryFn: () => apiFetch(`/ppap-candidates?${qs({ elementId, kind, q: q?.trim() || undefined })}`, { organisationId }),
    enabled: !!organisationId && !!elementId && !!kind && enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
};

/** The Part Submission Warrant as a form (the printable page). */
export const usePswForm = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "psw", id),
    queryFn: () => apiFetch(`/ppaps/${id}/psw`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** Where a part's revision stands for each of its customers, and what is worth saying about it (information only; `available` is false without `ppap.read`). */
export const usePartPpapState = (partId, partRevisionId, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "part-state", partId, partRevisionId ?? null),
    queryFn: () => apiFetch(`/part-ppap-state?${qs({ partId, partRevisionId })}`, { organisationId }),
    enabled: !!organisationId && !!partId && enabled,
    retry: false,
  });
};

/** The PPAPs raised from a change or a control plan revision, and the new ones it may call for. */
export const usePpapPrompts = (kind, id, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "prompts", kind, id),
    queryFn: () => apiFetch(`/ppap-prompts?${qs({ kind, id })}`, { organisationId }),
    enabled: !!organisationId && !!id && enabled,
    retry: false,
  });
};

/** Asks what a record suggests for a PPAP raised from it. Nothing is saved; the answer fills the start dialog. */
export const usePpapDraft = () => {
  const { organisationId } = useOrganisation();
  return useMutation({ mutationFn: ({ kind, id }) => apiFetch(`/ppap-draft?${qs({ kind, id })}`, { organisationId }) });
};
