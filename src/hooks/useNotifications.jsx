import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";
import { guessCache, rollbackGuess } from "../lib/optimistic";

const key = (organisationId, ...rest) => ["api", "org", organisationId, "notifications", ...rest];

/** The member's notifications for the current organisation, with the unread count; refreshed every minute. */
export const useNotifications = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "list"),
    queryFn: () => apiFetch("/notifications?limit=100", { organisationId }),
    enabled: !!organisationId,
    retry: false,
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
    refetchOnWindowFocus: true,
  });
};

/** Mark some (`{ ids }`) or all (`{ all: true }`) notifications as read: the list and the unread count change at once, and go back if the save fails. */
export const useMarkNotificationsRead = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch("/notifications/read", { method: "POST", body, organisationId }),
    onMutate: (body) => guessCache(queryClient, key(organisationId, "list"), (data) => guessNotificationsRead(data, body)),
    onError: (_e, _body, context) => rollbackGuess(queryClient, context),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** The notifications list `{ data, unread }` as it will be once `{ ids }` or `{ all: true }` are marked read. */
export const guessNotificationsRead = (data, { ids, all } = {}) => {
  if (!Array.isArray(data?.data)) return data;
  const wanted = all ? null : new Set(ids ?? []);
  let marked = 0;
  const rows = data.data.map((n) => {
    if (n.read || (wanted && !wanted.has(n.id))) return n;
    marked += 1;
    return { ...n, read: true };
  });
  if (!marked) return data;
  const unread = all ? 0 : Math.max(0, (data.unread ?? marked) - marked);
  return { ...data, data: rows, unread };
};

/** Events the member can choose from, with the effective setting and the default for their access. */
export const useNotificationPreferences = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "preferences"),
    queryFn: () => apiFetch("/notification-preferences", { organisationId }),
    enabled: !!organisationId,
    retry: false,
    select: (r) => r.data,
  });
};

/** `{ sending }`: whether this server sends email at all (without a mail provider choices are saved but nothing is emailed). */
export const useEmailDelivery = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "preferences"),
    queryFn: () => apiFetch("/notification-preferences", { organisationId }),
    enabled: !!organisationId,
    retry: false,
    select: (r) => r.email ?? null,
  });
};

const usePreferenceMutation = (request, optimistic) => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const prefKey = key(organisationId, "preferences");
  return useMutation({
    mutationFn: (arg) => request(arg, organisationId),
    // Update the screen straight away and put the previous data back if the save fails.
    onMutate: async (arg) => {
      await queryClient.cancelQueries({ queryKey: prefKey });
      const previous = queryClient.getQueryData(prefKey);
      if (previous) queryClient.setQueryData(prefKey, { ...previous, data: optimistic(previous.data, arg) });
      return { previous };
    },
    onError: (_e, _arg, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(prefKey, ctx.previous);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: prefKey });
      queryClient.invalidateQueries({ queryKey: key(organisationId, "list") });
    },
  });
};

/** `{ eventKey, enabled?, email? }`: in the app and/or by email; null returns that choice to its default. */
export const useSetNotificationPreference = () =>
  usePreferenceMutation(
    (body, organisationId) => apiFetch("/notification-preferences", { method: "PUT", body, organisationId }),
    (rows, arg) => rows.map((p) => (p.eventKey !== arg.eventKey ? p : applyPreference(p, arg))),
  );

/** What the screen shows straight after a choice (the server's answer replaces it): email is only ever on while the event is shown in the app. */
export function applyPreference(p, { enabled, email }) {
  const next = { ...p };
  if (enabled !== undefined) {
    next.enabled = enabled === null ? p.defaultEnabled : enabled;
    next.overridden = enabled !== null;
  }
  if (email !== undefined) {
    next.emailOverridden = email !== null;
    next.email = email === null ? p.emailDefault : email;
  } else if (enabled !== undefined && !next.enabled) {
    next.email = false;
  }
  next.email = Boolean(next.enabled && next.email);
  return next;
}

export const useResetNotificationPreferences = () =>
  usePreferenceMutation(
    (_, organisationId) => apiFetch("/notification-preferences", { method: "DELETE", organisationId }),
    (rows) => rows.map((p) => ({ ...p, enabled: p.defaultEnabled, overridden: false, email: p.defaultEnabled && p.emailDefault, emailOverridden: false })),
  );
