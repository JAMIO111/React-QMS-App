import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";
import { useNCMFilters } from "./useNCMFilters";

export const useNCM = ({
  sortColumn = "created_at",
  sortOrder = "desc",
  page = 1,
  pageSize = 50,
}) => {
  const { search, status, failureMode } = useNCMFilters();

  console.log("Filters:", { search, status, failureMode });

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  return useQuery({
    queryKey: [
      "Internal-NC",
      { search, status, failureMode, sortColumn, sortOrder, page, pageSize },
    ],
    queryFn: async () => {
      let query = supabase
        .from("v_ncm_details")
        .select("*", { count: "exact" })
        .order(sortColumn, { ascending: sortOrder === "asc" })
        .range(from, to);

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

      const { data, count, error } = await query;

      if (error) {
        throw new Error(error.message);
      }
      console.log("Fetched NCM data:", data);
      return { data, count };
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
};
