import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";

export function useJobs(startDate, endDate) {
  console.log("useJobs called with:", startDate, endDate);

  return useQuery({
    queryKey: ["jobs", startDate, endDate],
    queryFn: async () => {
      if (!startDate || !endDate) return [];

      // 1. Fetch bookings in range (by departure date) with property details
      const { data: bookings, error } = await supabase
        .from("Bookings")
        .select(
          `
          id,
          property_id,
          arrival_date,
          departure_date,
          Properties (
            id,
            name,
            line_1,
            line_2,
            town,
            postcode,
            county,
            check_in,
            check_out,
            service_type,
            hired_laundry
          )
        `
        )
        .gte("departure_date", startDate.toISOString())
        .lte("departure_date", endDate.toISOString())
        .order("departure_date", { ascending: true });

      if (error) throw error;
      if (!bookings?.length) return [];

      // 2. Fetch all bookings once for lookup efficiency
      const { data: allBookings, error: allErr } = await supabase
        .from("Bookings")
        .select(
          "id, property_id, arrival_date, departure_date, is_return_guest, is_owner_booking, adults, children, infants, pets, cots, highchairs, stairgates"
        )
        .order("arrival_date", { ascending: true });

      if (allErr) throw allErr;

      // 3. Extract unique property IDs
      const propertyIds = [...new Set(bookings.map((b) => b.property_id))];

      // 4. Fetch all key codes for these properties
      const { data: keyCodes, error: keyErr } = await supabase
        .from("KeyCodes")
        .select("property_id, code, name")
        .eq("is_private", false)
        .in("property_id", propertyIds);

      if (keyErr) throw keyErr;

      // 5. Build jobs array with next booking + property details + key codes
      const jobs = bookings.map((booking) => {
        const nextBooking = allBookings.find(
          (b) =>
            b.property_id === booking.property_id &&
            new Date(b.arrival_date) >= new Date(booking.departure_date)
        );

        const propertyKeyCodes = keyCodes
          ?.filter((k) => k.property_id === booking.property_id)
          ?.map((k) => ({
            code: k.code,
            description: k.description,
          }));

        return {
          jobId: booking.id,
          propertyId: booking.property_id,
          propertyDetails: booking.Properties ?? null,
          jobDate: booking.departure_date,
          nextArrival: nextBooking ? nextBooking.arrival_date : null,
          keyCodes: propertyKeyCodes ?? [],
          bookingDetails: nextBooking || null,
        };
      });

      console.log("Fetched jobs:", jobs);
      return jobs;
    },
  });
}
