import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";

export const BADGE_POLL_MS = 60_000;

/** The cache key of the badges; `lib/refresh.js` marks it stale with the rest of the organisation's data after any action. */
export const badgesKey = (organisationId) => ["api", "org", organisationId, "badges"];

/**
 * Every number the side menu and the bell show, from one request that is asked again once a minute while the tab is visible
 * (a hidden tab does not poll): `{ notifications, tasks, alerts, documents, capaActions, riskWork, changes, fmeaActions, reviewActions }`.
 * A number the person may not read is `null`, so a badge for it shows nothing. This replaces nine requests every few minutes.
 */
export const useBadges = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: badgesKey(organisationId),
    queryFn: () => apiFetch("/badges", { organisationId }),
    enabled: !!organisationId,
    retry: false,
    staleTime: BADGE_POLL_MS / 2,
    refetchInterval: BADGE_POLL_MS,
  });
};
