import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";

const fetchOwnersById = async (ownerId) => {
  const { data, error } = await supabase
    .from("Owners")
    .select("*")
    .eq("id", ownerId)
    .single();
  if (error) throw new Error(error.message);
  return data;
};

export const useOwnerById = (ownerId) => {
  return useQuery({
    queryKey: ["Owner", ownerId],
    queryFn: () => fetchOwnersById(ownerId),
    staleTime: 1000 * 60 * 5, // optional: 5 min cache
    enabled: !!ownerId,
  });
};
