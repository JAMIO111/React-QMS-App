import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";

const fetchPropertiesById = async (propertyId) => {
  const { data, error } = await supabase
    .from("Properties")
    .select("*, KeyCodes(*), Packages(*)")
    .eq("id", propertyId)
    .single();
  if (error) throw new Error(error.message);
  return data;
};

export const usePropertyById = (propertyId) => {
  return useQuery({
    queryKey: ["Property", propertyId],
    queryFn: () => fetchPropertiesById(propertyId),
    staleTime: 1000 * 60 * 5, // optional: 5 min cache
    enabled: !!propertyId,
  });
};
