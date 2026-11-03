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

export default function StackedBarChart({ data, subtitle }) {
  if (!data || !Array.isArray(data)) {
    return <div>No data available</div>;
  }

  const sortedData = useMemo(() => {
    return data?.slice().sort((a, b) => b.total_quantity - a.total_quantity);
  }, [data]);

  const maxStackDepth = useMemo(() => {
    return Math.max(...sortedData.map((d) => d.sub_failure_modes.length));
  }, [sortedData]);

  const levelKeys = useMemo(() => {
    return Array.from({ length: maxStackDepth }, (_, i) => `level_${i}`);
  }, [maxStackDepth]);

  const flattenedData = useMemo(() => {
    return sortedData.map(({ failure_mode, sub_failure_modes }) => {
      const item = { failure_mode };
      sub_failure_modes.forEach(({ quantity }, index) => {
        item[`level_${index}`] = quantity;
      });
      return item;
    });
  }, [sortedData]);

  const levelSubModeMap = useMemo(() => {
    const map = {};
    sortedData.forEach(({ failure_mode, sub_failure_modes }) => {
      map[failure_mode] = sub_failure_modes.map(
        ({ sub_failure_mode }) => sub_failure_mode
      );
    });
    return map;
  }, [sortedData]);

  const colorVars = [
    "--chart-1-rgb",
    "--chart-2-rgb",
    "--chart-3-rgb",
    "--chart-4-rgb",
    "--chart-5-rgb",
    "--chart-6-rgb",
    "--chart-7-rgb",
    "--chart-8-rgb",
    "--chart-9-rgb",
    "--chart-10-rgb",
  ];

  const levelColorMap = useMemo(() => {
    const map = {};
    levelKeys.forEach((key, index) => {
      const colorVar = colorVars[index % colorVars.length];
      map[key] = {
        fill: `rgba(var(${colorVar}), 0.8)`,
        stroke: `rgb(var(${colorVar}))`,
      };
    });
    return map;
  }, [levelKeys]);

  const chartConfig = useMemo(() => {
    return levelKeys.reduce((acc, key, index) => {
      acc[key] = {
        color: levelColorMap[key].fill,
        label: `Level ${index + 1}`,
      };
      return acc;
    }, {});
  }, [levelKeys, levelColorMap]);

  const RoundedBarSegment = ({
    x,
    y,
    width,
    height,
    fill,
    stroke,
    payload,
    dataKey,
  }) => {
    if (height === 0) return null;

    const activeKeys = levelKeys.filter((key) => payload[key] > 0);
    const isBottom = dataKey === activeKeys[0];
    const isTop = dataKey === activeKeys[activeKeys.length - 1];

    const maxRadius = Math.min(4, height / 2, width / 2);

    let path = "";

    if (isTop && isBottom) {
      path = `
        M${x},${y + maxRadius}
        a${maxRadius},${maxRadius} 0 0 1 ${maxRadius},${-maxRadius}
        h${width - 2 * maxRadius}
        a${maxRadius},${maxRadius} 0 0 1 ${maxRadius},${maxRadius}
        v${height - 2 * maxRadius}
        a${maxRadius},${maxRadius} 0 0 1 ${-maxRadius},${maxRadius}
        h${-(width - 2 * maxRadius)}
        a${maxRadius},${maxRadius} 0 0 1 ${-maxRadius},${-maxRadius}
        Z
      `;
    } else if (isTop) {
      path = `
        M${x},${y + maxRadius}
        a${maxRadius},${maxRadius} 0 0 1 ${maxRadius},${-maxRadius}
        h${width - 2 * maxRadius}
        a${maxRadius},${maxRadius} 0 0 1 ${maxRadius},${maxRadius}
        v${height - maxRadius}
        h${-width}
        Z
      `;
    } else if (isBottom) {
      path = `
        M${x},${y}
        h${width}
        v${height - maxRadius}
        a${maxRadius},${maxRadius} 0 0 1 ${-maxRadius},${maxRadius}
        h${-(width - 2 * maxRadius)}
        a${maxRadius},${maxRadius} 0 0 1 ${-maxRadius},${-maxRadius}
        Z
      `;
    } else {
      path = `
        M${x},${y}
        h${width}
        v${height}
        h${-width}
        Z
      `;
    }

    return <path d={path} fill={fill} stroke={stroke} strokeWidth={1} />;
  };

  // Tooltip wrapper enriches payload with sub failure mode names and colors
  function TooltipContentWrapper({ active, payload, label }) {
    if (!active || !payload || !payload.length) return null;

    const subModes = levelSubModeMap[label] || [];

    const enrichedPayload = payload.map(({ dataKey, value }, index) => ({
      dataKey,
      value,
      subModeName: subModes[index] || `Level ${index + 1}`,
      color: levelColorMap[dataKey]?.fill || "inherit",
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
    <Card className="h-full flex flex-col overflow-hidden">
      <CardHeader className="flex w-full justify-between flex-shrink-0 h-20 px-8">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-primary-text text-lg">
            Defective Units
          </CardTitle>
          <CardDescription className="text-secondary-text">
            {subtitle}
          </CardDescription>
        </div>
      </CardHeader>
      <ResponsiveContainer width="100%" height={400}>
        <ChartContainer config={chartConfig}>
          <BarChart
            data={flattenedData}
            margin={{ top: 0, right: 50, left: 0, bottom: 60 }}>
            <CartesianGrid
              stroke="var(--color-border-color)"
              vertical={false}
            />
            <XAxis
              dataKey="failure_mode"
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
            {levelKeys.map((key) => (
              <Bar
                key={key}
                dataKey={key}
                stackId="a"
                fill={levelColorMap[key].fill}
                shape={(props) => (
                  <RoundedBarSegment
                    {...props}
                    dataKey={key}
                    fill={levelColorMap[key].fill}
                    stroke={levelColorMap[key].stroke}
                  />
                )}
              />
            ))}
          </BarChart>
        </ChartContainer>
      </ResponsiveContainer>
    </Card>
  );
}
