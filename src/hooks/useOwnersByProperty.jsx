import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";

const fetchOwnersByProperty = async (propertyId) => {
  const { data, error } = await supabase
    .from("PropertyOwner")
    .select(
      `
      *,
      owner:Owners(*)
    `
    )
    .eq("property_id", propertyId)
    .eq("is_active", true);
  if (error) throw new Error(error.message);
  return data;
};

export const useOwnersByProperty = (propertyId) => {
  return useQuery({
    queryKey: ["PropertyOwner", propertyId],
    queryFn: () => fetchOwnersByProperty(propertyId),
    staleTime: 1000 * 60 * 5, // optional: 5 min cache
    enabled: !!propertyId,
  });
};
