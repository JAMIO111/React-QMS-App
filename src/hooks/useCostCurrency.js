import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { refreshOrganisation } from "../lib/refresh";
import { useOrganisation } from "../contexts/OrganisationProvider";

const key = (organisationId, ...rest) => ["api", "org", organisationId, "cost-currency", ...rest];

/** Sites whose cost lines are stated in another currency than the site's: { sites: [{ siteId, code, name, siteCurrency, lines, statedIn, missing }] }. Needs organisation.manage. */
export const useRestateReport = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "restate-report"),
    queryFn: () => apiFetch("/cost-currency/restate-report", { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

/** Restates one site's lines ({ siteId, confirm }); without `confirm` nothing changes. */
export const useRestateCosts = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch("/cost-currency/restate", { method: "POST", body, organisationId }),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};
