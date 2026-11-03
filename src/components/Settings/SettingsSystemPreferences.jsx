import React from "react";
import JobSheet from "../JobSheet";
import { useBookingById } from "@/hooks/useBookingById";

const SettingsSystemPreferences = () => {
  const { data: booking } = useBookingById(
    "0f6f3501-cc77-48cb-8d00-bf5e90def6c9"
  );

  return <JobSheet job={booking} />;
};

export default SettingsSystemPreferences;
