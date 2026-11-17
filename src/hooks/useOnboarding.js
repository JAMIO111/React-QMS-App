import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";
import { guessCache, rollbackGuess } from "../lib/optimistic";

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

/** The go-live checklist (needs organisation.manage): { items: [{ key, required, done }], requiredDone }. */
export const useGoLiveChecklist = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: [...key(organisationId), "checklist"],
    queryFn: () => apiFetch("/onboarding/checklist", { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

/**
 * mutate({ action: "setStep", body: { step, status } }) or mutate({ action: "complete" }). Marking a step is optimistic: the rail shows it at once
 * (and the step the wizard would open next), and goes back if the save fails. Finishing waits for the server. Answers with the new state, which is
 * put in the cache; then everything in the organisation is refreshed, including who the person is (the access state and the wizard flag come
 * from /me).
 */
// The wizard moves on before a step's save arrives, so saves go out one after another in the order they were made: finishing right after
// "Done, continue" must reach the server after that step's mark, never before it.
const queues = new Map();
const inOrder = (organisationId, send) => {
  const run = (queues.get(organisationId) ?? Promise.resolve()).then(send);
  queues.set(organisationId, run.catch(() => {}));
  return run;
};

export const useOnboardingMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const mutationKey = ["onboarding-update", organisationId];
  return useMutation({
    mutationKey,
    mutationFn: ({ action, body }) =>
      inOrder(organisationId, () =>
        action === "complete"
          ? apiFetch("/onboarding/complete", { method: "POST", organisationId })
          : apiFetch("/onboarding/step", { method: "PUT", body, organisationId }),
      ),
    onMutate: ({ action, body }) =>
      action === "setStep" ? guessCache(queryClient, key(organisationId), (data, queryKey) => (queryKey.length === 4 ? guessStep(data, body) : data)) : { optimistic: false, snapshot: [] },
    onError: (_error, _vars, context) => rollbackGuess(queryClient, context),
    onSuccess: (state) => {
      // A later step marked meanwhile keeps its guess on screen until its own answer.
      if (queryClient.isMutating({ mutationKey }) <= 1) queryClient.setQueryData(key(organisationId), state);
    },
    onSettled: () => refreshOrganisation(queryClient, organisationId, { me: true }),
  });
};

/** The wizard state with `step` marked `status`; the current step is the first still pending (review last), as the database works it out. */
export const guessStep = (state, { step, status } = {}) => {
  if (!Array.isArray(state?.steps) || !step) return state;
  const steps = state.steps.map((s) => (s.key === step && !s.auto ? { ...s, status } : s));
  const currentStep = steps.find((s) => s.status === "pending" && s.key !== "review")?.key ?? "review";
  return { ...state, steps, currentStep };
};
