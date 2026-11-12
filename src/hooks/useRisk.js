import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

/** Risk register (docs/risk-management-plan.md): the matrix, categories, risks and their assessments. */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "risk", ...rest];

const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params ?? {}).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && p.set(k, v));
  return p.toString();
};

/** The current matrix with its versions. It changes rarely, so it is kept for a few minutes. */
export const useRiskModel = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "model"),
    queryFn: () => apiFetch("/risk-model", { organisationId }),
    enabled: !!organisationId,
    retry: false,
    staleTime: 1000 * 60 * 5,
  });
};

export const useRiskCategories = ({ all = false } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "categories", all),
    queryFn: () => apiFetch(`/risk-categories?${qs({ all: all ? "true" : "" })}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
  });
};

/** The register: filters and paging are the server's. */
export const useRisks = (params) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "list", params),
    queryFn: () => apiFetch(`/risks?${qs(params)}`, { organisationId }),
    enabled: !!organisationId,
    placeholderData: keepPreviousData,
    retry: false,
  });
};

export const useRisk = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "risk", id),
    queryFn: () => apiFetch(`/risks/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** One command at a time: { action, id, body }. Every one refreshes the organisation's cached data. */
export const useRiskMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const send = (path, method = "POST") => apiFetch(path, { method, body, organisationId });
      switch (action) {
        case "saveModel":
          return send("/risk-model", "PUT");
        case "createCategory":
          return send("/risk-categories");
        case "updateCategory":
          return send(`/risk-categories/${id}`, "PATCH");
        case "create":
          return send("/risks");
        case "update":
          return send(`/risks/${id}`, "PATCH");
        case "assess":
          return send(`/risks/${id}/assessments`);
        case "retire":
          return send(`/risks/${id}/retire`);
        case "reactivate":
          return send(`/risks/${id}/reactivate`);
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    onSuccess: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** Switching a category on or off shows at once and is put back if the server refuses. */
export const useToggleRiskCategory = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const listKey = key(organisationId, "categories");
  return useMutation({
    mutationFn: ({ id, active }) => apiFetch(`/risk-categories/${id}`, { method: "PATCH", body: { active }, organisationId }),
    onMutate: async ({ id, active }) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueriesData({ queryKey: listKey });
      queryClient.setQueriesData({ queryKey: listKey }, (old) => (old?.data ? { ...old, data: old.data.map((c) => (c.id === id ? { ...c, active } : c)) } : old));
      return { previous };
    },
    onError: (_err, _vars, context) => context?.previous?.forEach(([k, v]) => queryClient.setQueryData(k, v)),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};
