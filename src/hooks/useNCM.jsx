import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";
import { useNCMFilters } from "./useNCMFilters";

export const useNCM = ({
  ncType = "Internal",
  sortColumn = "created_at",
  sortOrder = "desc",
  page = 1,
  pageSize = 50,
}) => {
  const { search, status, failureMode, subFailureMode, poNo } = useNCMFilters();

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const tableMap = {
    Internal: "v_ncm_internal",
    Customer: "v_ncm_customer",
    Supplier: "v_ncm_supplier",
  };

  const tableName = tableMap[ncType] || tableMap.Internal;

  return useQuery({
    queryKey: [
      ncType,
      {
        search,
        status,
        failureMode,
        subFailureMode,
        poNo,
        sortColumn,
        sortOrder,
        page,
        pageSize,
      },
    ],
    queryFn: async () => {
      let query = supabase.from(tableName).select("*", { count: "exact" });
      query = query
        .order(sortColumn, { ascending: sortOrder === "asc" })
        .range(from, to);

      if (search) {
        if (ncType === "Internal") {
          // For Internal NCM, search includes customer_display_name & customer_name
          query = query.or(
            `ncm_id.ilike.%${search}%, part_number.ilike.%${search}%, description.ilike.%${search}%, work_order.ilike.%${search}%, customer_display_name.ilike.%${search}%, customer_name.ilike.%${search}%, failure_mode_name.ilike.%${search}%, status_name.ilike.%${search}%`
          );
        } else if (ncType === "Supplier") {
          // For SNC, search includes supplier_display_name instead of customer_display_name & customer_name
          query = query.or(
            `ncm_id.ilike.%${search}%, part_number.ilike.%${search}%, description.ilike.%${search}%, purchase_order.ilike.%${search}%, supplier_display_name.ilike.%${search}%, supplier_name.ilike.%${search}%, failure_mode_name.ilike.%${search}%, status_name.ilike.%${search}%`
          );
        } else if (ncType === "Customer") {
          query = query.or(
            `ncm_id.ilike.%${search}%, claim_ref.ilike.%${search}%, part_number.ilike.%${search}%, description.ilike.%${search}%, work_order.ilike.%${search}%, customer_display_name.ilike.%${search}%, customer_name.ilike.%${search}%, failure_mode_name.ilike.%${search}%, status_name.ilike.%${search}%`
          );
        }
      }

      if (status) {
        query = query.eq("status_name", status);
      }
      if (failureMode) {
        query = query.eq("failure_mode_name", failureMode);
      }
      if (subFailureMode) {
        query = query.eq("sub_failure_mode_name", subFailureMode);
      }
      if (poNo) {
        query = query.eq("po_no", poNo);
      }

      const { data, count, error } = await query;

      if (error) {
        throw new Error(error.message);
      }
      console.log(`Fetched ${ncType} data:`, data);
      return { data, count };
    },
    staleTime: 1000 * 60 * 5,
  });
};
