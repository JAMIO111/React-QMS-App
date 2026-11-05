import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";

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

/** Mark some (`{ ids }`) or all (`{ all: true }`) notifications as read. */
export const useMarkNotificationsRead = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch("/notifications/read", { method: "POST", body, organisationId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(organisationId, "list") }),
  });
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

/** `{ eventKey, enabled }`; enabled null returns the event to its default. */
export const useSetNotificationPreference = () =>
  usePreferenceMutation(
    (body, organisationId) => apiFetch("/notification-preferences", { method: "PUT", body, organisationId }),
    (rows, { eventKey, enabled }) =>
      rows.map((p) =>
        p.eventKey !== eventKey
          ? p
          : { ...p, enabled: enabled === null ? p.defaultEnabled : enabled, overridden: enabled !== null },
      ),
  );

export const useResetNotificationPreferences = () =>
  usePreferenceMutation(
    (_, organisationId) => apiFetch("/notification-preferences", { method: "DELETE", organisationId }),
    (rows) => rows.map((p) => ({ ...p, enabled: p.defaultEnabled, overridden: false })),
  );
