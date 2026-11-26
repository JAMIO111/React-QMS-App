import { useQuery } from "@tanstack/react-query";
import { DASHBOARD_STALE_MS } from "@/lib/dashboardPeriod";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";

/**
 * The customer quality dashboard: what was shipped to customers in the period, on time and in full, what they reported (NC quantities, PPM) and what came back.
 * `policy` is the date on-time is measured against (requested, the default, or agreed); `grace` is days allowed after it.
 */
export const useCustomerDashboard = ({ from, to, policy = "requested", grace = 0 }) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: ["api", "org", organisationId, "customer-quality", "dashboard", from, to, policy, grace],
    queryFn: () => apiFetch(`/customer-quality/dashboard?from=${from}&to=${to}&policy=${policy}&grace=${grace}`, { organisationId }),
    staleTime: DASHBOARD_STALE_MS,
    enabled: !!organisationId && !!from && !!to,
    retry: false,
    placeholderData: (previous) => previous,
  });
};
