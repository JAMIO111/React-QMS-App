import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

const key = (organisationId) => ["api", "org", organisationId, "onboarding"];

/** Where the set-up wizard stands (needs organisation.manage): steps, what is required, whether it can be finished. */
export const useOnboarding = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId),
    queryFn: () => apiFetch("/onboarding", { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

/**
 * mutate({ action: "setStep", body: { step, status } }) or mutate({ action: "complete" }). Answers with the new state, which is put in the cache; then
 * everything in the organisation is refreshed, including who the person is (the access state and the wizard flag come from /me).
 */
export const useOnboardingMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, body }) =>
      action === "complete"
        ? apiFetch("/onboarding/complete", { method: "POST", organisationId })
        : apiFetch("/onboarding/step", { method: "PUT", body, organisationId }),
    onSuccess: (state) => {
      queryClient.setQueryData(key(organisationId), state);
      refreshOrganisation(queryClient, organisationId, { me: true });
    },
  });
};
