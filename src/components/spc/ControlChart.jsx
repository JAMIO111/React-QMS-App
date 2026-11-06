import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDateTime } from "../../lib/processControl";
import {
  RULE_LABEL,
  formatPercent,
  formatValue,
  proportionDomain,
  yDomain,
} from "../../lib/spc";

const tick = { fontSize: 12, fill: "currentColor" };

/** A reading: a dot; a point that breaks a rule is a larger diamond (shape, not colour alone). */
const Marker = ({ cx, cy, payload, flag }) => {
  if (cx === undefined || cy === undefined || cx === null || cy === null)
    return null;
  const flagged = flag(payload);
  if (!flagged)
    return (
      <circle
        cx={cx}
        cy={cy}
        r={3}
        fill="var(--chart-series-1)"
        stroke="none"
      />
    );
  return (
    <path
      d={`M${cx} ${cy - 7} L${cx + 7} ${cy} L${cx} ${cy + 7} L${cx - 7} ${cy} Z`}
      fill="var(--chart-critical)"
      stroke="var(--chart-critical)"
      strokeWidth={1}
    />
  );
};

const PointTooltip = ({
  active,
  payload,
  decimals,
  unit,
  valueLabel,
  dispersionLabel,
}) => {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const p = row.point;
  return (
    <div className="rounded-lg border border-border-color bg-primary-bg p-2 text-xs text-primary-text shadow-md">
      <p className="font-medium">
        Point {row.n} · {formatDateTime(row.at)}
      </p>
      <p>
        {valueLabel}:{" "}
        <span className="tabular-nums">{formatValue(row.value, decimals)}</span>{" "}
        {unit}
      </p>
      {row.dispersion !== null && (
        <p>
          {dispersionLabel}:{" "}
          <span className="tabular-nums">
            {formatValue(row.dispersion, decimals)}
          </span>{" "}
          {unit}
        </p>
      )}
      {p.readings.length > 1 && (
        <p>Readings: {p.readings.map((r) => r.value).join(", ")}</p>
      )}
      <p>{p.inspections.map((i) => i.reference).join(", ")}</p>
      {p.lot && <p>Lot {p.lot}</p>}
      {p.gaugeOverride && <p>Gauge override used</p>}
      {row.rules.length > 0 && (
        <p className="font-medium text-error-color">
          {row.rules.map((r) => RULE_LABEL[r].short).join(", ")}
        </p>
      )}
    </div>
  );
};

const limitLabel = (text, color, position = "insideTopRight") => ({
  value: text,
  position,
  fontSize: 11,
  fill: color,
});

/**
 * Location chart (individual value or subgroup mean). Control limits (dashed, from the process) and the
 * specification (solid, from the drawing) are drawn and labelled differently; they are never the same thing.
 */
