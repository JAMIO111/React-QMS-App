import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartTooltip, grid, tick } from "../dashboard/DashboardParts";
import { formatValue } from "../../lib/qualityObjectives";

const COLOUR = { on_target: "var(--chart-series-3)", off_target: "var(--chart-critical)" };

/**
 * The values of an objective per period as bars against a dashed target line. A bar is green on target and red off it; the period in progress is paler.
 * Every figure is also in words beside it (the card or the table), so the chart is not the only way to read it.
 */
const ObjectiveChart = ({ objective, periods, height = "h-48", compact = false }) => (
  <div className={height}>
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={periods} margin={{ top: 8, right: 8, bottom: 0, left: compact ? -28 : -12 }} aria-label={`${objective.title} by period`}>
        {!compact && <CartesianGrid {...grid} />}
        <XAxis dataKey="label" tick={tick} axisLine={false} tickLine={false} minTickGap={8} hide={compact} />
        <YAxis allowDecimals tick={tick} axisLine={false} tickLine={false} hide={compact} domain={[0, (max) => Math.max(max, objective.target) * 1.1 || 1]} />
        {!compact && <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={<ChartTooltip />} formatter={(v) => formatValue(v, objective.unit)} />}
        <ReferenceLine y={objective.target} stroke="var(--chart-neutral)" strokeDasharray="4 3" ifOverflow="extendDomain" />
        <Bar dataKey="value" name="Value" radius={[4, 4, 0, 0]} maxBarSize={compact ? 14 : 28}>
          {periods.map((p) => (
            <Cell key={p.periodStart} fill={COLOUR[p.standing] ?? "var(--chart-neutral)"} fillOpacity={p.current ? 0.5 : 1} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  </div>
);

export default ObjectiveChart;
