import { createContext, useContext } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import supabase from "../supabase-client";
import { useAuth } from "./AuthProvider";

const UserContext = createContext(null);

const fetchProfile = async (userId) => {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, first_name, surname, job_title, avatar_path")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
};

/**
 * The signed-in user's profile (public.profiles). `profile` is undefined while loading and
 * null when signed out. Always fetched from the server — never cached in browser storage.
 */
export const UserProvider = ({ children }) => {
  const { user: authUser } = useAuth();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["profile", authUser?.id],
    queryFn: () => fetchProfile(authUser.id),
    enabled: !!authUser,
    staleTime: 1000 * 60 * 5,
  });

  let profile;
  if (authUser === null) profile = null;
  else if (authUser === undefined || isLoading) profile = undefined;
  else profile = { ...(data ?? { id: authUser.id }), email: authUser.email };

  const refreshProfile = () =>
    queryClient.invalidateQueries({ queryKey: ["profile", authUser?.id] });

  return (
    <UserContext.Provider value={{ profile, refreshProfile }}>
      {children}
    </UserContext.Provider>
  );
};

export const useUser = () => useContext(UserContext);
