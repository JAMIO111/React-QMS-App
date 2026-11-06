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

/**
 * Process capability against the specification: Cp/Cpk (within σ, from the control chart) and Pp/Ppk (overall σ of
 * the readings). Calculated by the API from the readings shown; indices that need both limits are blank for a
 * one-sided specification.
 */
const CapabilityCard = ({ capability: c, decimals, unit }) => (
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
