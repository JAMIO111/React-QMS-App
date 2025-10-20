import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart";

export default function BookingVolumeChart({ data, subtitle }) {
  if (!data || !Array.isArray(data)) {
    return (
      <div className="h-full flex justify-center items-center rounded-3xl shadow-m bg-secondary-bg text-secondary-text">
        No date range selected
      </div>
    );
  }

  // Sort data by date (optional)
  const sortedData = useMemo(() => {
    return data.slice().sort((a, b) => {
      const [monthA, yearA] = a.month.split(" ");
      const [monthB, yearB] = b.month.split(" ");
      return (
        new Date(`${monthA} 1, 20${yearA}`) -
        new Date(`${monthB} 1, 20${yearB}`)
      );
    });
  }, [data]);

  function TooltipContentWrapper({ active, payload, label }) {
    if (!active || !payload || !payload.length) return null;

    // For single-level booking chart, there is only one value per month
    const enrichedPayload = payload.map(({ dataKey, value }) => ({
      dataKey,
      value,
      subModeName: "Bookings", // you can keep the label consistent
      color: "rgba(0, 123, 255, 0.8)", // match the bar color
    }));

    return (
      <ChartTooltipContent
        payload={enrichedPayload}
        label={label}
        active={active}
      />
    );
  }

  return (
    <Card className="h-full shadow-m flex flex-col overflow-hidden">
      <CardHeader className="flex w-full justify-between flex-shrink-0 h-14 px-6">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-primary-text text-lg">
            No. of Bookings
          </CardTitle>
          <CardDescription className="text-secondary-text">
            {subtitle}
          </CardDescription>
        </div>
      </CardHeader>
      <div className="flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <ChartContainer
            config={{ bookings: { color: "rgba(0, 123, 255, 0.8)" } }}>
            <BarChart
              data={sortedData}
              margin={{ top: 10, right: 20, left: -20, bottom: 30 }}>
              <CartesianGrid
                stroke="var(--color-border-color)"
                vertical={false}
              />
              <XAxis
                dataKey="month"
                interval={0}
                tick={({ x, y, payload }) => (
                  <text
                    x={x}
                    y={y + 10}
                    textAnchor="end"
                    fill="#666"
                    transform={`rotate(-30, ${x}, ${y + 10})`}
                    style={{ fontSize: 12 }}>
                    {payload.value}
                  </text>
                )}
              />
              <YAxis />
              <Tooltip content={<TooltipContentWrapper />} />
              <Bar dataKey="bookings" fill="rgba(0, 123, 255, 0.8)" />
            </BarChart>
          </ChartContainer>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
