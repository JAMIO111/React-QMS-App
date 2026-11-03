import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";

const fetchLeadsById = async (leadId) => {
  const { data, error } = await supabase
    .from("Leads")
    .select(
      `
    *,
    Meetings(
      *,
      created_by:Employees!Meetings_created_by_fkey (
        id,
        first_name,
        surname,
        avatar
      )
    ),
    Correspondence(
      *,
      created_by:Employees!Correspondence_created_by_fkey (
        id,
        first_name,
        surname,
        avatar
      )
    )
  `
    )
    .eq("id", leadId)
    .single();

  if (error) throw new Error(error.message);

  return data;
};

export const useLeadById = (leadId) => {
  return useQuery({
    queryKey: ["Lead", leadId],
    queryFn: () => fetchLeadsById(leadId),
    staleTime: 1000 * 60 * 5, // optional: 5 min cache
    enabled: !!leadId,
  });
};