export const LocationChart = ({
  chart,
  rows,
  decimals,
  showSpec,
  valueLabel,
}) => {
  const { limits, spec, characteristic: ch } = chart;
  const f = (v) => formatValue(v, decimals);
  const extras = [
    limits?.ucl,
    limits?.lcl,
    ...(showSpec ? [spec.lower, spec.upper] : []),
  ];
  const domain = yDomain(
    rows.map((r) => r.value),
    extras,
  );
  const control = "var(--chart-neutral)";
  const specColor = "var(--chart-series-2)";
  return (
    <div
      className="h-72"
      role="img"
      aria-label={`${valueLabel} chart, ${rows.length} points, ${chart.signals.length} signal${chart.signals.length === 1 ? "" : "s"}`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={rows}
          margin={{ top: 8, right: 64, bottom: 4, left: 4 }}
        >
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis
            dataKey="n"
            type="number"
            domain={[1, Math.max(rows.length, 2)]}
            allowDecimals={false}
            tick={tick}
            tickLine={false}
          />
          <YAxis
            domain={domain}
            tick={tick}
            tickFormatter={f}
            width={64}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            content={
              <PointTooltip
                decimals={decimals}
                unit={ch.unitCode ?? ""}
                valueLabel={valueLabel}
                dispersionLabel={
                  chart.characteristic.chartType === "imr"
                    ? "Moving range"
                    : "Range"
                }
              />
            }
          />
          {showSpec && spec.upper !== null && (
            <ReferenceLine
              y={spec.upper}
              stroke={specColor}
              strokeWidth={2}
              ifOverflow="extendDomain"
              label={limitLabel(
                `USL ${f(spec.upper)}`,
                specColor,
                "insideBottomRight",
              )}
            />
          )}
          {showSpec && spec.lower !== null && (
            <ReferenceLine
              y={spec.lower}
              stroke={specColor}
              strokeWidth={2}
              ifOverflow="extendDomain"
              label={limitLabel(
                `LSL ${f(spec.lower)}`,
                specColor,
                "insideTopRight",
              )}
            />
          )}
          {limits && (
            <ReferenceLine
              y={limits.ucl}
              stroke={control}
              strokeDasharray="6 4"
              label={limitLabel(`UCL ${f(limits.ucl)}`, control)}
            />
          )}
          {limits && (
            <ReferenceLine
              y={limits.centre}
              stroke={control}
              label={limitLabel(
                `CL ${f(limits.centre)}`,
                control,
                "insideBottomRight",
              )}
            />
          )}
          {limits && (
            <ReferenceLine
              y={limits.lcl}
              stroke={control}
              strokeDasharray="6 4"
              label={limitLabel(
                `LCL ${f(limits.lcl)}`,
                control,
                "insideBottomRight",
              )}
            />
          )}
          <Line
            type="linear"
            dataKey="value"
            stroke="var(--chart-series-1)"
            strokeWidth={1.5}
            isAnimationActive={false}
            dot={({ key, ...props }) => (
              <Marker key={key} {...props} flag={(r) => r.rules.length > 0} />
            )}
            activeDot={{ r: 5 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

/** Dispersion chart: the moving range or the subgroup range with its own limits. */
export const DispersionChart = ({ chart, rows, decimals, label }) => {
  const { limits, characteristic: ch } = chart;
  const f = (v) => formatValue(v, decimals);
  const data = rows.filter((r) => r.dispersion !== null);
  // A range cannot be negative: the axis starts at zero.
  const top = yDomain(
    data.map((r) => r.dispersion),
    [limits?.dispersionUcl],
  )[1];
  const domain = [0, typeof top === "number" ? top : "auto"];
  const control = "var(--chart-neutral)";
  return (
    <div
      className="h-48"
      role="img"
      aria-label={`${label} chart, ${data.length} points, ${chart.dispersionSignals.length} above the upper limit`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 8, right: 64, bottom: 4, left: 4 }}
        >
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis
            dataKey="n"
            type="number"
            domain={[1, Math.max(rows.length, 2)]}
            allowDecimals={false}
            tick={tick}
            tickLine={false}
          />
          <YAxis
            domain={domain}
            tick={tick}
            tickFormatter={f}
            width={64}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            content={
              <PointTooltip
                decimals={decimals}
                unit={ch.unitCode ?? ""}
                valueLabel={label}
                dispersionLabel={label}
              />
            }
          />
          {limits && (
            <ReferenceLine
              y={limits.dispersionUcl}
              stroke={control}
              strokeDasharray="6 4"
              label={limitLabel(`UCL ${f(limits.dispersionUcl)}`, control)}
            />
          )}
          {limits && (
            <ReferenceLine
              y={limits.dispersionCentre}
              stroke={control}
              label={limitLabel(
                `CL ${f(limits.dispersionCentre)}`,
                control,
                "insideBottomRight",
              )}
            />
          )}
          <Line
            type="linear"
            dataKey="dispersion"
            stroke="var(--chart-series-1)"
            strokeWidth={1.5}
            isAnimationActive={false}
            dot={({ key, ...props }) => (
              <Marker key={key} {...props} flag={(r) => r.rangeSignal} />
            )}
            activeDot={{ r: 5 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

/** What the lines and markers mean, in words. */
export const ChartKey = ({ showSpec, proportion = false }) => (
  <ul
    className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-secondary-text"
    aria-label="Chart key"
  >
    <li>
      <span aria-hidden="true">- - </span>
      {proportion
        ? "Control limits (UCL/LCL, recalculated for each subgroup's size)"
        : "Control limits (UCL/LCL, from the process)"}
    </li>
    <li>
      <span aria-hidden="true">— </span>
      {proportion
        ? "Centre line p̄ (all failures over all checks)"
        : "Centre line (CL)"}
    </li>
    {showSpec && (
      <li>
        <span aria-hidden="true" className="font-bold">
          ━{" "}
        </span>
        Specification (USL/LSL, from the drawing)
      </li>
    )}
    <li>
      <span aria-hidden="true">◆ </span>Point that breaks a rule
    </li>
  </ul>
);

/** Tooltip of a P chart point: how many were checked and failed, and this subgroup's own limits. */
const ProportionTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const p = row.point;
  return (
    <div className="rounded-lg border border-border-color bg-primary-bg p-2 text-xs text-primary-text shadow-md">
      <p className="font-medium">
        Point {row.n} · {formatDateTime(row.at)}
      </p>
      <p>
        {row.failed} of {row.checked} failed (
        <span className="tabular-nums">{formatPercent(row.value, 2)}</span>)
      </p>
      {row.ucl !== null && (
        <p>
          Limits for {row.checked} checks: {formatPercent(row.lcl, 2)} to{" "}
          {formatPercent(row.ucl, 2)}
        </p>
      )}
      {p.inspections.length > 0 && (
        <p>{p.inspections.map((i) => i.reference).join(", ")}</p>
      )}
      {p.lot && <p>Lot {p.lot}</p>}
      {row.rules.length > 0 && (
        <p className="font-medium text-error-color">
          {row.rules.map((r) => RULE_LABEL[r].short).join(", ")}
        </p>
      )}
    </div>
  );
};

/**
 * P chart: the share of checks that failed in each subgroup. The control limits (dashed, stepped) follow each
 * subgroup's size — a small subgroup has wider limits — around the centre line p̄. There is no specification here.
 */
export const ProportionChart = ({ chart, rows }) => {
  const { limits } = chart;
  const control = "var(--chart-neutral)";
  return (
    <div
      className="h-72"
      role="img"
      aria-label={`Proportion failed chart, ${rows.length} points, ${chart.signals.length} signal${chart.signals.length === 1 ? "" : "s"}`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={rows}
          margin={{ top: 8, right: 64, bottom: 4, left: 4 }}
        >
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis
            dataKey="n"
            type="number"
            domain={[1, Math.max(rows.length, 2)]}
            allowDecimals={false}
            tick={tick}
            tickLine={false}
          />
          <YAxis
            domain={proportionDomain(rows)}
            tick={tick}
            tickFormatter={(v) => formatPercent(v, 0)}
            width={52}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip content={<ProportionTooltip />} />
          {limits && (
            <ReferenceLine
              y={limits.centre}
              stroke={control}
              label={limitLabel(
                `p̄ ${formatPercent(limits.centre, 2)}`,
                control,
                "insideBottomRight",
              )}
            />
          )}
          <Line
            type="stepAfter"
            dataKey="ucl"
            name="UCL"
            stroke={control}
            strokeDasharray="6 4"
            strokeWidth={1.5}
            dot={false}
            activeDot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
          <Line
            type="stepAfter"
            dataKey="lcl"
            name="LCL"
            stroke={control}
            strokeDasharray="6 4"
            strokeWidth={1.5}
            dot={false}
            activeDot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
          <Line
            type="linear"
            dataKey="value"
            stroke="var(--chart-series-1)"
            strokeWidth={1.5}
            isAnimationActive={false}
            dot={({ key, ...props }) => (
              <Marker key={key} {...props} flag={(r) => r.rules.length > 0} />
            )}
            activeDot={{ r: 5 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};
