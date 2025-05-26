import { createContext, useContext, useEffect, useState } from "react";
import supabase from "../supabase-client";
import { useAuth } from "./AuthProvider";

const UserContext = createContext(null);

export const UserProvider = ({ children }) => {
  const { user: authUser } = useAuth();
  const [profile, setProfile] = useState(undefined); // undefined = loading

  useEffect(() => {
    console.log("Auth user:", authUser);
    if (!authUser) {
      setProfile(null);
      return;
    }

    const fetchProfile = async () => {
      const { data, error } = await supabase
        .from("Employees")
        .select("first_name, surname, job_title, avatar")
        .eq("auth_id", authUser.id)
        .maybeSingle();

      if (error) {
        console.error("Error fetching profile", error);
        setProfile(null);
      } else {
        setProfile(data);
        console.log("Fetched profile:", data);
      }
    };

    fetchProfile();
  }, [authUser]);

  return (
    <UserContext.Provider value={{ profile, setProfile }}>
      {children}
    </UserContext.Provider>
  );
};

export const useUser = () => useContext(UserContext);
