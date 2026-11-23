import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { useDebouncedValue } from "./useDebounce";

export const SEARCH_MIN_LENGTH = 2;

/**
 * Records matching what was typed in the palette (`GET /search`): `{ groups: [{ kind, total, items: [{ id, title, subtitle, status }] }] }` for the
 * kinds the person may read. Waits a moment after the last key; the answer to the previous words stays on screen meanwhile. `kind` asks for one
 * kind only (with a longer `limit`), the palette's category chip.
 */
export const useRecordSearch = ({ q, kind, limit = 5, enabled = true }) => {
  const { organisationId } = useOrganisation();
  const typed = q.trim();
  const term = useDebouncedValue(typed, 200);
  const query = useQuery({
    queryKey: ["api", "org", organisationId, "search", term, kind ?? "all", limit],
    queryFn: () => apiFetch(`/search?q=${encodeURIComponent(term)}${kind ? `&kind=${kind}` : ""}&limit=${limit}`, { organisationId }),
    enabled: enabled && !!organisationId && term.length >= SEARCH_MIN_LENGTH,
    staleTime: 30 * 1000,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const active = typed.length >= SEARCH_MIN_LENGTH;
  return {
    groups: active ? (query.data?.groups ?? []) : [],
    /** Searching, or about to (the words changed and the request has not gone out yet). */
    searching: active && (typed !== term || query.isFetching),
    failed: active && !!query.error,
  };
};
