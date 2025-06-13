import { fetchNCKPI } from "@/api/supabaseApi";
import { useQuery } from "@tanstack/react-query";

export const useNCKPI = (startDate, endDate, ncType) => {
  return useQuery({
    queryKey: ["NCKPI", startDate, endDate, ncType],
    queryFn: () => fetchNCKPI({ startDate, endDate, ncType }),
    staleTime: 1000 * 60 * 5, // optional: 5 min cache
    enabled: !!startDate && !!endDate && !!ncType, // only run if both are provided
  });
};
