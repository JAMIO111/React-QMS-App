import React, { useState } from "react";
import CTAButton from "../CTAButton";
import DashboardCard from "./DashboardCard";
import { AiOutlinePound } from "react-icons/ai";
import { BiSolidBarChartAlt2 } from "react-icons/bi";
import { RxLapTimer } from "react-icons/rx";
import DashboardTable from "./DashboardTable";

const Dashboard = () => {
  const [selectedCard, setSelectedCard] = useState(null);
  return (
    <div className="flex flex-col px-4 pt-2 pb-4 h-full w-full bg-primary-bg">
      <div className="flex flex-row justify-between items-center px-2">
        <h1 className="text-primary-text text-xl font-semibold">
          Precision Hydraulic Cylinders Dashboard
        </h1>
        <div className="flex flex-row gap-2">
          <CTAButton type="neutral" text="Customer" />
          <CTAButton type="neutral" text="Date Range" />
        </div>
      </div>
      <div className="grid grid-cols-18 grid-rows-15 gap-4 mt-4 flex-grow px-2">
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
        <div className="col-span-6 row-span-9 rounded-lg bg-secondary-bg border border-border-color">
          <DashboardTable />
        </div>
        <div className="col-span-12 row-span-6 rounded-lg bg-secondary-bg border border-border-color">
          <div className="h-full"></div>
        </div>
        <div className="col-span-10 row-span-6 rounded-lg bg-secondary-bg"></div>
        <div className="col-span-8 row-span-6 rounded-lg bg-secondary-bg">
          Card 3
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
