import { useMemo } from "react";
import { useJobs } from "@/hooks/useJobs";
import { useMeetings } from "@/hooks/useMeetings";

export const useCalendarItems = (startDate, endDate) => {
  const { data: jobs = [], isLoading: jobsLoading } = useJobs(
    startDate,
    endDate
  );
  const { data: meetings = [], isLoading: meetingsLoading } = useMeetings(
    startDate,
    endDate
  );

  console.log("Calendar Jobs:", jobs);
  console.log("Calendar Meetings:", meetings);

  const formatDateLocal = (d) =>
    `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d
      .getDate()
      .toString()
      .padStart(2, "0")}`;

  const groupedItems = useMemo(() => {
    const combined = [
      ...jobs.map((j) => ({ ...j, type: "job", date: new Date(j.jobDate) })),
      ...meetings.map((m) => ({
        ...m,
        type: "meeting",
        date: new Date(m.start_date),
      })),
    ];

    return combined.reduce((acc, item) => {
      const dateKey = formatDateLocal(item.date); // local date
      if (!acc[dateKey]) acc[dateKey] = [];
      acc[dateKey].push(item);
      return acc;
    }, {});
  }, [jobs, meetings]);

  return {
    data: groupedItems,
    isLoading: jobsLoading || meetingsLoading,
  };
};
