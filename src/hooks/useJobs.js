import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

/** Operator jobs (docs/operator-hub-plan.md): a job is an in-progress inspection record, so detail and cache live under the "inspection" key. */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "inspection", "jobs", ...rest];

/** What starting a job on this machine with this part would do: site, operation, what must still be asked, what blocks it. */
export const useJobPreview = ({ machineId, partId, operationCode }) => {
  const { organisationId } = useOrganisation();
  const qs = new URLSearchParams({ machineId: machineId ?? "", partId: partId ?? "", ...(operationCode ? { operationCode } : {}) });
  return useQuery({
    queryKey: key(organisationId, "preview", machineId, partId, operationCode ?? ""),
    queryFn: () => apiFetch(`/jobs/preview?${qs}`, { organisationId }),
    enabled: !!organisationId && !!machineId && !!partId,
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

/** Start a job ({ machineId, partId, operationCode?, lotSize? }) or fill in its details ({ id, workOrder, lot, lotSize, serial }); both answer with the inspection. */
export const useJobMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }) => (id ? apiFetch(`/jobs/${id}`, { method: "PATCH", body, organisationId }) : apiFetch("/jobs", { method: "POST", body, organisationId })),
    onSuccess: (inspection) => {
      if (inspection?.id) queryClient.setQueryData(["api", "org", organisationId, "inspection", inspection.id], inspection);
      refreshOrganisation(queryClient, organisationId);
    },
  });
};
