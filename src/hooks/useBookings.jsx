import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";
import { useBookingsFilters } from "./useBookingsFilters";

export const useBookings = ({
  sortColumn = "departure_date",
  sortOrder = "desc",
  page = 1,
  pageSize = 50,
  startDate,
  endDate,
}) => {
  const { search, leadGuest, bookingRef, property, managementPackage, type } =
    useBookingsFilters();

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  console.log("Query params:", {
    search,
    leadGuest,
    bookingRef,
    sortColumn,
    sortOrder,
    from,
    to,
  });

  return useQuery({
    queryKey: [
      leadGuest,
      bookingRef,
      property,
      managementPackage,
      type,
      {
        search,
        sortColumn,
        sortOrder,
        page,
        pageSize,
        startDate,
        endDate,
      },
    ],
    queryFn: async () => {
      let query = supabase.from("v_bookings").select("*", { count: "exact" });
      query = query
        .order(sortColumn, { ascending: sortOrder === "asc" })
        .range(from, to)
        .gte("departure_date", startDate.toISOString())
        .lte("departure_date", endDate.toISOString());

      if (search) {
        query = query.or(
          `lead_guest.ilike.%${search}%,booking_ref.ilike.%${search}%,property_name.ilike.%${search}%`
        );
      }

      if (leadGuest) {
        query = query.eq("lead_guest", leadGuest);
      }
      if (bookingRef) {
        query = query.eq("booking_ref", bookingRef);
      }
      if (property) {
        query = query.eq("property_name", property);
      }
      if (managementPackage) {
        query = query.eq("package_id", managementPackage);
      }
      if (type) {
        query = query.eq("type", type);
      }

      const { data, count, error } = await query;

      if (error) {
        throw new Error(error.message);
      }
      console.log(`Fetched data:`, data);
      return { data, count };
    },
    staleTime: 1000 * 60 * 5,
  });
};
