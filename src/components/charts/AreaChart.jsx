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

import currencyCodes from "@/currencyCodes";

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

export function CustomAreaChart({ chartData, base_currency = "£" }) {
  function getCurrencyFormatter(currencyCode) {
    const currency = currencyCodes[currencyCode];

    if (!currency) {
      console.log(
        `Unsupported currency code: ${currencyCode}. Falling back to GBP.`
      );
      return new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: "GBP",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format;
    }

    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: currency.code,
      minimumFractionDigits: currency.decimal_digits,
      maximumFractionDigits: currency.decimal_digits,
    }).format;
  }

  const currencyFormatter = getCurrencyFormatter(base_currency);

  return (
    <Card className="h-full flex flex-col overflow-hidden">
      {/* Fixed-height header */}
      <CardHeader className="flex-shrink-0 h-20 px-8">
        <CardTitle className="text-primary-text text-lg">
          Defective Units
        </CardTitle>
        <CardDescription className="text-muted">
          Overview of desktop and mobile traffic over the last 6 months.
        </CardDescription>
      </CardHeader>

      {/* Chart fills remaining space */}
      <ChartContainer
        config={chartConfig}
        className="flex-grow min-h-0 px-6 pb-4">
        <AreaChart
          data={chartData}
          margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--color-border-color)" vertical={false} />
          <XAxis
            dataKey="label"
            axisLine={{ stroke: "var(--color-border-dark-color)" }}
            tickLine={{ stroke: "var(--color-border-dark-color)" }}
            tick={{
              fill: "var(--color-primary-text)",
              fontSize: 12,
              fontWeight: 500,
            }}
          />
          <YAxis
            yAxisId="left"
            orientation="left"
            axisLine={{ stroke: "var(--color-border-dark-color)" }}
            tickLine={{ stroke: "var(--color-border-dark-color)" }}
            tick={{
              fill: "var(--color-secondary-text)",
              fontSize: 12,
              fontWeight: 500,
            }}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            axisLine={{ stroke: "var(--color-border-dark-color)" }}
            tickLine={{ stroke: "var(--color-border-dark-color)" }}
            tick={{
              fill: "var(--color-secondary-text)",
              fontSize: 12,
              fontWeight: 500,
            }}
            tickFormatter={(value) =>
              `${currencyCodes[base_currency]?.symbol}${value.toLocaleString()}`
            }
          />
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
            cursor={{ fill: "var(--color-border-color)" }}
            wrapperStyle={{ backgroundColor: "var(--color-bg)" }}
          />
          <Area
            yAxisId="right"
            type="monotone"
            dataKey="total_cost"
            stroke={chartConfig.total_cost.color}
            fill={chartConfig.total_cost.color}
            name={chartConfig.total_cost.label}
          />
          <Area
            yAxisId="left"
            type="monotone"
            dataKey="total_quantity"
            stroke={chartConfig.total_quantity.color}
            fill={chartConfig.total_quantity.color}
            name={chartConfig.total_quantity.label}
          />
          <Area
            yAxisId="left"
            type="monotone"
            dataKey="record_count"
            stroke={chartConfig.record_count.color}
            fill={chartConfig.record_count.color}
            name={chartConfig.record_count.label}
          />
        </AreaChart>
      </ChartContainer>
    </Card>
  );
}

export default CustomAreaChart;
