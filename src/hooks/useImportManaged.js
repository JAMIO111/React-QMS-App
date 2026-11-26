import { useQuery } from "@tanstack/react-query";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { apiFetch } from "../lib/api-client";

/**
 * Which areas of orders and deliveries a scheduled import owns right now (`purchase_orders`, `receipts`, `customer_orders`, `shipments`).
 * `managed("shipments")` is the name of the connection that owns shipments, or `null` when people can record them by hand. The database refuses hand
 * entry in an owned area anyway (409 `record_managed_by_import`); this only closes the buttons and says why before anyone tries.
 */
export const useImportManaged = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  const query = useQuery({
    queryKey: ["api", "org", organisationId, "import-managed"],
    queryFn: () => apiFetch("/import-locks/managed-areas", { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
    staleTime: 1000 * 30,
  });
  const byArea = new Map((query.data?.data ?? []).map((x) => [x.area, x.connection]));
  return { managed: (area) => byArea.get(area) ?? null, isLoading: query.isLoading };
};
