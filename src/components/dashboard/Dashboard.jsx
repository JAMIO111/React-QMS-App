import { useState, useEffect, useMemo } from "react";
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
import { CgClose } from "react-icons/cg";
import JobSheetPrintModal from "../JobSheetPrintModal";

const Dashboard = () => {
  const { profile } = useUser();
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
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

  console.log("Booking Volume Data:", data);

  useEffect(() => {
    if (profile) {
      const s = new Date(today);
      s.setDate(today.getDate() - (profile.dashboard_range ?? 7));
      setSelectedRange({ startDate: s, endDate: today });
    }
  }, [profile, today]);

  return (
    <div className="h-full w-full">
      {previewModalOpen && (
        <div
          onClick={() => setPreviewModalOpen(false)}
          className="fixed inset-0 bg-black/50 bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-primary-bg h-[95vh] shadow-l rounded-2xl p-3 border border-border-color relative w-fit overflow-hidden min-w-[300px]">
            <div className="flex justify-between select-none pb-2 border-b border-border-color items-center text-primary-text rounded-t-xl">
              <h3 className="text-lg pl-2 select-none text-primary-text font-semibold">
                {`Job Sheet Preview`}
              </h3>
              <button
                onClick={() => setPreviewModalOpen(false)}
                className="group flex justify-center items-center p-1.5 cursor-pointer transition-colors duration-300 hover:text-error-color hover:bg-border-color/50 rounded-lg">
                <CgClose className="h-5 w-5 transition-colors duration-300 group-hover:text-error-color text-primary-text" />
              </button>
            </div>

            <div className="h-full overflow-y-auto p-2">
              <JobSheetPrintModal
                startDate={memoisedRange.startDate}
                endDate={memoisedRange.endDate}
                jobs={jobs}
              />
            </div>
          </div>
        </div>
      )}
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
                callbackFn={() => setPreviewModalOpen(true)}
                type="main"
                text="Preview Job Sheets"
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
            <JobList
              jobs={jobs}
              isLoading={isLoading}
              error={error}
              openModal={() => setPreviewModalOpen(true)}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
