import { useState, useMemo, useEffect } from "react";
import Top5List from "../Top5List";
import CustomAreaChart from "../charts/AreaChart";
import currencyCodes from "@/currencyCodes";
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
import AggregationPeriodDropdown from "../ui/AggregationPeriodDropdown";

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

  const getAvailableAggregations = (startDate, endDate) => {
    const dayDiff = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
    const options = [];
    if (dayDiff <= 1) options.push("hour");
    if (dayDiff <= 30) options.push("day");
    if (dayDiff > 7) options.push("week");
    if (dayDiff > 30) options.push("month");
    if (dayDiff > 90) options.push("quarter");
    if (dayDiff > 365) options.push("year");

    return options;
  };

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

  useEffect(() => {
    const validOptions = getAvailableAggregations(
      memoisedRange.startDate,
      memoisedRange.endDate
    );

    if (!validOptions.includes(aggregation)) {
      // fallback to highest valid option (e.g., month or week)
      setAggregation(validOptions[validOptions.length - 1]);
    }
  }, [memoisedRange.startDate, memoisedRange.endDate]);

  console.log("NC Dashboard Data:", data);
  console.log("Date Trend Data:", dateTrendData);

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
            <AggregationPeriodDropdown
              startDate={memoisedRange.startDate}
              endDate={memoisedRange.endDate}
              value={aggregation}
              onChange={setAggregation}
              validOptions={getAvailableAggregations(
                memoisedRange.startDate,
                memoisedRange.endDate
              )}
            />
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
            color="cyan"
          />
        </MosaicTile>
        <MosaicTile className="col-span-1 sm:col-span-2 md:col-span-4 xl:col-span-3 row-span-4">
          <CustomAreaChart
            chartData={dateTrendData}
            base_currency={organisation?.base_currency}
          />
        </MosaicTile>
        <MosaicTile className="row-span-4 lg:col-span-1 md:col-span-2 sm:col-span-1">
          <Top5List title="Total Defects" data={data} isLoading={isLoading} />
        </MosaicTile>
        <MosaicTile className="row-span-4 col-span-1 md:col-span-2 lg:col-span-1 sm:col-span-1">
          <Top5List title="Total Defects" data={data} isLoading={isLoading} />
        </MosaicTile>
        <MosaicTile className="col-span-1 sm:col-span-2 md:col-span-4 xl:col-span-3 row-span-4">
          {/*<CustomAreaChart />*/}
        </MosaicTile>
      </div>
    </div>
  );
};

export default NonConformanceDashboard;
