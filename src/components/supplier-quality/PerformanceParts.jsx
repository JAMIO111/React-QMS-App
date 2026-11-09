import { Link } from "react-router-dom";
import { BAND, METRIC_LABELS, METRIC_ORDER, formatScore, percent, sourceLink } from "../../lib/supplierPerformance";
import Callout from "../ui/Callout";

export const BandPill = ({ band }) => {
  const b = BAND[band] ?? BAND.insufficient;
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${b.tone}`}>{b.label}</span>;
};

const TONE = { critical: "error", warning: "warning", info: "info" };

/** A warning in words, with the records behind it as links (up to ten are kept). */
export const WarningList = ({ warnings, supplierId, showInfo = true }) => {
  const shown = warnings.filter((w) => showInfo || w.level !== "info");
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" aria-label="Warnings">
      {shown.map((w) => (
        <Callout key={w.code} tone={TONE[w.level] ?? "info"}>
          <span>{w.message}</span>
          {w.sources?.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {w.sources.map((s, i) => {
                const link = sourceLink(w.sourceType, s, supplierId);
                return link ? <Link key={`${w.code}-${i}`} to={link.to} className="text-link-color hover:underline">{link.label}</Link> : null;
              })}
            </span>
          )}
        </Callout>
      ))}
    </div>
  );
};

/** One card per metric: its score, its weight and what it is made of. A metric without enough data says so and is left out of the score. */
export const ComponentCards = ({ components }) => (
  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Metrics">
    {METRIC_ORDER.map((k) => {
      const c = components.find((x) => x.key === k);
      if (!c) return null;
      return (
        <div key={k} className="rounded-lg border border-border-color p-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-primary-text">{METRIC_LABELS[k]}</span>
            <span className="text-xs text-secondary-text">weight {c.weight}</span>
          </div>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-primary-text">{c.sufficient ? formatScore(c.score) : "—"}</p>
          <p className="text-xs text-secondary-text">{c.detail}</p>
          {c.weight === 0 ? <p className="mt-1 text-xs text-secondary-text">Shown for information; not part of the score</p> : !c.sufficient && <p className="mt-1 text-xs text-secondary-text">Left out of the score</p>}
        </div>
      );
    })}
  </div>
);

/** The raw figures behind the score. */
export const FiguresTable = ({ metrics }) => {
  const rows = [
    ["Delivered lines", `${metrics.deliveries.lines} (${Number(metrics.deliveries.unitsReceived)} units)`],
    ["PPM: rejected at receiving", metrics.ppm.value === null ? "—" : `${Number(metrics.ppm.value).toLocaleString()} (${Number(metrics.ppm.rejectedUnits)} of ${Number(metrics.ppm.receivedUnits)} units rejected)`],
    ...(metrics.ppmNc ? [["PPM: from non-conformances", metrics.ppmNc.value === null ? "—" : `${Number(metrics.ppmNc.value).toLocaleString()} (${Number(metrics.ppmNc.affectedUnits)} of ${Number(metrics.ppmNc.receivedUnits)} units on non-conformances, ${metrics.ppmNc.lines} lines)`]] : []),
    ["Lot rejection", `${percent(metrics.lotRejection.rate, 1)} (${metrics.lotRejection.rejectedLines} of ${metrics.lotRejection.lines} lines)`],
    ["On-time delivery", `${percent(metrics.otd.value, 0)} (${metrics.otd.onTime} on time, ${metrics.otd.late} late${metrics.otd.early ? `, ${metrics.otd.early} too early` : ""}; ${metrics.otd.unmatchedLines} lines with no order left out; by the ${metrics.otd.policy} date${metrics.otd.graceAfter ? `, ${metrics.otd.graceAfter} days late allowed` : ""}${metrics.otd.graceBefore !== null && metrics.otd.graceBefore !== undefined ? `, ${metrics.otd.graceBefore} days early allowed` : ""})`],
    ...(metrics.inFull ? [
      ["Delivered in full", `${percent(metrics.inFull.value, 0)} (${metrics.inFull.inFull} of ${metrics.inFull.lines - metrics.inFull.pending} order lines due in the period: ${metrics.inFull.short} short, ${metrics.inFull.over} over; ${metrics.inFull.underPct}% under to ${metrics.inFull.overPct}% over counts as in full${metrics.inFull.pending ? `; ${metrics.inFull.pending} still able to arrive left out` : ""})`],
      ["On time and in full (OTIF)", `${percent(metrics.otif.value, 0)} (${metrics.otif.otif} of ${metrics.otif.lines} order lines)`],
    ] : []),
    ["Non-conformances", `${metrics.ncs.total} (${metrics.ncs.critical} critical, ${metrics.ncs.major} major, ${metrics.ncs.minor} minor; ${metrics.ncs.repeat} repeat)`],
    ["Corrective action requests", `${metrics.scars.issued} issued (${metrics.scars.answered_on_time} on time, ${metrics.scars.answered_late} late, ${metrics.scars.overdue_now} overdue)`],
    ["Certifications", `${metrics.certs.current} current (${metrics.certs.expired} expired, ${metrics.certs.expiring_soon} expiring within 60 days)`],
  ];
  return (
    <table className="w-full text-left text-sm" aria-label="Figures">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k} className="border-t border-border-color first:border-t-0">
            <th scope="row" className="w-48 py-1.5 pr-3 align-top font-medium text-secondary-text">{k}</th>
            <td className="py-1.5 text-primary-text">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/** A small line of past scores, oldest to newest (scorecards without a score are skipped). */
export const Trend = ({ cards }) => {
  const pts = [...cards].reverse().filter((c) => c.score !== null);
  if (pts.length < 2) return null;
  const w = 220;
  const h = 48;
  const xs = (i) => 4 + (i * (w - 8)) / (pts.length - 1);
  const ys = (s) => h - 4 - (s / 100) * (h - 8);
  return (
    <svg role="img" aria-label={`Score trend: ${pts.map((p) => Math.round(p.score)).join(", ")}`} width={w} height={h} className="text-brand-primary">
      <polyline fill="none" stroke="currentColor" strokeWidth="2" points={pts.map((p, i) => `${xs(i)},${ys(p.score)}`).join(" ")} />
      {pts.map((p, i) => <circle key={p.id} cx={xs(i)} cy={ys(p.score)} r="3" fill="currentColor" />)}
    </svg>
  );
};
