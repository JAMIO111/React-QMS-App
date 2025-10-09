import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";

const fetchOwners = async () => {
  const { data, error } = await supabase.from("Owners").select("*");
  if (error) throw new Error(error.message);
  return data;
};

export const useOwners = () => {
  return useQuery({
    queryKey: ["Owners"],
    queryFn: () => fetchOwners(),
    staleTime: 1000 * 60 * 5, // optional: 5 min cache
    enabled: true,
  });
};
