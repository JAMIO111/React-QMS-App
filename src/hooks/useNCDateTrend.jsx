import { fetchNCDateTrend } from "@/api/supabaseApi";
import { useQuery } from "@tanstack/react-query";
import { useOrganisation } from "@/contexts/OrganisationProvider";

export const useNCDateTrend = (startDate, endDate, overridePeriod, ncType) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: ["NCDateTrend", organisationId, startDate, endDate, overridePeriod, ncType],
    queryFn: () =>
      fetchNCDateTrend({ organisationId, startDate, endDate, overridePeriod, ncType }),
    staleTime: 1000 * 60 * 5,
    enabled: !!organisationId && !!startDate && !!endDate,
  });
};
