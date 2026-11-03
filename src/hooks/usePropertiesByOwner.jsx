import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";

const fetchPropertiesByOwner = async (ownerId) => {
  const { data, error } = await supabase
    .from("PropertyOwner")
    .select(
      `
      *,
      property:Properties(*)
    `
    )
    .eq("owner_id", ownerId)
    .eq("is_active", true);
  if (error) throw new Error(error.message);
  return data;
};

export const usePropertiesByOwner = (ownerId) => {
  return useQuery({
    queryKey: ["PropertyOwner", ownerId],
    queryFn: () => fetchPropertiesByOwner(ownerId),
    staleTime: 1000 * 60 * 5, // optional: 5 min cache
    enabled: !!ownerId,
  });
};
