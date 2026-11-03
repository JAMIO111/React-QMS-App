import { useState, useEffect, useMemo } from "react";
import { PieChart, Pie, Cell } from "recharts";

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

export function CustomAreaChart({
  subtitle = "Defective Units Trend",
  chartData = [],
}) {
  const COLORS = [
    "var(--chart-1)",
    "var(--chart-2)",
    "var(--chart-3)",
    "var(--chart-4)",
    "var(--chart-5)",
    "#8884d8",
  ];

  const chartConfig = useMemo(() => {
    if (!chartData?.length) return {};
    return chartData.reduce((acc, part, index) => {
      acc[part.part_name] = {
        label: part.part_number,
        color: COLORS[index % COLORS.length],
      };
      return acc;
    }, {});
  }, [chartData]);

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
        <div></div>
      </CardHeader>

      <ChartContainer
        config={chartConfig}
        className="flex-grow min-h-0 px-6 pb-4">
        <PieChart>
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value, name) => [value, chartConfig[name]?.label]}
              />
            }
          />

          <Pie
            data={chartData}
            dataKey="total_defects"
            nameKey="part_number"
            innerRadius={80}
            outerRadius={130}>
            {chartData?.map((entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={
                  chartConfig[entry.part_name]?.color ||
                  COLORS[index % COLORS.length]
                }
              />
            ))}
          </Pie>
          <ChartLegend>
            {chartData.map((entry) => (
              <ChartLegendContent
                key={entry.part_name}
                label={chartConfig[entry.part_name]?.label}
                color={chartConfig[entry.part_name]?.color}
                value={`${entry.total_defects} defects`}
              />
            ))}
          </ChartLegend>
        </PieChart>
      </ChartContainer>
    </Card>
  );
}

export default CustomAreaChart;
