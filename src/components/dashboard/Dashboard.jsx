import React, { useState, useMemo } from "react";
import CTAButton from "../CTAButton";
import DashboardCard from "./DashboardCard";
import { AiOutlinePound } from "react-icons/ai";
import { BiSolidBarChartAlt2 } from "react-icons/bi";
import { RxLapTimer } from "react-icons/rx";
import JobList from "@components/JobList";
import { useUser } from "@/contexts/UserProvider";
import { PiFilePlus } from "react-icons/pi";
import DateRangePicker from "@components/ui/DateRangePicker";
import { getGreeting } from "@/lib/HelperFunctions";

const Dashboard = () => {
  const { profile } = useUser();
  const [selectedCard, setSelectedCard] = useState(null);
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

  return (
    <div className="flex flex-col pb-4 h-full w-full bg-primary-bg">
      <div className="flex flex-col gap-2 xl:flex-row items-start  xl:items-center justify-between px-6 py-2 border-b border-border-color shrink-0 bg-primary-bg">
        <div className="flex flex-col">
          <h1 className="text-xl whitespace-nowrap text-primary-text">
            Bookings Dashboard
          </h1>
          <p className="text-sm text-secondary-text">
            {getGreeting()}, {profile?.first_name || "User"}!
          </p>
        </div>
        <div className="flex flex-col gap-2 md:flex-row items-center justify-between">
          <div className="w-full gap-3 md:w-fit flex items-center justify-start xl:justify-center">
            <CTAButton
              callbackFn={() => {
                navigate("/bookings/new-booking");
              }}
              type="main"
              text="Add Booking"
              icon={PiFilePlus}
            />
            <DateRangePicker
              width="w-80"
              onChange={setSelectedRange}
              defaultStartDate={start}
              defaultEndDate={today}
            />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-18 grid-rows-15 gap-4 px-4 mt-4 flex-grow">
        <div className="col-span-4 row-span-3 rounded-lg">
          <DashboardCard
            title="Cost of Poor Quality"
            icon={AiOutlinePound}
            value="£4,523.26"
            trend={26}
            color="fuchsia"
            isSelected={selectedCard === "COPQ"}
            onClick={() =>
              setSelectedCard(selectedCard === "COPQ" ? null : "COPQ")
            }
          />
        </div>
        <div className="col-span-4 row-span-3 rounded-2xl">
          <DashboardCard
            title="On Time Delivery"
            icon={RxLapTimer}
            value="95.4%"
            trend={5.2}
            color="orange"
            isSelected={selectedCard === "OTD"}
            onClick={() =>
              setSelectedCard(selectedCard === "OTD" ? null : "OTD")
            }
          />
        </div>
        <div className="col-span-4 row-span-3 rounded-2xl">
          <DashboardCard
            title="Quality Defects"
            icon={BiSolidBarChartAlt2}
            value="134"
            trend={-10}
            color="cyan"
            isSelected={selectedCard === "QD"}
            onClick={() => setSelectedCard(selectedCard === "QD" ? null : "QD")}
          />
        </div>
        <div className="col-span-6 row-span-12">
          <JobList
            jobs={[
              {
                jobNo: 126,
                property: "Lyndhurst",
                jobDate: "Wed 23 Oct",
                moveIn: "Mon 30 Oct",
              },
              {
                jobNo: 845,
                property: "Oystercatcher",
                jobDate: "Fri 25 Oct",
                moveIn: "Tue 31 Oct",
              },
              {
                jobNo: 954,
                property: "Little Anchor",
                jobDate: "Mon 28 Oct",
                moveIn: "Mon 28 Oct",
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
