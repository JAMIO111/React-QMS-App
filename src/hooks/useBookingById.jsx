import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";

const fetchBookingById = async (bookingId) => {
  const { data, error } = await supabase
    .from("Bookings")
    .select("*")
    .eq("id", bookingId)
    .single();
  if (error) throw new Error(error.message);
  return data;
};

export const useBookingById = (bookingId) => {
  return useQuery({
    queryKey: ["Booking", bookingId],
    queryFn: () => fetchBookingById(bookingId),
    staleTime: 1000 * 60 * 5, // optional: 5 min cache
    enabled: !!bookingId,
  });
};
