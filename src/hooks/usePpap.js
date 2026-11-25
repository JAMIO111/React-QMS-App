import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
        case "waive":
          return send(`/ppap-elements/${id}/waive`);
        case "unwaive":
          return send(`/ppap-elements/${id}/unwaive`);
        case "removeEvidence":
          return send(`/ppap-evidence/${id}/remove`);
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    onSuccess: (submission) => submission?.id && queryClient.setQueryData(key(organisationId, "ppap", submission.id), submission),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
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
