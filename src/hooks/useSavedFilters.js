import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";
import { SAVED_FILTER_LIMIT } from "../lib/savedFilters";

const key = (organisationId, scope) => ["api", "org", organisationId, "saved-filters", scope];

/** The signed-in person's saved filters for a register: { data: [{ id, name, filters, position }], limit }. */
export const useSavedFilters = (scope) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, scope),
    queryFn: () => apiFetch(`/saved-filters?scope=${scope}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
    staleTime: 1000 * 60,
    placeholderData: { data: [], limit: SAVED_FILTER_LIMIT },
  });
};

/**
 * Save, change or delete one of the person's saved filters: `{ action: "create", body: { name, filters } }`, `{ action: "update", id, body: { name?, filters? } }`
 * or `{ action: "delete", id }`. The list changes on screen at once and is put back if the save fails (the database enforces the limit of five and unique names).
 */
export const useSavedFilterMutation = (scope) => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const listKey = key(organisationId, scope);
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      if (action === "create") return apiFetch("/saved-filters", { method: "POST", body: { scope, ...body }, organisationId });
      if (action === "update") return apiFetch(`/saved-filters/${id}`, { method: "PATCH", body, organisationId });
      return apiFetch(`/saved-filters/${id}`, { method: "DELETE", organisationId });
    },
    onMutate: async ({ action, id, body }) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueryData(listKey);
      if (previous) {
        const data = previous.data;
        const next =
          action === "create"
            ? [...data, { id: `pending-${Date.now()}`, scope, name: body.name, filters: body.filters, position: data.length }]
            : action === "update"
              ? data.map((f) => (f.id === id ? { ...f, ...(body.name !== undefined ? { name: body.name } : {}), ...(body.filters !== undefined ? { filters: body.filters } : {}) } : f))
              : data.filter((f) => f.id !== id);
        queryClient.setQueryData(listKey, { ...previous, data: next });
      }
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(listKey, context.previous);
    },
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};
