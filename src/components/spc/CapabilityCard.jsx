import { useId } from "react";
import { CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import MenuCard from "../ui/MenuCard";
import { CircleAlertIcon } from "@/components/icons";
import { formatValue } from "../../lib/spc";

const VERDICT = {
  excellent: "Excellent (1.67 or more)",
  capable: "Capable (1.33 or more)",
  marginal: "Marginal (1.00 to 1.33)",
  not_capable: "Not capable (below 1.00)",
};
const index = (v) => (v === null || v === undefined ? "—" : v.toFixed(2));
const ppm = (v) => (v === null || v === undefined ? "—" : v < 1 ? "< 1" : Math.round(v).toLocaleString("en-GB"));

const tick = { fontSize: 12, fill: "currentColor" };
const label = (text, color, position) => ({ value: text, position, fontSize: 11, fill: color });

/** Tooltip in the same style as the control charts: rounded, themed border and background, readable in light and dark. */
const HistogramTooltip = ({ active, payload, decimals, bins }) => {
  if (!active || !payload?.length) return null;
  const x = payload[0].payload.x;
  const bin = bins.find((b) => x >= b.from && x < b.to) ?? (x >= bins[bins.length - 1].to ? bins[bins.length - 1] : null);
  return (
    <div className="rounded-lg border border-border-color bg-primary-bg p-2 text-xs text-primary-text shadow-md">
      {bin ? (
        <>
          <p className="font-medium">
            {formatValue(bin.from, decimals)} to {formatValue(bin.to, decimals)}
          </p>
          <p>
            {bin.count} {bin.count === 1 ? "reading" : "readings"}
          </p>
        </>
      ) : (
        <p className="font-medium">{formatValue(x, decimals)}</p>
      )}
      <p className="text-secondary-text">Normal curve: {Number(payload[0].payload.curve).toFixed(1)} expected</p>
    </div>
  );
};

/** A bar across one bin: a small gap each side, rounded top corners, a soft top-to-bottom fade. */
const binShape = (fill) => (props) => {
  const { x, y, width, height } = props;
  const gap = Math.min(3, width / 6);
  const w = Math.max(0, width - gap * 2);
  const r = Math.min(6, w / 2, height);
  if (w <= 0 || height <= 0) return <g />;
  const x0 = x + gap;
  const d = `M${x0},${y + height} L${x0},${y + r} Q${x0},${y} ${x0 + r},${y} L${x0 + w - r},${y} Q${x0 + w},${y} ${x0 + w},${y + r} L${x0 + w},${y + height} Z`;
  return <path d={d} fill={fill} />;
};

/**
 * Histogram of the readings with the specification limits (solid), the nominal and the mean (dashed) and the normal
 * curve the overall σ implies. The bars are counts per bin; the curve is in the same counts.
 */
export const CapabilityHistogram = ({ histogram, spec, mean, decimals }) => {
  const gradientId = useId();
  const bins = histogram.bins;
  const data = histogram.curve.map((p) => ({ x: p.x, curve: p.y }));
  const lo = bins[0].from;
  const hi = bins[bins.length - 1].to;
  const top = Math.max(1, ...bins.map((b) => b.count), ...histogram.curve.map((p) => p.y));
  const spec1 = "var(--chart-series-2)";
  const neutral = "var(--chart-neutral)";
  const d = Math.max(2, decimals - 1);
  // The nominal and mean lines are usually close: put each label on the outer side of its own line (Recharts: insideTopLeft draws to the right of a vertical line, insideTopRight to its left), so they never overlap.
  const nominalRight = spec.nominal !== null && spec.nominal >= mean;
  return (
    <div
      className="h-64"
      role="img"
      aria-label={`Histogram of ${bins.reduce((t, b) => t + b.count, 0)} readings against the specification`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 16, right: 24, bottom: 4, left: 4 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-series-1)" stopOpacity={0.9} />
              <stop offset="100%" stopColor="var(--chart-series-1)" stopOpacity={0.35} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis dataKey="x" type="number" domain={[lo, hi]} tick={tick} tickLine={false} tickFormatter={(v) => formatValue(v, d)} />
          <YAxis domain={[0, Math.ceil(top * 1.1)]} tick={tick} allowDecimals={false} width={36} tickLine={false} axisLine={false} />
          <Tooltip content={<HistogramTooltip decimals={d} bins={bins} />} />
          {bins.map((b) => (
            <ReferenceArea key={b.from} x1={b.from} x2={b.to} y1={0} y2={b.count} shape={binShape(`url(#${gradientId})`)} ifOverflow="visible" />
          ))}
          <Line dataKey="curve" name="curve" type="monotone" stroke={neutral} strokeWidth={1.5} dot={false} activeDot={false} isAnimationActive={false} connectNulls />
          {spec.lower !== null && <ReferenceLine x={spec.lower} stroke={spec1} strokeWidth={2} label={label(`LSL ${formatValue(spec.lower, d)}`, spec1, "insideTopLeft")} />}
          {spec.upper !== null && <ReferenceLine x={spec.upper} stroke={spec1} strokeWidth={2} label={label(`USL ${formatValue(spec.upper, d)}`, spec1, "insideTopRight")} />}
          {spec.nominal !== null && <ReferenceLine x={spec.nominal} stroke={spec1} strokeDasharray="4 3" label={label("Nominal", spec1, nominalRight ? "insideTopLeft" : "insideTopRight")} />}
          <ReferenceLine x={mean} stroke={neutral} strokeDasharray="6 4" label={label(`Mean ${formatValue(mean, d)}`, neutral, nominalRight ? "insideTopRight" : "insideTopLeft")} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

/**
 * Process capability against the specification: Cp/Cpk (within σ, from the control chart) and Pp/Ppk (overall σ of
 * the readings). Calculated by the API from the readings shown; indices that need both limits are blank for a
 * one-sided specification.
 */
const CapabilityCard = ({ capability: c, decimals, unit, spec }) => (
  <MenuCard
    title="Process capability"
    subtitle="How well the process fits the specification (not the control limits), for the readings shown."
  >
    <div className="flex flex-col gap-3">
      {c.warnings.length > 0 && (
        <ul role="status" className="flex flex-col gap-1 rounded-lg border border-border-color p-3 text-sm text-primary-text">
          {c.warnings.map((w) => (
            <li key={w} className="flex items-start gap-2">
              <CircleAlertIcon className="mt-0.5 h-4 w-4 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}
      {c.histogram && spec && (
        <div className="flex flex-col gap-1">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-secondary-text" aria-label="Histogram key">
            <li>▮ Readings per bin</li>
            <li>— Normal curve (overall σ)</li>
            <li>━ Specification (LSL/USL)</li>
            <li>- - Mean</li>
          </ul>
          <CapabilityHistogram histogram={c.histogram} spec={spec} mean={c.mean} decimals={decimals} />
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] border-separate border-spacing-0 text-sm text-primary-text" aria-label="Capability indices">
          <thead>
            <tr>
              {["", "Potential (both limits)", "Upper side", "Lower side", "Actual (nearer limit)"].map((h) => (
                <th key={h} scope="col" className="border-b border-border-color px-2 py-2 text-left font-normal text-secondary-text">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              ["Within σ", "Cp", "Cpu", "Cpl", "Cpk", c.within, c.sigmaWithin],
              ["Overall σ", "Pp", "Ppu", "Ppl", "Ppk", c.overall, c.sigmaOverall],
            ].map(([label, a, b, l, k, x, sigma]) => (
              <tr key={a}>
                <th scope="row" className="border-b border-border-color px-2 py-2 text-left font-normal">
                  {label}
                  <span className="block text-xs text-secondary-text">σ = {formatValue(sigma, decimals + 1)}</span>
                </th>
                <td className="border-b border-border-color px-2 py-2 tabular-nums">{a} {index(x.ratio)}</td>
                <td className="border-b border-border-color px-2 py-2 tabular-nums">{b} {index(x.upper)}</td>
                <td className="border-b border-border-color px-2 py-2 tabular-nums">{l} {index(x.lower)}</td>
                <td className="border-b border-border-color px-2 py-2 font-medium tabular-nums">{k} {index(x.k)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        {[
          ["Readings", c.n],
          ["Mean", `${formatValue(c.mean, decimals + 1)} ${unit ?? ""}`],
          ["Out of specification (observed)", `${ppm(c.observedPpm)} ppm`],
          ["Expected if normal (overall σ)", `${ppm(c.expectedPpm)} ppm`],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-secondary-text">{k}</dt>
            <dd className="tabular-nums text-primary-text">{v}</dd>
          </div>
        ))}
      </dl>
      {c.verdict && (
        <p className="text-sm text-primary-text">
          Cpk verdict: <span className="font-medium">{VERDICT[c.verdict]}</span>
        </p>
      )}
    </div>
  </MenuCard>
);

export default CapabilityCard;
