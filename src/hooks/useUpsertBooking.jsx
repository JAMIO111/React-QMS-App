import { useMutation, useQueryClient } from "@tanstack/react-query";
import supabase from "../supabase-client";

export const useUpsertBooking = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (bookingData) => {
      const { property_id, arrival_date, departure_date, id } = bookingData;

      if (!property_id || !arrival_date || !departure_date) {
        throw new Error("Property and valid booking dates are required.");
      }

      // Build base query
      let query = supabase
        .from("Bookings")
        .select("id, arrival_date, departure_date, booking_ref")
        .eq("property_id", property_id);

      // Only exclude current booking if updating
      if (id) {
        query = query.neq("id", id);
      }

      const { data: existingBookings, error: fetchError } = await query;
      if (fetchError) throw fetchError;

      // Check for overlap
      const newStart = new Date(arrival_date);
      const newEnd = new Date(departure_date);

      const overlappingBooking = existingBookings?.find((b) => {
        const start = new Date(b.arrival_date);
        const end = new Date(b.departure_date);
        return newStart < end && newEnd > start;
      });

      if (overlappingBooking) {
        const formatDate = (date) =>
          new Date(date).toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          });

        const formattedStart = formatDate(overlappingBooking.arrival_date);
        const formattedEnd = formatDate(overlappingBooking.departure_date);

        const error = new Error(
          `Booking conflict with reference ${
            overlappingBooking.booking_ref || overlappingBooking.id
          }. Existing booking runs from ${formattedStart} to ${formattedEnd}.`
        );
        error.code = "OVERLAP";
        error.details = overlappingBooking;
        throw error;
      }

      // Upsert logic
      const { data, error } = id
        ? await supabase
            .from("Bookings")
            .update(bookingData)
            .eq("id", id)
            .select()
            .single()
        : await supabase.from("Bookings").insert(bookingData).select().single();

      if (error) throw error;
      return data;
    },

    onSuccess: (data) => {
      const bookingId = data?.id;
      queryClient.invalidateQueries(["Bookings"]);
      if (bookingId) queryClient.invalidateQueries(["Booking", bookingId]);
    },
  });
};
