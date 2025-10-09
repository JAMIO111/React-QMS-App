import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";
import { useBookingsFilters } from "./useBookingsFilters";

export const useBookings = ({
  sortColumn = "arrival_date",
  sortOrder = "desc",
  page = 1,
  pageSize = 50,
}) => {
  const { search, leadGuest, bookingRef } = useBookingsFilters();

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
      {
        search,
        sortColumn,
        sortOrder,
        page,
        pageSize,
      },
    ],
    queryFn: async () => {
      let query = supabase.from("Bookings").select("*", { count: "exact" });
      query = query
        .order(sortColumn, { ascending: sortOrder === "asc" })
        .range(from, to);

      if (search) {
        query = query.or(
          `lead_guest.ilike.%${search}%,booking_ref.ilike.%${search}%`
        );
      }

      if (leadGuest) {
        query = query.eq("lead_guest", leadGuest);
      }
      if (bookingRef) {
        query = query.eq("booking_ref", bookingRef);
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
