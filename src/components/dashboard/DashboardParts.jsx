import { Rectangle } from "recharts";

/** Pieces shared by the dashboards that follow the Calibration / NC dashboard pattern. */
export const SINGLE = "var(--brand-primary)";
export const tick = { className: "fill-secondary-text", fontSize: 12 };
export const grid = { stroke: "var(--chart-grid)", vertical: false };
export const pctChange = (now, before) =>
  before ? Math.round(((now - before) / before) * 100) : null;
export const percent = (v) =>
  v === null || v === undefined ? "—" : `${v.toLocaleString("en-GB")}%`;

/**
 * Shape for the segments of a stacked bar: only the topmost segment that has something in it gets rounded top corners, whichever series that is
 * (a stack with nothing in its last series would otherwise end square). `seriesKeys` are the series from the bottom of the stack to the top.
 *
 *   <Bar dataKey={s.key} stackId="x" shape={stackedBarShape(SERIES.map((x) => x.key))} />
 */
const shapes = new Map();
export const stackedBarShape = (seriesKeys, radius = 4) => {
  const id = `${radius}:${seriesKeys.join("|")}`;
  if (!shapes.has(id)) {
    shapes.set(id, ({ dataKey, payload, x, y, width, height, fill, stroke, strokeWidth }) => {
      const above = seriesKeys.slice(seriesKeys.indexOf(dataKey) + 1).some((k) => Number(payload?.[k]) > 0);
      return <Rectangle x={x} y={y} width={width} height={height} fill={fill} stroke={stroke} strokeWidth={strokeWidth} radius={above ? 0 : [radius, radius, 0, 0]} />;
    });
  }
  return shapes.get(id);
};

export const ChartTooltip = ({
  active,
  payload,
  label,
  labelFormat = (l) => l,
  valueFormat = (v) => v,
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border-color bg-primary-bg px-3 py-2 text-xs text-primary-text shadow-lg shadow-shadow-color">
      <p className="mb-1 font-semibold">{labelFormat(label)}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ background: p.payload?.fill ?? p.color }}
            aria-hidden="true"
          />
          <span className="text-secondary-text">{p.name}</span>
          <span className="ml-auto font-medium">{valueFormat(p.value)}</span>
        </p>
      ))}
    </div>
  );
};

export const Card = ({ title, subtitle, children, className = "", action }) => (
  <section
    aria-label={title}
    className={`flex min-w-0 flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-4 ${className}`}
  >
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold text-primary-text">{title}</h2>
        {subtitle && <p className="text-xs text-secondary-text">{subtitle}</p>}
      </div>
      {action}
    </div>
    {children}
  </section>
);
