import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";

const fetchPackages = async () => {
  const { data, error } = await supabase.from("Packages").select("*");
  if (error) throw new Error(error.message);
  return data;
};

export const usePackages = () => {
  return useQuery({
    queryKey: ["Packages"],
    queryFn: fetchPackages,
    staleTime: 1000 * 60 * 5, // optional: 5 min cache
  });
};
