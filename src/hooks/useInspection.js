import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { usePagedList } from "./useMasterData";

/** In-process inspections (PC4). Query keys under ["api", "org", id, "master", …] via usePagedList, and "inspection". */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "inspection", ...rest];

export const useInspections = ({ q = "", status, result, partId } = {}) => usePagedList("inspections", { q, status, result, partId });

export const useInspection = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, id),
    queryFn: () => apiFetch(`/inspections/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** `request` is { path, method, body }; the response (an inspection) replaces the cached detail. */
export const useInspectionMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, method = "POST", body }) => apiFetch(path, { method, body, organisationId }),
    onSuccess: (data) => {
      if (data?.id) queryClient.setQueryData(key(organisationId, data.id), data);
      queryClient.invalidateQueries({ queryKey: ["api", "org", organisationId, "master", "inspections"] });
    },
  });
};
