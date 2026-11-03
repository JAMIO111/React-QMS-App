import { useState, useEffect, useMemo } from "react";
import { useNCDateTrend } from "@/hooks/useNCDateTrend";
import AggregationPeriodDropdown from "../ui/AggregationPeriodDropdown";
import currencyCodes from "@/currencyCodes";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";

import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";

const chartConfig = {
  total_cost: {
    label: "Total Cost",
    color: "var(--chart-4)",
  },
  total_quantity: {
    label: "Defective Quantity",
    color: "var(--chart-3)",
  },
  record_count: {
    label: "No. of Records",
    color: "var(--chart-5)",
  },
};

export function CustomAreaChart({
  baseCurrency = "£",
  startDate,
  endDate,
  ncType,
  subtitle = "Defective Units Trend",
  aggregation = "day",
  setAggregation,
}) {
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

  useEffect(() => {
    const validOptions = getAvailableAggregations(startDate, endDate);
    if (!validOptions.includes(aggregation)) {
      setAggregation(validOptions[validOptions.length - 1]);
    }
  }, [startDate, endDate]);

  const { data: chartData } = useNCDateTrend(
    startDate,
    endDate,
    aggregation,
    ncType,
    subtitle
  );

  const currencyFormatter = useMemo(() => {
    const currency = currencyCodes[baseCurrency];
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: currency?.code || "GBP",
      minimumFractionDigits: currency?.decimal_digits || 2,
      maximumFractionDigits: currency?.decimal_digits || 2,
    }).format;
  }, [baseCurrency]);

  return (
    <Card className="h-full flex flex-col overflow-hidden">
      <CardHeader className="flex w-full justify-between flex-shrink-0 h-20 px-8">
        <div>
          <CardTitle className="text-primary-text text-lg">
            Defective Units
          </CardTitle>
          <CardDescription className="text-secondary-text">
            {subtitle}
          </CardDescription>
        </div>
        <div>
          <span>Group By</span>
          <AggregationPeriodDropdown
            startDate={startDate}
            endDate={endDate}
            value={aggregation}
            onChange={setAggregation}
            validOptions={getAvailableAggregations(startDate, endDate)}
          />
        </div>
      </CardHeader>

      <ChartContainer
        config={chartConfig}
        className="flex-grow min-h-0 px-6 pb-4">
        <AreaChart
          data={chartData}
          margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--color-border-color)" vertical={false} />
          <XAxis dataKey="label" />
          <YAxis orientation="left" yAxisId="left" />
          <YAxis orientation="right" yAxisId="right" />
          <ChartLegend config={chartConfig} content={<ChartLegendContent />} />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value, name) =>
                  name === "Total Cost"
                    ? currencyFormatter(value)
                    : value.toLocaleString()
                }
              />
            }
          />
          <defs>
            <linearGradient id="fillCost" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--chart-4)" stopOpacity={0.8} />
              <stop offset="95%" stopColor="var(--chart-4)" stopOpacity={0.1} />
            </linearGradient>
            <linearGradient id="fillQty" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--chart-3)" stopOpacity={0.8} />
              <stop offset="95%" stopColor="var(--chart-3)" stopOpacity={0.1} />
            </linearGradient>
            <linearGradient id="fillCount" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--chart-5)" stopOpacity={0.8} />
              <stop offset="95%" stopColor="var(--chart-5)" stopOpacity={0.1} />
            </linearGradient>
          </defs>
          <Area
            yAxisId="right"
            type="monotone"
            fill="url(#fillCost)"
            dataKey="total_cost"
            stroke={chartConfig.total_cost.color}
            name={chartConfig.total_cost.label}
          />
          <Area
            yAxisId="left"
            type="monotone"
            fill="url(#fillQty)"
            dataKey="total_quantity"
            stroke={chartConfig.total_quantity.color}
            name={chartConfig.total_quantity.label}
          />
          <Area
            yAxisId="left"
            type="monotone"
            fill="url(#fillCount)"
            dataKey="record_count"
            stroke={chartConfig.record_count.color}
            name={chartConfig.record_count.label}
          />
        </AreaChart>
      </ChartContainer>
    </Card>
  );
}

export default CustomAreaChart;
