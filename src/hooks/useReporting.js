import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";
import { guessCache, rollbackGuess } from "../lib/optimistic";

const key = (organisationId, ...rest) => ["api", "org", organisationId, "reporting", ...rest];

/** The organisation's reporting keys (never the keys themselves). */
export const useReportingKeys = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({ queryKey: key(organisationId, "keys"), queryFn: () => apiFetch("/reporting/keys", { organisationId }), enabled: !!organisationId && enabled, retry: false });
};

/** The datasets and their columns, for the Power Query script. */
export const useReportingDatasets = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "datasets"),
    queryFn: () => apiFetch("/reporting/v1/datasets", { organisationId }).then((r) => r.datasets),
    enabled: !!organisationId && enabled,
    retry: false,
    staleTime: 10 * 60_000,
  });
};

/**
 * Make a key (the answer carries the key once; the screen shows it) or revoke one. A revoke shows at once and is put back if refused.
 * `{ action: "create", body: { name, days } }` · `{ action: "revoke", id, body: { reason } }`
 */
export const useReportingKeyMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) =>
      apiFetch(action === "create" ? "/reporting/keys" : `/reporting/keys/${id}/revoke`, { method: "POST", body, organisationId }),
    onMutate: (vars) =>
      vars.action === "revoke"
        ? guessCache(queryClient, key(organisationId, "keys"), (data) =>
            data?.data
              ? { ...data, data: data.data.map((k) => (k.id === vars.id ? { ...k, status: "revoked", revokedAt: new Date().toISOString(), revokedReason: vars.body.reason } : k)) }
              : data,
          )
        : { optimistic: false },
    onError: (_e, _v, context) => rollbackGuess(queryClient, context),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};
