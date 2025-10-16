import supabase from "../supabase-client";
import { useQuery } from "@tanstack/react-query";
import { useUser } from "../contexts/UserProvider";

export const useNotifications = () => {
  const { profile } = useUser();

  const fetchNotifications = async () => {
    if (!profile?.auth_id) return [];
    const { data, error } = await supabase.rpc("get_user_notifications", {
      user_id: profile.auth_id,
    });
    if (error) {
      console.error("RPC Error:", error);
      throw new Error(error.message);
    }
    return data || [];
  };

  return useQuery({
    queryKey: ["Notifications", profile?.auth_id],
    queryFn: fetchNotifications,
    enabled: !!profile?.auth_id,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
};
