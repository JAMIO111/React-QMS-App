import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";

const fetchPropertiesById = async (propertyId) => {
  const { data, error } = await supabase
    .from("Properties")
    .select(
      `
      *,
      KeyCodes(*),
      Packages(*),
      PropertyOwner(
        Owners(avatar, first_name, id, surname, primary_phone, primary_email)
      )
    `
    )
    .eq("id", propertyId)
    .single();

  if (error) throw new Error(error.message);

  // Flatten out the join for convenience:
  const owners = data.PropertyOwner?.map((po) => po.Owners) || [];

  return { ...data, Owners: owners };
};

export const usePropertyById = (propertyId) => {
  return useQuery({
    queryKey: ["Property", propertyId],
    queryFn: () => fetchPropertiesById(propertyId),
    staleTime: 1000 * 60 * 5, // optional: 5 min cache
    enabled: !!propertyId,
  });
};
