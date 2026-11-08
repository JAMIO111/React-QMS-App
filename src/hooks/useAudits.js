import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

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
