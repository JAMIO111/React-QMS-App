import { useQuery } from "@tanstack/react-query";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { apiFetch } from "../lib/api-client";

/**
 * Which fields of one record a scheduled import owns right now. `lock("name")` gives the props to spread on that field's control
 * (`{ lockedBy: "ERP" }`, which disables it and draws the lock with its tooltip) or `{}` when the field is free. A record that is not saved yet,
 * or that nothing manages, locks nothing. The database refuses a locked change anyway; this only tells people before they try.
 */
export const useImportLocks = (entityType, recordId) => {
  const { organisationId } = useOrganisation();
  const query = useQuery({
    queryKey: ["api", "org", organisationId, "import-locks", entityType, recordId],
    queryFn: () => apiFetch(`/import-locks?entityType=${entityType}&recordId=${recordId}`, { organisationId }),
    enabled: !!organisationId && !!entityType && !!recordId,
    retry: false,
    staleTime: 1000 * 30,
  });
  const byField = new Map((query.data?.data ?? []).map((l) => [l.field, l.connection.name]));
  const lock = (field) => (byField.has(field) ? { lockedBy: byField.get(field), disabled: true } : {});
  return { lock, locked: byField.size > 0, isLoading: query.isLoading };
};
