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
      localStorage.removeItem("user_profile");
      return;
    }

    const cached = localStorage.getItem("user_profile");
    if (cached) {
      setProfile(JSON.parse(cached));
      return;
    }

    const fetchProfile = async () => {
      const { data, error } = await supabase
        .from("Employees")
        .select("first_name, surname, job_title, avatar, id, auth_id")
        .eq("auth_id", authUser.id)
        .maybeSingle();

      if (error) {
        console.error("Error fetching profile", error);
        setProfile(null);
      } else {
        setProfile(data);
        localStorage.setItem("user_profile", JSON.stringify(data));
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
