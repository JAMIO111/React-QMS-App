import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";

export function useJobs(startDate, endDate) {
  console.log("useJobs called with:", startDate, endDate);
  return useQuery({
    queryKey: ["jobs", startDate, endDate],
    queryFn: async () => {
      if (!startDate || !endDate) return [];

      // 1. Fetch all bookings in date range by departure date
      const { data: bookings, error } = await supabase
        .from("Bookings")
        .select(
          'id, property_id, "Properties"(name), arrival_date, departure_date'
        )
        .gte("departure_date", startDate.toISOString())
        .lte("departure_date", endDate.toISOString())
        .order("departure_date", { ascending: true });

      if (error) throw error;
      if (!bookings?.length) return [];

      // 2. Fetch all bookings once for lookup efficiency
      const { data: allBookings, error: allErr } = await supabase
        .from("Bookings")
        .select("id, property_id, arrival_date, departure_date")
        .order("arrival_date", { ascending: true });

      if (allErr) throw allErr;

      // 3. For each booking in range, find its next sequential booking for that property
      const jobs = bookings.map((booking) => {
        const nextBooking = allBookings.find(
          (b) =>
            b.property_id === booking.property_id &&
            new Date(b.arrival_date) >= new Date(booking.departure_date)
        );

        return {
          jobId: booking.id,
          propertyId: booking.property_id,
          propertyName: booking.Properties?.name ?? "Unknown",
          jobDate: booking.departure_date,
          moveIn: nextBooking ? nextBooking.arrival_date : null,
        };
      });

      console.log("Errors:", error);
      console.log("Fetched jobs:", jobs);
      return jobs;
    },
  });
}
