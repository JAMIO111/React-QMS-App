import { useState, useMemo, useEffect } from "react";
import Top5List from "../Top5List";
import CustomAreaChart from "../charts/AreaChart";
import DateRangePicker from "../ui/DateRangePicker";
import { useUser } from "@/contexts/UserProvider";
import DashboardCard from "./DashboardCard";
import { AiOutlinePound } from "react-icons/ai";
import { LuFileX2 } from "react-icons/lu";
import { LuPackageX } from "react-icons/lu";
import SlidingSelector from "../ui/SlidingSelector";
import { useNCKPI } from "@/hooks/useNCKPI";
import { useNCDateTrend } from "@/hooks/useNCDateTrend";
import { useOrganisation } from "@/contexts/OrganisationProvider";
import StackedBarChart from "../charts/StackedBarChart";
import PieChart from "../charts/PieChart";
import { getPeriodLabel } from "@/lib/utils";

const MosaicTile = ({ children, className }) => (
  <div
    className={`bg-secondary-bg shadow-md border border-border-color rounded-2xl ${className}`}>
    {children}
  </div>
);

const NonConformanceDashboard = () => {
  const { profile } = useUser();
  const { organisation } = useOrganisation();
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

  const [ncType, setNcType] = useState("Internal"); // default to 'all' or any specific type

  const { data, error, isLoading } = useNCKPI(
    memoisedRange.startDate,
    memoisedRange.endDate,
    ncType
  );

  const [aggregation, setAggregation] = useState("month");

  const {
    data: dateTrendData,
    error: dateTrendError,
    isLoading: isDateTrendLoading,
  } = useNCDateTrend(
    memoisedRange.startDate,
    memoisedRange.endDate,
    aggregation,
    ncType
  );

  console.log("NC Dashboard Data:", data);
  console.log("Date Trend Data:", dateTrendData);
  console.log("Failure Mode Breakdown:", data?.failure_mode_breakdown);

  return (
    <div className="flex flex-col flex-grow overflow-hidden">
      <div className="flex flex-col gap-2 xl:flex-row items-start  xl:items-center justify-between px-6 py-2 border-b border-border-color shrink-0 bg-primary-bg">
        <div className="flex flex-col">
          <h1 className="text-xl whitespace-nowrap text-primary-text">
            Non-Conformance Dashboard
          </h1>
          <p className="text-sm text-secondary-text">
            Good morning, {profile?.first_name || "User"}!
          </p>
        </div>
        <div className="flex flex-col gap-2 md:flex-row w-full items-center justify-between">
          <div className="w-full flex items-center justify-start xl:justify-center">
            <SlidingSelector typeFilter={ncType} setTypeFilter={setNcType} />
          </div>
          <div className="w-full md:w-fit flex items-center justify-start xl:justify-center">
            <DateRangePicker
              onChange={setSelectedRange}
              defaultStartDate={start}
              defaultEndDate={today}
            />
          </div>
        </div>
      </div>
      <div className="p-4 grid gap-4 grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-4 auto-rows-[100px] bg-primary-bg overflow-y-auto scroll-smooth flex-grow">
        <MosaicTile className="col-span-1 md:col-span-2 row-span-1 xl:col-span-1 flex items-center justify-center">
          <DashboardCard
            title="Total NCs"
            value={data?.totals?.record_count || "0"}
            trend={data?.totals?.record_count_change_pct}
            isPositiveGood={false}
            icon={LuFileX2}
            isLoading={isLoading}
            previousPeriodLabel={getPeriodLabel(
              memoisedRange.startDate,
              memoisedRange.endDate,
              "previous"
            )}
            color="lime"
          />
        </MosaicTile>
        <MosaicTile className="col-span-1 md:col-span-2 row-span-1 xl:col-span-1 flex items-center justify-center">
          <DashboardCard
            title="Defective Units"
            value={data?.totals?.total_quantity || "0"}
            trend={data?.totals?.quantity_change_pct}
            isPositiveGood={false}
            icon={LuPackageX}
            isLoading={isLoading}
            previousPeriodLabel={getPeriodLabel(
              memoisedRange.startDate,
              memoisedRange.endDate,
              "previous"
            )}
            color="orange"
          />
        </MosaicTile>
        <MosaicTile className="col-span-1 md:col-span-2 row-span-1 xl:col-span-1 flex items-center justify-center">
          <DashboardCard
            title="Total Cost"
            value={data?.totals?.total_cost}
            trend={data?.totals?.cost_change_pct}
            isPositiveGood={false}
            currencyItem={true}
            icon={AiOutlinePound}
            isLoading={isLoading}
            previousPeriodLabel={getPeriodLabel(
              memoisedRange.startDate,
              memoisedRange.endDate,
              "previous"
            )}
            color="fuchsia"
          />
        </MosaicTile>
        <MosaicTile className="col-span-1 md:col-span-2 row-span-1 xl:col-span-1 flex items-center justify-center">
          <DashboardCard
            title="Defective Units"
            value="132"
            trend="12"
            isPositiveGood={false}
            icon={AiOutlinePound}
            isLoading={isLoading}
            previousPeriodLabel={getPeriodLabel(
              memoisedRange.startDate,
              memoisedRange.endDate,
              "previous"
            )}
            color="cyan"
          />
        </MosaicTile>
        <MosaicTile className="col-span-1 sm:col-span-2 md:col-span-4 xl:col-span-3 row-span-4">
          <CustomAreaChart
            chartData={dateTrendData}
            subtitle={`Quantity and Cost Trend for ${getPeriodLabel(
              memoisedRange.startDate,
              memoisedRange.endDate,
              "current"
            )}`}
            baseCurrency={organisation?.base_currency}
            startDate={memoisedRange.startDate}
            endDate={memoisedRange.endDate}
            aggregation={aggregation}
            setAggregation={setAggregation}
            ncType={ncType}
          />
        </MosaicTile>
        <MosaicTile className="row-span-4 lg:col-span-1 md:col-span-2 sm:col-span-1">
          <Top5List
            title="Total Defects"
            subtitle={`By ${ncType === "Supplier" ? "Supplier" : "Customer"}`}
            data={data}
            isLoading={isLoading}
            dataKey="top_entities"
            idKey="entity_id"
            nameKey="entity_name"
            valueKey="total_defects"
            logoKey="entity_logo"
            fallbackIconPrefix="fallback-position"
          />
        </MosaicTile>
        <MosaicTile className="row-span-4 col-span-1 md:col-span-2 lg:col-span-1 sm:col-span-1">
          <Top5List
            title="Total Defects"
            subtitle="By Causal Process"
            data={data}
            isLoading={isLoading}
            dataKey="top_causal_processes"
            idKey="process_id"
            nameKey="process_name"
            valueKey="total_defects"
            logoKey={null} // or omit
            fallbackIconPrefix="fallback-position"
          />
        </MosaicTile>
        <MosaicTile className="col-span-1 sm:col-span-2 md:col-span-4 xl:col-span-3 row-span-4">
          <StackedBarChart
            data={data?.failure_mode_breakdown}
            subtitle={`Failure mode breakdown for ${getPeriodLabel(
              memoisedRange.startDate,
              memoisedRange.endDate,
              "current"
            )}`}
          />
        </MosaicTile>
        <MosaicTile className="lg:max-xl:row-start-7 lg:max-xl:col-start-2 col-span-1 row-span-4 md:col-span-2 sm:col-span-1">
          <PieChart chartData={data?.top_parts} />
        </MosaicTile>
      </div>
    </div>
  );
};

export default NonConformanceDashboard;
