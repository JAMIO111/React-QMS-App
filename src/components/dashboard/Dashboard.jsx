import { useState, useMemo } from "react";
import CTAButton from "../CTAButton";
import JobList from "@components/JobList";
import { useUser } from "@/contexts/UserProvider";
import { PiFilePlus } from "react-icons/pi";
import DateRangePicker from "@components/ui/DateRangePicker";
import { getGreeting } from "@/lib/HelperFunctions";
import { useJobs } from "@/hooks/useJobs";
import StackedBarChart from "@components/charts/StackedBarChart";
import { useBookingVolume } from "@/hooks/useBookingVolume";
import { getPeriodLabel } from "@/lib/utils";
import { useModal } from "@/contexts/ModalContext";
import JobSheetPreview from "@components/JobSheetPreview";

const Dashboard = () => {
  const { profile } = useUser();
  const { openModal, closeModal } = useModal();
  const today = useMemo(() => new Date(), []);
  const start = useMemo(() => {
    const s = new Date(today);
    s.setDate(today.getDate() - (profile?.dashboard_range ?? 7));
    return s;
  }, [profile?.dashboard_range, today]);

  const [selectedRange, setSelectedRange] = useState({
    startDate: start,
    endDate: today,
  });

  const memoisedRange = useMemo(
    () => selectedRange,
    [selectedRange.startDate, selectedRange.endDate]
  );

  const {
    data: jobs,
    isLoading,
    error,
  } = useJobs(memoisedRange.startDate, memoisedRange.endDate);

  console.log("memoisedRange:", memoisedRange);

  const { data } = useBookingVolume(
    memoisedRange.startDate,
    memoisedRange.endDate
  );

  const openJobSheetModal = () => {
    openModal({
      title: "Job Sheets Preview",
      content: (
        <JobSheetPreview
          startDate={memoisedRange.startDate}
          endDate={memoisedRange.endDate}
        />
      ),
    });
  };

  console.log("Booking Volume Data:", data);

  return (
    <div className="flex flex-col h-full w-full bg-primary-bg">
      <div className="flex flex-col gap-2 xl:flex-row items-start xl:items-center justify-between px-6 py-1 shadow-sm border-b border-border-color shrink-0 bg-primary-bg">
        <div className="flex flex-col">
          <h1 className="text-xl whitespace-nowrap text-primary-text">
            Business Dashboard
          </h1>
          <p className="text-sm text-secondary-text">
            {getGreeting()}, {profile?.first_name || "User"}!
          </p>
        </div>
        <div className="flex flex-col gap-2 md:flex-row items-center justify-between">
          <div className="w-full gap-3 md:w-fit flex items-center justify-start xl:justify-center">
            <CTAButton
              callbackFn={openJobSheetModal}
              type="main"
              text="Add Booking"
              icon={PiFilePlus}
            />
            <DateRangePicker
              alignment="right"
              width="w-80"
              onChange={setSelectedRange}
              value={memoisedRange}
            />
          </div>
        </div>
      </div>
      <div className="flex gap-3 p-3 flex-grow overflow-hidden">
        <div className="flex flex-col gap-3 flex-6">
          <div className="flex gap-3 flex-1">
            <div className="flex-3">
              <StackedBarChart
                data={data}
                subtitle={`Changeovers for ${getPeriodLabel(
                  memoisedRange.startDate,
                  memoisedRange.endDate,
                  "current"
                )}`}
              />
            </div>
            <div className="flex-2">
              <StackedBarChart
                data={data}
                subtitle={`Changeovers for ${getPeriodLabel(
                  memoisedRange.startDate,
                  memoisedRange.endDate,
                  "current"
                )}`}
              />
            </div>
          </div>
          <div className="flex gap-3 flex-1">
            <div className="flex-2">
              <StackedBarChart
                data={data}
                subtitle={`Changeovers for ${getPeriodLabel(
                  memoisedRange.startDate,
                  memoisedRange.endDate,
                  "current"
                )}`}
              />
            </div>
            <div className="flex-3">
              <StackedBarChart
                data={data}
                subtitle={`Changeovers for ${getPeriodLabel(
                  memoisedRange.startDate,
                  memoisedRange.endDate,
                  "current"
                )}`}
              />
            </div>
          </div>
        </div>
        <div className="flex-4">
          <JobList jobs={jobs} isLoading={isLoading} error={error} />
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
