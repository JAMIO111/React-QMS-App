import supabase from "../supabase-client";
import { useQuery } from "@tanstack/react-query";
import { useUser } from "../contexts/UserProvider";
import { useOrganisation } from "../contexts/OrganisationProvider";

// The signed-in user's notifications for the current organisation.
export const useNotifications = () => {
  const { profile } = useUser();
  const { organisationId } = useOrganisation();

  return useQuery({
    queryKey: ["Notifications", profile?.id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_user_notifications");
      if (error) throw new Error(error.message);
      return data || [];
    },
    select: (rows) => rows.filter((n) => n.organisation_id === organisationId),
    enabled: !!profile?.id && !!organisationId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
};
