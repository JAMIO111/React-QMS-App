import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";

const fetchProperties = async () => {
  const { data, error } = await supabase
    .from("Properties")
    .select(
      `
      *,
      KeyCodes(*),
      Packages(*)
    `
    )
    .eq("is_active", true);
  if (error) throw new Error(error.message);
  return data;
};

export const useProperties = () => {
  return useQuery({
    queryKey: ["Properties"],
    queryFn: () => fetchProperties(),
    staleTime: 1000 * 60 * 5, // optional: 5 min cache
    enabled: true,
  });
};
