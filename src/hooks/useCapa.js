import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

/** CAPA / 8D (docs/capa-8d-plan.md): the register, one 8D with its steps, team and NC links, and the commands. */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "capa", ...rest];

const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && p.set(k, v));
  return p.toString();
};

export const useCapas = (filters = {}, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "list", filters),
    queryFn: () => apiFetch(`/capas?${qs(filters)}`, { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

export const useCapa = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "detail", id),
    queryFn: () => apiFetch(`/capas/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** Active members for the team and owner pickers (needs capa.manage). */
export const useCapaPeople = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "people"),
    queryFn: () => apiFetch("/capas/people", { organisationId }),
    enabled: !!organisationId && enabled,
    staleTime: 60_000,
    retry: false,
    select: (r) => r.data,
  });
};

/** The 8Ds a non-conformance is linked to. */
export const useNcrCapas = (ncrId, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "ncr", ncrId),
    queryFn: () => apiFetch(`/ncrs/${ncrId}/capas`, { organisationId }),
    enabled: !!organisationId && !!ncrId && enabled,
    retry: false,
    select: (r) => r.data,
  });
};

/**
 * action: create | update | completeStep | reopenStep | cancel | reopen | addTeam | updateTeam | linkNcr | unlinkNcr | addAnalysis | updateAnalysis |
 * removeAnalysis | addRootCause | updateRootCause | removeRootCause | addAction | updateAction | completeAction | cancelAction | reopenAction.
 * Every command answers with the 8D, which is put in the cache; then everything in the organisation is refreshed (lib/refresh.js).
 * `id` is the 8D, except for updateTeam (the team member), unlinkNcr (the link), updateAnalysis and removeAnalysis (the analysis) and the action
 * commands that work on one action (updateAction, completeAction, cancelAction, reopenAction) and the root cause commands that work on one cause.
 */
export const useCapaMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const post = (path, method = "POST") => apiFetch(path, { method, body, organisationId });
      switch (action) {
        case "create":
          return post("/capas");
        case "update":
          return post(`/capas/${id}`, "PATCH");
        case "completeStep":
          return post(`/capas/${id}/complete-step`);
        case "reopenStep":
          return post(`/capas/${id}/reopen-step`);
        case "cancel":
          return post(`/capas/${id}/cancel`);
        case "reopen":
          return post(`/capas/${id}/reopen`);
        case "addTeam":
          return post(`/capas/${id}/team`);
        case "updateTeam":
          return post(`/capa-team/${id}`, "PATCH");
        case "linkNcr":
          return post(`/capas/${id}/ncrs`);
        case "unlinkNcr":
          return post(`/capa-ncr-links/${id}/unlink`);
        case "addAnalysis":
          return post(`/capas/${id}/analyses`);
        case "updateAnalysis":
          return post(`/capa-analyses/${id}`, "PATCH");
        case "removeAnalysis":
          return post(`/capa-analyses/${id}`, "DELETE");
        case "addRootCause":
          return post(`/capas/${id}/root-causes`);
        case "updateRootCause":
          return post(`/capa-root-causes/${id}`, "PATCH");
        case "removeRootCause":
          return post(`/capa-root-causes/${id}`, "DELETE");
        case "addAction":
          return post(`/capas/${id}/actions`);
        case "updateAction":
          return post(`/capa-actions/${id}`, "PATCH");
        case "completeAction":
          return post(`/capa-actions/${id}/complete`);
        case "cancelAction":
          return post(`/capa-actions/${id}/cancel`);
        case "reopenAction":
          return post(`/capa-actions/${id}/reopen`);
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    onSuccess: (data) => {
      if (data?.id && data?.steps) queryClient.setQueryData(key(organisationId, "detail", data.id), data);
      refreshOrganisation(queryClient, organisationId);
    },
  });
};
