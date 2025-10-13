import { useMutation, useQueryClient } from "@tanstack/react-query";
import supabase from "../supabase-client";

export const useUpsertBooking = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (bookingData) => {
      let bookingId = bookingData.id;
      let result;

      if (bookingId) {
        // Update existing booking
        const { data, error } = await supabase
          .from("Bookings")
          .update(bookingData)
          .eq("id", bookingId)
          .select()
          .single();

        if (error) throw error;
        result = data;
      } else {
        // Insert new booking
        const { data, error } = await supabase
          .from("Bookings")
          .insert(bookingData)
          .select()
          .single();

        if (error) throw error;
        bookingId = data.id;
        result = data;
      }

      return result;
    },

    onSuccess: () => {
      queryClient.invalidateQueries(["Bookings"]);
      queryClient.invalidateQueries(["Booking", bookingId]);
    },
  });
};
