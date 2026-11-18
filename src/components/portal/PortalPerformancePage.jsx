import { useState } from "react";
import { Navigate } from "react-router-dom";
import Callout from "../ui/Callout";
import LoadingScreen from "../ui/LoadingScreen";
import SlidingToggle from "../ui/SlidingToggle";
import { ArcGauge, Chip, Meter, StatTile, Tile } from "../dashboard/DashboardGraphics";
import { GaugeIcon } from "@/components/icons";
import { usePortalPerformance } from "../../hooks/usePortal";
import { describeApiError } from "../../lib/api-client";
import { pctWords, RANK_WORDS, shortDate } from "../../lib/portal";
import { BAND, PERIODS } from "../../lib/supplierPerformance";

/**
 * Your performance (PT4), now the supplier's dashboard (PT6): the figures our Performance tab shows for this supplier, from the same database function, as the database chose to give them.
 * Every figure is also in words, a tile staff switched off simply is not here, and no record or other supplier is named.
 */
export function PerformancePanel({ access }) {
  const [days, setDays] = useState("90");
  const perf = usePortalPerformance(access.organisationId, Number(days), { enabled: !access.mfaRequired && access.partyKind === "supplier" });

  if (access.partyKind !== "supplier") return <Callout tone="info">Performance is shown to suppliers.</Callout>;
  if (perf.isLoading) return <LoadingScreen />;
  if (perf.error) return <Callout tone="error" role="alert">{describeApiError(perf.error)}</Callout>;
  const p = perf.data;
  const band = BAND[p.score?.band ?? "insufficient"];

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Your performance</h2>
          <p className="text-sm text-secondary-text">
            {shortDate(p.period.from)} to {shortDate(p.period.to)}, as {access.organisationName} measures it.
          </p>
        </div>
        <SlidingToggle ariaLabel="Period" options={PERIODS} value={days} onChange={setDays} />
      </header>

      {p.score && (
        <StatTile
          icon={GaugeIcon}
          label="Overall score"
          value={p.score.value === null || p.score.value === undefined ? "No score yet" : Math.round(p.score.value)}
          note={p.score.value === null || p.score.value === undefined ? "There is not enough delivery history in this period to score." : "Out of 100"}>
          <span className={`w-fit rounded-full px-2 py-0.5 text-xs font-medium ${band.tone}`}>{band.label}</span>
        </StatTile>
      )}
      {p.ranking && (
        <Callout tone="info" title="Where you stand">
          {p.ranking.band ? RANK_WORDS[p.ranking.band] : p.ranking.enough ? "No position yet, because you have no score in this period." : "A position is shown once enough suppliers have a score."}
        </Callout>
      )}

      {p.delivery && (
        <section aria-labelledby="perf-delivery" className="flex flex-col gap-3">
          <h2 id="perf-delivery" className="text-lg font-semibold">Delivery</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <ArcGauge
              label="On time"
              value={p.delivery.onTime.value === null ? null : p.delivery.onTime.value * 100}
              display={pctWords(p.delivery.onTime.value)}
              note={`${p.delivery.onTime.onTime} of ${p.delivery.onTime.lines} delivered lines on time (${p.delivery.onTime.late} late, ${p.delivery.onTime.early ?? 0} early)`}
            />
            <ArcGauge
              label="In full"
              value={p.delivery.inFull.value === null ? null : p.delivery.inFull.value * 100}
              display={pctWords(p.delivery.inFull.value)}
              note={`${p.delivery.inFull.inFull} of ${p.delivery.inFull.lines} order lines in full (${p.delivery.inFull.short} short, ${p.delivery.inFull.over} over)`}
            />
          </div>
          <p className="text-sm text-secondary-text">On time and in full together: {pctWords(p.delivery.otif.value)}</p>
        </section>
      )}

      {p.quality && (
        <section aria-labelledby="perf-quality" className="flex flex-col gap-3">
          <h2 id="perf-quality" className="text-lg font-semibold">Quality of what you delivered</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <Tile label="PPM, rejected at receiving">
              <span className="text-sm text-secondary-text">PPM, rejected at receiving</span>
              <p className="text-3xl font-semibold">{p.quality.ppm.value ?? "—"}</p>
              <p className="text-xs text-secondary-text">{p.quality.ppm.rejectedUnits ?? 0} of {p.quality.ppm.receivedUnits ?? 0} units rejected</p>
            </Tile>
            <Tile label="PPM, non-conformances">
              <span className="text-sm text-secondary-text">PPM, non-conformances</span>
              <p className="text-3xl font-semibold">{p.quality.ppmNc.value ?? "—"}</p>
              <p className="text-xs text-secondary-text">{p.quality.ppmNc.affectedUnits ?? 0} of {p.quality.ppmNc.receivedUnits ?? 0} units affected</p>
            </Tile>
            <Tile label="Lots rejected">
              <span className="text-sm text-secondary-text">Lots rejected</span>
              <p className="text-3xl font-semibold">{pctWords(p.quality.lotRejection.rate)}</p>
              <Meter part={p.quality.lotRejection.rejectedLines} whole={p.quality.lotRejection.lines} color="var(--chart-danger, #dc2626)" label="Share of delivered lines rejected" />
              <p className="text-xs text-secondary-text">{p.quality.lotRejection.rejectedLines} of {p.quality.lotRejection.lines} delivered lines</p>
            </Tile>
          </div>
        </section>
      )}

      {(p.ncs || p.scars || p.certs) && (
        <section aria-labelledby="perf-open" className="flex flex-col gap-3">
          <h2 id="perf-open" className="text-lg font-semibold">Quality matters</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {p.ncs && (
              <Tile label="Non-conformances">
                <span className="text-sm text-secondary-text">Non-conformances in this period</span>
                <p className="text-3xl font-semibold">{p.ncs.total}</p>
                <p className="flex flex-wrap gap-1 text-xs"><Chip>{p.ncs.critical} critical</Chip><Chip>{p.ncs.major} major</Chip><Chip>{p.ncs.minor} minor</Chip></p>
                {p.ncs.repeat > 0 && <p className="text-xs text-secondary-text">{p.ncs.repeat} on a part that has had more than one</p>}
              </Tile>
            )}
            {p.scars && (
              <Tile label="Corrective action requests">
                <span className="text-sm text-secondary-text">Corrective action requests</span>
                <p className="text-3xl font-semibold">{p.scars.issued}</p>
                <p className="text-xs text-secondary-text">
                  {p.scars.answeredOnTime} answered on time, {p.scars.answeredLate} late. {p.scars.awaitingYou} waiting for you
                  {p.scars.overdueNow > 0 ? `, ${p.scars.overdueNow} overdue` : ""}.
                </p>
              </Tile>
            )}
            {p.certs && (
              <Tile label="Certifications">
                <span className="text-sm text-secondary-text">Certifications on file</span>
                <p className="text-3xl font-semibold">{p.certs.current}</p>
                <p className="text-xs text-secondary-text">{p.certs.expired} expired, {p.certs.expiringSoon} expiring within 60 days</p>
              </Tile>
            )}
          </div>
        </section>
      )}

      {p.trend && (
        <section aria-labelledby="perf-trend" className="flex flex-col gap-2 rounded-2xl border border-border-color bg-secondary-bg p-4">
          <h2 id="perf-trend" className="text-lg font-semibold">Monthly trend</h2>
          {p.trend.length === 0 ? (
            <p className="text-sm text-secondary-text">Monthly scores will appear here once {access.organisationName} has saved them.</p>
          ) : (
            <ul aria-label="Monthly scores" className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {p.trend.map((m) => (
                <li key={m.to} className="flex flex-col rounded-xl border border-border-color px-3 py-2 text-sm">
                  <span className="text-xs text-secondary-text">{shortDate(m.to)}</span>
                  <span className="font-semibold">{m.score === null ? "—" : Math.round(m.score)}</span>
                  <span className="text-xs text-secondary-text">{BAND[m.band]?.label}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/** The old address of the performance page: it is the dashboard now. */
export default function PortalPerformancePage() {
  return <Navigate to="/portal" replace />;
}
