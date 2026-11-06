import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
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

/**
 * Histogram of the readings with the specification limits (solid), the nominal and the mean (dashed) and the normal
 * curve the overall σ implies. The bars are counts per bin; the curve is in the same counts.
 */
export const CapabilityHistogram = ({ histogram, spec, mean, decimals }) => {
  const rows = histogram.bins.map((b) => ({ x: (b.from + b.to) / 2, from: b.from, to: b.to, count: b.count }));
  const curve = histogram.curve.map((p) => ({ x: p.x, curve: p.y }));
  const data = [...rows, ...curve].sort((a, b) => a.x - b.x);
  const lo = histogram.bins[0].from;
  const hi = histogram.bins[histogram.bins.length - 1].to;
  const spec1 = "var(--chart-series-2)";
  const neutral = "var(--chart-neutral)";
  const d = Math.max(2, decimals - 1);
  return (
    <div
      className="h-64"
      role="img"
      aria-label={`Histogram of ${rows.reduce((t, r) => t + r.count, 0)} readings against the specification`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 16, right: 24, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis dataKey="x" type="number" domain={[lo, hi]} tick={tick} tickLine={false} tickFormatter={(v) => formatValue(v, d)} />
          <YAxis tick={tick} allowDecimals={false} width={36} tickLine={false} axisLine={false} />
          <Tooltip
            formatter={(v, name) => [name === "count" ? v : Number(v).toFixed(1), name === "count" ? "Readings" : "Normal curve"]}
            labelFormatter={(v) => `${formatValue(v, d)} ${""}`.trim()}
          />
          <Bar dataKey="count" name="count" fill="var(--chart-series-1)" fillOpacity={0.6} barSize={Math.max(6, 520 / rows.length - 4)} isAnimationActive={false} />
          <Line dataKey="curve" name="curve" type="monotone" stroke={neutral} strokeWidth={1.5} dot={false} activeDot={false} isAnimationActive={false} connectNulls />
          {spec.lower !== null && <ReferenceLine x={spec.lower} stroke={spec1} strokeWidth={2} label={label(`LSL ${formatValue(spec.lower, d)}`, spec1, "insideTopLeft")} />}
          {spec.upper !== null && <ReferenceLine x={spec.upper} stroke={spec1} strokeWidth={2} label={label(`USL ${formatValue(spec.upper, d)}`, spec1, "insideTopRight")} />}
          {spec.nominal !== null && <ReferenceLine x={spec.nominal} stroke={spec1} strokeDasharray="4 3" label={label("Nominal", spec1, "insideTopLeft")} />}
          <ReferenceLine x={mean} stroke={neutral} strokeDasharray="6 4" label={label(`Mean ${formatValue(mean, d)}`, neutral, "insideTopRight")} />
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
