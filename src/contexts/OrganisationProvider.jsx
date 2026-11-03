import { createContext, useContext, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";
import { useAuth } from "./AuthProvider";

const OrganisationContext = createContext();

const STORAGE_KEY = "qms.currentOrganisationId";

const readStoredOrgId = () => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

const storeOrgId = (id) => {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Browser storage unavailable: the choice just isn't remembered.
  }
};

const fetchMemberships = async (userId) => {
  const { data, error } = await supabase
    .from("organisation_users")
    .select(
      "id, status, organisation:organisations(id, name, slug, settings:organisation_settings(base_currency, vat_rate, ncr_reference_prefix))"
    )
    .eq("user_id", userId)
    .eq("status", "active");
  if (error) throw new Error(error.message);
  return (data ?? [])
    .filter((m) => m.organisation)
    .map((m) => {
      // One-to-one embed: PostgREST returns an object (or an array on older detection rules).
      const settings = Array.isArray(m.organisation.settings)
        ? m.organisation.settings[0]
        : m.organisation.settings;
      return {
        membershipId: m.id,
        id: m.organisation.id,
        name: m.organisation.name,
        slug: m.organisation.slug,
        base_currency: settings?.base_currency ?? "GBP",
        vat_rate: Number(settings?.vat_rate ?? 0.2),
        ncr_reference_prefix: settings?.ncr_reference_prefix ?? "NCM",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * Organisations the signed-in user is an active member of, and the one currently selected.
 * `organisation` is undefined while loading and null when the user has no membership.
 * Access is enforced by the database (RLS); the selection only decides which data is shown.
 */
export const OrganisationProvider = ({ children }) => {
  const { user } = useAuth();
  const [selectedId, setSelectedId] = useState(readStoredOrgId);

  const { data: organisations, isLoading, error } = useQuery({
    queryKey: ["memberships", user?.id],
    queryFn: () => fetchMemberships(user.id),
    enabled: !!user,
    staleTime: 1000 * 60 * 5,
  });

  const organisation = useMemo(() => {
    if (!user) return null;
    if (isLoading || !organisations) return error ? null : undefined;
    return organisations.find((o) => o.id === selectedId) ?? organisations[0] ?? null;
  }, [user, isLoading, organisations, error, selectedId]);

  const selectOrganisation = (id) => {
    setSelectedId(id);
    storeOrgId(id);
  };

  return (
    <OrganisationContext.Provider
      value={{
        organisation,
        organisationId: organisation?.id ?? null,
        organisations: organisations ?? [],
        selectOrganisation,
        error,
      }}>
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
