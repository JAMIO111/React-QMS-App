/**
 * Refreshing data after an action.
 *
 * Almost every screen shows data that another module can change: an inspection adds SPC points and can raise an NC, a member's
 * departments decide who an alert reaches, an NC appears on a calibration, a plan change alters what an inspection resolves. Guessing
 * which views to refresh per action went stale again and again, so after ANY successful action the whole organisation's cached data is
 * invalidated. Only queries on screen refetch straight away; the rest are marked stale and load fresh when next opened, so this is cheap.
 *
 * Every mutation hook calls `refreshOrganisation` in its success path. New hooks must do the same (see CLAUDE.md).
 */
export const orgRoot = (organisationId) => ["api", "org", organisationId];

/**
 * Invalidate everything cached for the organisation. `me: true` also refreshes the signed-in person's profile, memberships and permissions,
 * for actions that can change what they may do (roles, subscriptions, their own details). Returns the promise of the refetches.
 */
export const refreshOrganisation = (queryClient, organisationId, { me = false } = {}) => {
  const work = [queryClient.invalidateQueries({ queryKey: orgRoot(organisationId) })];
  if (me) {
    work.push(queryClient.invalidateQueries({ queryKey: ["api", "me"] }));
    work.push(queryClient.invalidateQueries({ queryKey: ["memberships"] }));
  }
  return Promise.all(work);
};
