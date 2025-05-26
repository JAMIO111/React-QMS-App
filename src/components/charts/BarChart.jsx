"use client";

import { TrendingUp } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
} from "@/components/ui/chart";
const chartData = [
  { month: "January", Internal: 186, Supplier: 80 },
  { month: "February", Internal: 305, Supplier: 200 },
  { month: "March", Internal: 237, Supplier: 120 },
  { month: "April", Internal: 73, Supplier: 190 },
  { month: "May", Internal: 209, Supplier: 130 },
  { month: "June", Internal: 214, Supplier: 140 },
  { month: "July", Internal: 150, Supplier: 90 },
  { month: "August", Internal: 300, Supplier: 200 },
  { month: "September", Internal: 250, Supplier: 180 },
  { month: "October", Internal: 400, Supplier: 300 },
  { month: "November", Internal: 350, Supplier: 250 },
  { month: "December", Internal: 500, Supplier: 400 },
];

const chartConfig = {
  Internal: {
    label: "Internal",
    color: "hsl(var(--chart-1))",
  },
  Supplier: {
    label: "Supplier",
    color: "hsl(var(--chart-2))",
  },
};

export function Component() {
  return (
    <ChartContainer config={chartConfig}>
      <ChartLegend content={<ChartLegendContent />} />
      <BarChart accessibilityLayer data={chartData}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="month"
          tickLine={false}
          tickMargin={10}
          axisLine={false}
          tickFormatter={(value) => value.slice(0, 3)}
        />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent indicator="dashed" />}
        />
        <Bar dataKey="Internal" fill="var(--chart-1)" radius={4} />
        <Bar dataKey="Supplier" fill="var(--chart-2)" radius={4} />
      </BarChart>
    </ChartContainer>
  );
}
export default Component;
