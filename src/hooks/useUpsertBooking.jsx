import { useMutation, useQueryClient } from "@tanstack/react-query";
import supabase from "../supabase-client";

export const useUpsertBooking = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (bookingData) => {
      if (bookingData.id) {
        // Update existing booking
        const { data, error } = await supabase
          .from("Bookings")
          .update(bookingData)
          .eq("id", bookingData.id)
          .select()
          .single();

        if (error) throw error;
        return data;
      } else {
        // Insert new booking
        const { data, error } = await supabase
          .from("Bookings")
          .insert(bookingData)
          .select()
          .single();

        if (error) throw error;
        return data;
      }
    },

    onSuccess: (data) => {
      const bookingId = data?.id;
      queryClient.invalidateQueries(["Bookings"]);
      if (bookingId) {
        queryClient.invalidateQueries(["Booking", bookingId]);
      }
    },
  });
};
