import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

/** Reminders (WK2): the caller's own items now, and which areas they want reminding about. */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "reminders", ...rest];

export const useMyReminders = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "mine"),
    queryFn: () => apiFetch("/reminders/mine", { organisationId }),
    enabled: !!organisationId && enabled,
    staleTime: 60_000,
    retry: false,
  });
};

export const useReminderAreas = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "areas"),
    queryFn: () => apiFetch("/reminder-areas", { organisationId }),
    enabled: !!organisationId,
    staleTime: 60_000,
    retry: false,
  });
};

/** Switches one area on or off: the switch moves at once and goes back if the server refuses. */
export const useSetReminderArea = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const areasKey = key(organisationId, "areas");
  return useMutation({
    mutationFn: ({ area, enabled }) => apiFetch("/reminder-areas", { method: "PUT", body: { area, enabled }, organisationId }),
    onMutate: async ({ area, enabled }) => {
      await queryClient.cancelQueries({ queryKey: areasKey });
      const previous = queryClient.getQueryData(areasKey);
      if (previous) queryClient.setQueryData(areasKey, { ...previous, data: previous.data.map((a) => (a.area === area ? { ...a, enabled } : a)) });
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(areasKey, ctx.previous);
    },
    onSuccess: (data) => queryClient.setQueryData(areasKey, data),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};
