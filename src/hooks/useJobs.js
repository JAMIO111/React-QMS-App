import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

/** Operator jobs (docs/operator-hub-plan.md): a job is an in-progress inspection record, so detail and cache live under the "inspection" key. */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "inspection", "jobs", ...rest];

/** What starting a job with this part (and, once chosen, this machine) would do: the control plan, its operations, the site, what must still be asked, what blocks it. */
export const useJobPreview = ({ machineId, partId, operationCode }) => {
  const { organisationId } = useOrganisation();
  const qs = new URLSearchParams({ partId: partId ?? "", ...(machineId ? { machineId } : {}), ...(operationCode ? { operationCode } : {}) });
  return useQuery({
    queryKey: key(organisationId, "preview", machineId ?? "", partId, operationCode ?? ""),
    queryFn: () => apiFetch(`/jobs/preview?${qs}`, { organisationId }),
    enabled: !!organisationId && !!partId,
    retry: false,
    placeholderData: keepPreviousData,
    staleTime: 0,
  });
};

/** The signed-in person's running jobs, newest first: { data, total }. */
export const useMyJobs = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "mine"),
    queryFn: () => apiFetch("/jobs/mine", { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

const FIELDS = ["workOrder", "lot", "lotSize", "serial"];

/**
 * Start a job ({ machineId, partId, operationCode?, lotSize? }) or fill in its details ({ id, workOrder, lot, lotSize, serial }); both answer with the
 * inspection. Details are a quick edit, so they show on screen at once and are put back if the save fails.
 */
export const useJobMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const detail = (id) => ["api", "org", organisationId, "inspection", id];
  return useMutation({
    mutationFn: ({ id, ...body }) => (id ? apiFetch(`/jobs/${id}`, { method: "PATCH", body, organisationId }) : apiFetch("/jobs", { method: "POST", body, organisationId })),
    onMutate: async ({ id, ...body }) => {
      if (!id) return undefined;
      await queryClient.cancelQueries({ queryKey: detail(id) });
      const previous = queryClient.getQueryData(detail(id));
      if (previous) queryClient.setQueryData(detail(id), { ...previous, ...Object.fromEntries(FIELDS.filter((f) => f in body).map((f) => [f, body[f] === "" ? null : body[f]])) });
      return { previous, id };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(detail(context.id), context.previous);
    },
    onSuccess: (inspection) => {
      if (inspection?.id) queryClient.setQueryData(detail(inspection.id), inspection);
    },
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};
