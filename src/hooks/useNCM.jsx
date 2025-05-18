import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";
import { useNCMFilters } from "./useNCMFilters";

export const useNCM = ({ sortColumn = "created_at", sortOrder = "desc" }) => {
  const { search, status, failureMode } = useNCMFilters();
  console.log("Filters:", { search, status, failureMode });
  return useQuery({
    queryKey: [
      "Internal-NC",
      { search, status, failureMode, sortColumn, sortOrder },
    ],
    queryFn: async () => {
      let query = supabase
        .from("v_ncm_details")
        .select("*")
        .order(sortColumn, { ascending: sortOrder === "asc" });

      if (search) {
        query = query.or(
          `ncm_id.ilike.%${search}%, claim_ref.ilike.%${search}%, part_number.ilike.%${search}%, description.ilike.%${search}%, work_order.ilike.%${search}%, customer_name.ilike.%${search}%, failure_mode_name.ilike.%${search}%, status_name.ilike.%${search}%`
        );
      }

      if (status) {
        query = query.eq("status_name", status);
      }
      if (failureMode) {
        query = query.eq("failure_mode_name", failureMode);
      }

      const { data, error } = await query;

      if (error) {
        throw new Error(error.message);
      }
      console.log("Fetched NCM data:", data);
      return data;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
};
