import { fetchNCKPI } from "@/api/supabaseApi";
import { useQuery } from "@tanstack/react-query";
import { useOrganisation } from "@/contexts/OrganisationProvider";

export const useNCKPI = (startDate, endDate, ncType) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: ["NCKPI", organisationId, startDate, endDate, ncType],
    queryFn: () => fetchNCKPI({ organisationId, startDate, endDate, ncType }),
    staleTime: 1000 * 60 * 5,
    enabled: !!organisationId && !!startDate && !!endDate && !!ncType,
  });
};
