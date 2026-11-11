import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

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

/** One command at a time: { action, id, body }. Every one refreshes the organisation's cached data. */
export const useCompetenceMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
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
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    onSuccess: () => refreshOrganisation(queryClient, organisationId),
  });
};
