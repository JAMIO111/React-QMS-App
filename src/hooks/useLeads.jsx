import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";

const fetchLeads = async () => {
  const { data, error } = await supabase.from("Leads").select(
    `
      *
    `
  );
  if (error) throw new Error(error.message);
  return data;
};

export const useLeads = () => {
  return useQuery({
    queryKey: ["Leads"],
    queryFn: () => fetchLeads(),
    staleTime: 1000 * 60 * 5, // optional: 5 min cache
    enabled: true,
  });
};
