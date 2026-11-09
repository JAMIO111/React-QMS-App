import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

const key = (organisationId, ...rest) => ["api", "org", organisationId, "material-certificates", ...rest];
const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && p.set(k, v));
  return p.toString();
};

/** Certificate register page: { data, page, pageSize, total, reviewCount }. */
export const useMaterialCertificates = (filters = {}, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, filters),
    queryFn: () => apiFetch(`/material-certificates?${qs(filters)}`, { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
    placeholderData: (previous) => previous,
  });
};

/** Commands: record, update, review, withdraw. Everything is marked stale, so receipt lines and the register show what changed. */
export const useCertificateMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const send = (path, method = "POST") => apiFetch(path, { method, body: body ?? {}, organisationId });
      switch (action) {
        case "record":
          return send("/material-certificates");
        case "update":
          return send(`/material-certificates/${id}`, "PATCH");
        case "review":
          return send(`/material-certificates/${id}/review`);
        case "withdraw":
          return send(`/material-certificates/${id}/withdraw`);
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    onSuccess: () => refreshOrganisation(queryClient, organisationId),
  });
};
