import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";

const getMonthKey = (date) =>
  new Date(date).toLocaleString("default", { month: "short", year: "2-digit" });

// Generate all month keys between two dates
const generateMonthKeys = (start, end) => {
  const keys = [];
  const date = new Date(start.getFullYear(), start.getMonth(), 1);

  while (date <= end) {
    keys.push(getMonthKey(date));
    date.setMonth(date.getMonth() + 1);
  }

  return keys;
};

export const useBookingVolume = (startDate, endDate) => {
  return useQuery({
    queryKey: ["BookingVolume", startDate, endDate],
    queryFn: async () => {
      if (!startDate || !endDate) return [];

      const { data: bookings, error } = await supabase
        .from("Bookings")
        .select("id, departure_date")
        .gte("departure_date", startDate.toISOString())
        .lte("departure_date", endDate.toISOString());

      if (error) throw error;

      // Group bookings by month
      const grouped = bookings.reduce((acc, booking) => {
        const month = getMonthKey(booking.departure_date);
        if (!acc[month]) acc[month] = 0;
        acc[month]++;
        return acc;
      }, {});

      // Generate full month range
      const monthKeys = generateMonthKeys(startDate, endDate);

      // Map to array with bookings count (0 if none)
      const months = monthKeys.map((month) => ({
        month,
        bookings: grouped[month] || 0,
      }));

      return months;
    },
    enabled: !!startDate && !!endDate,
    staleTime: 5 * 60 * 1000,
  });
};
