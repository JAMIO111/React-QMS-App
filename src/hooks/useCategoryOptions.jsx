import { useQuery } from "@tanstack/react-query";
import { fetchAllForOrganisation } from "../api/supabaseApi";
import { useOrganisation } from "../contexts/OrganisationProvider";

// Lookup lists for the current organisation.
const useOrganisationTable = (table) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: [table, organisationId],
    queryFn: () => fetchAllForOrganisation(table, organisationId),
    enabled: !!organisationId,
    staleTime: 1000 * 60 * 30, // 30 minutes
  });
};

export const useStatusOptions = () => useOrganisationTable("Status");
export const useFailureModeOptions = () => useOrganisationTable("Failure Mode");
export const useSubFailureModeOptions = () => useOrganisationTable("Sub-Failure Mode");
export const useProcessOptions = () => useOrganisationTable("Process");
export const useEmployeesOptions = () => useOrganisationTable("Employees");
