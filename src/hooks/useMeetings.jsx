import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";

const fetchMeetings = async (startDate, endDate) => {
  const { data, error } = await supabase
    .from("Meetings")
    .select("*")
    .gte("start_date", startDate.toISOString())
    .lte("start_date", endDate.toISOString());
  if (error) throw new Error(error.message);
  return data;
};

export const useMeetings = (startDate, endDate) => {
  return useQuery({
    queryKey: ["Meetings", startDate, endDate],
    queryFn: () => fetchMeetings(startDate, endDate),
    staleTime: 1000 * 60 * 5, // optional: 5 min cache
    enabled: !!startDate && !!endDate,
  });
};
