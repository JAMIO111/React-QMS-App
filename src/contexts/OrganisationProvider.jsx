import { createContext, useContext, useEffect, useState } from "react";
import supabase from "../supabase-client";
import { useUser } from "./UserProvider";

const OrganisationContext = createContext();

export const OrganisationProvider = ({ children }) => {
  const { profile } = useUser();
  const [organisation, setOrganisation] = useState(undefined); // undefined = loading

  useEffect(() => {
    if (!profile || !profile.organisation_id) {
      setOrganisation(null);
      return;
    }

    const fetchOrganisation = async () => {
      const { data, error } = await supabase
        .from("Organisations")
        .select("name, base_currency, vat_rate")
        .eq("id", profile.organisation_id)
        .maybeSingle();

      if (error) {
        console.error("Error fetching organisation", error);
        setOrganisation(null);
      } else {
        setOrganisation(data || null); // explicitly set null if no data
      }
    };

    fetchOrganisation();
  }, [profile]);

  return (
    <OrganisationContext.Provider value={{ organisation }}>
      {children}
    </OrganisationContext.Provider>
  );
};

export const useOrganisation = () => {
  const context = useContext(OrganisationContext);
  if (!context) {
    throw new Error(
      "useOrganisation must be used within an OrganisationProvider"
    );
  }
  return context;
};
