import { fetchNCDateTrend } from "@/api/supabaseApi";
import { useQuery } from "@tanstack/react-query";

export const useNCDateTrend = (startDate, endDate, overridePeriod, ncType) => {
  return useQuery({
    queryKey: ["NCDateTrend", startDate, endDate, overridePeriod, ncType],
    queryFn: () =>
      fetchNCDateTrend({ startDate, endDate, overridePeriod, ncType }),
    staleTime: 1000 * 60 * 5, // optional: 5 min cache
    enabled: !!startDate && !!endDate, // only run if both are provided
  });
};
