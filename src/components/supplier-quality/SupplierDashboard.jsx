import { Link } from "react-router-dom";
import { format } from "date-fns";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowRightIcon, CircleCheckIcon, ClipboardListIcon, ClockIcon, FileTextIcon, HourglassIcon, ShieldAlertIcon, TriangleAlertIcon, TruckIcon, UsersIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import { DashboardPeriodPicker } from "../dashboard/DashboardPeriod";
import { Card, ChartTooltip, grid, percent, stackedBarShape, tick } from "../dashboard/DashboardParts";
import { useDashboardPeriod } from "../../hooks/useDashboardPeriod";
import { useSupplierDashboard } from "../../hooks/useSupplierPerformance";
import { describeApiError } from "../../lib/api-client";
import { NCR_REGISTER } from "../../lib/ncr";
import { formatDate } from "../../lib/processControl";
import { BAND, formatScore } from "../../lib/supplierPerformance";
import { RISK_RATINGS, SUPPLIER_STATUSES } from "../../lib/supplierQuality";
import { SCAR_REGISTER, SCAR_STATUSES, scarPath } from "../../lib/supplierScars";
import Callout from "../ui/Callout";
import { BandPill } from "./PerformanceParts";
import { RiskBadge } from "./SupplierBadges";
import { ACCENT, ArcGauge, Chip, Initial, Meter, Pipeline, ScoreRing, SplitBar, StatTile, Tile } from "./SupplierDashboardParts";

const NC_SERIES = [
  { key: "critical", label: "Critical", color: "var(--chart-critical)" },
  { key: "major", label: "Major", color: "var(--chart-serious)" },
  { key: "minor", label: "Minor", color: "var(--chart-warning)" },
  { key: "unclassified", label: "No severity yet", color: "var(--chart-neutral)" },
];
const DELIVERY_SERIES = [
  { key: "accepted", label: "Accepted", color: "var(--chart-series-3)" },
  { key: "undecided", label: "Waiting for a decision", color: "var(--chart-neutral)" },
  { key: "rejected", label: "Rejected", color: "var(--chart-critical)" },
];
const RISK_COLOUR = { low: "var(--chart-series-3)", medium: "var(--chart-warning)", high: "var(--chart-serious)", critical: "var(--chart-critical)", none: "var(--chart-neutral)" };
const BAND_COLOUR = { good: "var(--chart-series-3)", watch: "var(--chart-warning)", poor: "var(--chart-critical)", insufficient: "var(--chart-neutral)" };
const STATUS_COLOUR = { approved: "var(--chart-series-3)", conditional: "var(--chart-series-1)", pending_approval: "var(--chart-warning)", suspended: "var(--chart-serious)", disqualified: "var(--chart-critical)", archived: "var(--chart-neutral)" };

const th = "py-1 pr-3 text-left text-xs font-medium uppercase tracking-wide";
const td = "py-2 pr-3 align-middle";
const Empty = ({ children }) => <p className="py-6 text-center text-sm text-secondary-text">{children}</p>;
const linkClass = "inline-flex min-h-9.5 shrink-0 items-center whitespace-nowrap rounded-lg border border-border-color bg-secondary-bg px-3 py-1.5 text-sm text-primary-text hover:bg-border-color/50";
const nameLink = "font-medium text-primary-text hover:underline";
const supplierPath = (id, tab) => `/Suppliers/${id}${tab ? `?tab=${tab}` : ""}`;
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const daysWords = (days) => (days < 0 ? `${plural(-days, "day")} ago` : days === 0 ? "today" : `in ${plural(days, "day")}`);
const number = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("en-GB"));

/** Counts per week or month, stacked. Its legend is the split bar above it (same colours, same order), so the chart carries none of its own. */
const StackedBars = ({ data, series, label, bucketLabel }) => (
  <div className="h-56">
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="20%" aria-label={label}>
        <CartesianGrid {...grid} />
        <XAxis dataKey="start" tickFormatter={bucketLabel} tick={tick} axisLine={false} tickLine={false} minTickGap={12} />
        <YAxis allowDecimals={false} tick={tick} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={<ChartTooltip labelFormat={bucketLabel} />} />
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} stackId="s" fill={s.color} stroke="rgb(var(--secondary-bg))" strokeWidth={2} shape={stackedBarShape(series.map((x) => x.key))} maxBarSize={24} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  </div>
);
/** The period's totals of a stacked series, as the parts of a split bar. */
const totals = (trend, series) => series.map((s) => ({ key: s.key, label: s.label, color: s.color, count: trend.reduce((n, b) => n + (b[s.key] ?? 0), 0) }));
const cardLink = "inline-flex items-center gap-1 whitespace-nowrap text-sm text-link-color hover:underline";
const row = "flex items-center gap-3 py-2";

/**
 * Supplier quality dashboard (`/Supplier-Quality`): the supplier base as of today (approval, risk, records expiring, corrective action requests) and, for the
 * period in the address, supplier non-conformances, deliveries and performance. Performance is each supplier's own score added up, so it agrees with the
 * Performance tab, scorecards and the watchlist. Sections the person may not read say so instead of showing zeros.
 */
const SupplierDashboard = () => {
  const period = useDashboardPeriod("90d");
  const { fromIso: from, toIso: to } = period;
  const { data, isLoading, isFetching, error } = useSupplierDashboard({ from, to });
  const k = data?.kpis;
  const perf = data?.performance;
  const rec = data?.receiving;
  const ncs = data?.ncs;
  const bucketLabel = (start) => format(new Date(`${start}T00:00:00`), data?.period.bucket === "month" ? "MMM yy" : "d MMM");
  const per = data?.period.bucket ?? "week";

  const statusParts = SUPPLIER_STATUSES.map((s) => ({ key: s.key, label: s.label, color: STATUS_COLOUR[s.key], count: data?.byStatus.find((x) => x.key === s.key)?.count ?? 0 }));
  const riskParts = (data?.byRisk ?? []).map((r) => ({ key: r.key, label: r.key === "none" ? "Not assessed" : (RISK_RATINGS.find((x) => x.id === r.key)?.name ?? r.key), color: RISK_COLOUR[r.key], count: r.count }));
  const bandParts = (perf?.bands ?? []).map((b) => ({ key: b.key, label: BAND[b.key].label, color: BAND_COLOUR[b.key], count: b.count }));
  const scarSteps = (data?.scarsByStatus ?? []).map((s) => ({ key: s.key, label: SCAR_STATUSES.find((x) => x.key === s.key)?.label ?? s.key, count: s.count }));
  const mostNcs = Math.max(1, ...(ncs?.bySupplier ?? []).map((s) => s.count));

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <TruckIcon className="h-6 w-6" aria-hidden="true" />
            Supplier quality dashboard
          </h1>
          <p className="text-sm text-secondary-text" aria-live="polite">
            Deliveries, non-conformances and performance {formatDate(from)} – {formatDate(to)} · approval, risk and expiry as of today
            {isFetching && !isLoading ? " · updating…" : ""}
          </p>
        </div>
        <div className="flex flex-nowrap items-end gap-3 max-sm:flex-wrap">
          <Link to="/Suppliers" className={linkClass}>
            Supplier register
          </Link>
          {perf?.available && (
            <Link to="/Supplier-Quality/Watchlist" className={linkClass}>
              Watchlist
            </Link>
          )}
          <DashboardPeriodPicker period={period} />
        </div>
      </div>

      {error && (
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      )}

      {/* The supplier base beside how deliveries went. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12" aria-busy={isLoading || undefined}>
        <section
          aria-label="Supplier base"
          data-tile="Suppliers"
          className="relative flex min-w-0 flex-col justify-between gap-5 overflow-hidden rounded-3xl border border-border-color bg-secondary-bg p-6 xl:col-span-5"
          style={{ backgroundImage: `linear-gradient(135deg, color-mix(in srgb, ${ACCENT} 18%, transparent), transparent 62%)` }}>
          <svg aria-hidden="true" viewBox="0 0 200 200" className="pointer-events-none absolute -right-14 -top-16 h-64 w-64" style={{ color: ACCENT }}>
            <circle cx="100" cy="100" r="96" fill="none" stroke="currentColor" strokeOpacity="0.14" strokeWidth="1.5" />
            <circle cx="100" cy="100" r="68" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.5" />
            <circle cx="100" cy="100" r="40" fill="currentColor" fillOpacity="0.08" />
          </svg>
          <div className="relative flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-2 text-sm text-secondary-text">
                <UsersIcon className="h-4 w-4" aria-hidden="true" />
                Suppliers
              </span>
              <p className="text-6xl font-semibold leading-none text-primary-text">{k ? k.suppliers : "—"}</p>
              <p className="text-sm text-secondary-text">{k ? `${k.approved} approved · ${k.pendingApproval} pending approval` : "In use, as of today"}</p>
            </div>
            <Link to="/Suppliers" className={`${cardLink} relative`}>
              Supplier register <ArrowRightIcon aria-hidden="true" />
            </Link>
          </div>
          <div className="relative flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-primary-text">Approval status</h2>
            {statusParts.some((s) => s.count) ? <SplitBar parts={statusParts} label="Approval status" tall /> : <Empty>No suppliers yet.</Empty>}
          </div>
        </section>

        {rec && !rec.available ? (
          <div className="xl:col-span-7">
            <Callout tone="info" title="Deliveries and performance are not shown">
              On-time delivery, PPM, rejections and the performance bands come from goods receiving, which you may not read.
            </Callout>
          </div>
        ) : (
          <Card title="Delivery performance" subtitle={`Every supplier's own figures added up, ${formatDate(from)} – ${formatDate(to)}`} className="rounded-3xl xl:col-span-7">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <ArcGauge
                label="On-time delivery"
                value={perf?.otdPercent ?? null}
                display={perf ? percent(perf.otdPercent) : "—"}
                note={perf ? `${perf.onTimeLines} of ${plural(perf.matchedLines, "delivered line")} against an order` : ""}
              />
              <ArcGauge label="In full" value={perf?.inFullPercent ?? null} display={perf ? percent(perf.inFullPercent) : "—"} note="Order lines due in the period, within tolerance" />
              <Tile label="PPM (rejected)" className="justify-between bg-primary-bg/50">
                <span className="text-sm text-secondary-text">PPM (rejected)</span>
                <p className={`text-3xl font-semibold ${perf?.ppm > 0 ? "text-error-color" : "text-primary-text"}`}>{perf ? number(perf.ppm) : "—"}</p>
                <Meter part={perf?.rejectedUnits ?? 0} whole={perf?.receivedUnits ?? 0} color="var(--chart-critical)" label="Units rejected, of units received" />
                <p className="min-h-4 text-xs text-secondary-text">{perf ? `${number(perf.rejectedUnits)} of ${number(perf.receivedUnits)} units received` : ""}</p>
              </Tile>
              <Tile label="Lines rejected" className="justify-between bg-primary-bg/50">
                <span className="text-sm text-secondary-text">Lines rejected</span>
                <p className={`text-3xl font-semibold ${rec?.rejectedLines > 0 ? "text-error-color" : "text-primary-text"}`}>{rec ? percent(rec.lotRejectionPercent) : "—"}</p>
                <Meter part={rec?.rejectedLines ?? 0} whole={rec?.lines ?? 0} color="var(--chart-critical)" label="Lines rejected, of lines delivered" />
                <p className="min-h-4 text-xs text-secondary-text">{rec ? `${rec.rejectedLines} of ${plural(rec.lines, "delivered line")} (not PPM)` : ""}</p>
              </Tile>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Tile label="Waiting for a decision" to="/Supplier-Quality/Goods-Receipts" className="flex-row items-center gap-3 bg-primary-bg/50 py-3">
                <HourglassIcon className="h-5 w-5 shrink-0 text-secondary-text" aria-hidden="true" />
                <span className="text-2xl font-semibold text-primary-text">{rec ? rec.awaitingDecision : "—"}</span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm text-primary-text">Waiting for a decision</span>
                  <span className="text-xs text-secondary-text">{rec ? `Received lines to inspect or decide · ${plural(rec.certificatesToReview, "certificate")} to review` : ""}</span>
                </span>
              </Tile>
              <Tile label="Late order lines" to="/Supplier-Quality/Purchase-Orders?filter=late" className="flex-row items-center gap-3 bg-primary-bg/50 py-3">
                <ClockIcon className={`h-5 w-5 shrink-0 ${rec?.lateOrderLines > 0 ? "text-error-color" : "text-secondary-text"}`} aria-hidden="true" />
                <span className={`text-2xl font-semibold ${rec?.lateOrderLines > 0 ? "text-error-color" : "text-primary-text"}`}>{rec ? rec.lateOrderLines : "—"}</span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm text-primary-text">Late order lines</span>
                  <span className="text-xs text-secondary-text">Open lines past their date, as of today</span>
                </span>
              </Tile>
            </div>
          </Card>
        )}
      </div>

      {/* What needs somebody, as of today. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-busy={isLoading || undefined}>
        <StatTile icon={CircleCheckIcon} label="Approvals waiting" value={k ? k.approvalsWaiting : "—"} note="Proposed, waiting for a second person to decide" alert={k?.approvalsWaiting > 0} />
        <StatTile
          icon={ShieldAlertIcon}
          label="High or critical risk"
          value={k ? k.highRisk : "—"}
          note={k ? `${k.riskNotAssessed} not assessed · ${plural(k.riskReviewsOverdue, "review")} overdue` : ""}
          to="/Suppliers?risk=high,critical"
          alert={k?.highRisk > 0}
        />
        <StatTile
          icon={FileTextIcon}
          label="Expired records"
          value={k ? k.expired : "—"}
          note={k ? `Certifications and documents · ${k.expiring} expiring within 60 days` : ""}
          to="/Supplier-Quality/Expiry"
          alert={k?.expired > 0}
        />
        <StatTile
          icon={ClipboardListIcon}
          label="Open corrective actions"
          value={k ? k.openScars : "—"}
          note={k ? `${k.overdueScars} with a response overdue` : ""}
          to={k?.overdueScars ? `${SCAR_REGISTER}?filter=overdue` : SCAR_REGISTER}
          alert={k?.overdueScars > 0}>
          {k?.openScars > 0 && <Meter part={k.overdueScars} whole={k.openScars} color="var(--chart-critical)" label="Requests with a response overdue, of those running" />}
        </StatTile>
        <StatTile
          icon={TriangleAlertIcon}
          label="Open supplier NCs"
          value={ncs?.available ? ncs.open : "—"}
          note={!ncs ? "" : ncs.available ? `${ncs.raised} raised in the period` : "You may not read non-conformances"}
        />
      </div>

      {(rec?.available || ncs?.available) && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {rec?.available && (
            <Card title="Deliveries" subtitle={`Delivered lines per ${per}, by the latest decision on each`} className={ncs?.available ? "" : "xl:col-span-2"}>
              {rec.trend.length ? (
                <>
                  <SplitBar parts={totals(rec.trend, DELIVERY_SERIES)} label="Delivered lines in the period" unit="line" showZero />
                  <StackedBars data={rec.trend} series={DELIVERY_SERIES} label="Delivered lines per period" bucketLabel={bucketLabel} />
                </>
              ) : (
                <Empty>Nothing was delivered in this period.</Empty>
              )}
            </Card>
          )}
          {ncs?.available && (
            <Card title="Supplier non-conformances" subtitle={`Raised per ${per} against a supplier, by severity`} className={rec?.available ? "" : "xl:col-span-2"}>
              {ncs.trend.length ? (
                <>
                  <SplitBar parts={totals(ncs.trend, NC_SERIES)} label="Non-conformances raised in the period" unit="non-conformance" showZero />
                  <StackedBars data={ncs.trend} series={NC_SERIES} label="Supplier non-conformances per period" bucketLabel={bucketLabel} />
                </>
              ) : (
                <Empty>No non-conformance named a supplier in this period.</Empty>
              )}
            </Card>
          )}
        </div>
      )}

      {(perf?.available || ncs?.available) && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
          {perf?.available && (
            <Card
              title="Suppliers needing attention"
              subtitle="Scored poor or watch over the period, or carrying a warning; worst first"
              action={
                <Link to="/Supplier-Quality/Watchlist" className={cardLink}>
                  Watchlist <ArrowRightIcon aria-hidden="true" />
                </Link>
              }
              className={ncs?.available ? "xl:col-span-7" : "xl:col-span-12"}>
              {perf.truncated && <Callout tone="info">Only the first {perf.scored} suppliers by code are scored here.</Callout>}
              {perf.attention.length ? (
                <table className="w-full text-sm" aria-label="Suppliers needing attention">
                  <thead className="text-secondary-text">
                    <tr>
                      <th className={th}>Score</th>
                      <th className={th}>Supplier</th>
                      <th className={th}>Band</th>
                      <th className={th}>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {perf.attention.map((s) => (
                      <tr key={s.id} className="border-t border-border-color">
                        <td className={`${td} w-14`}>
                          <span className="sr-only">{formatScore(s.score)}</span>
                          <span aria-hidden="true">
                            <ScoreRing score={s.score} color={BAND_COLOUR[s.band]} />
                          </span>
                        </td>
                        <td className={td}>
                          <Link to={supplierPath(s.id, "performance")} className={nameLink}>
                            {s.name}
                          </Link>
                          <span className="block text-xs text-secondary-text">{s.code}</span>
                        </td>
                        <td className={td}>
                          <BandPill band={s.band} />
                        </td>
                        <td className={`${td} text-secondary-text`}>
                          {s.reason ?? "—"}
                          {s.warnings > 1 ? ` · and ${s.warnings - 1} more` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty>No supplier is scored poor or watch, and none carries a warning.</Empty>
              )}
            </Card>
          )}
          {ncs?.available && (
            <Card title="Non-conformances by supplier" subtitle="Most raised in the period (top 8); the red part is critical" className={perf?.available ? "xl:col-span-5" : "xl:col-span-12"}>
              {ncs.bySupplier.length ? (
                <table className="w-full text-sm" aria-label="Non-conformances by supplier">
                  <thead className="text-secondary-text">
                    <tr>
                      <th className={th}>Supplier</th>
                      <th className={th}>
                        <span className="sr-only">Share of the most raised</span>
                      </th>
                      <th className={th}>Raised</th>
                      <th className={th}>Critical</th>
                      <th className={th} />
                    </tr>
                  </thead>
                  <tbody>
                    {ncs.bySupplier.map((s) => (
                      <tr key={s.id} className="border-t border-border-color">
                        <td className={td}>
                          <Link to={supplierPath(s.id, "nonconformities")} className={nameLink}>
                            {s.name}
                          </Link>
                        </td>
                        <td className={`${td} w-1/3`} aria-hidden="true">
                          <span className="flex h-2.5 gap-0.5" style={{ width: `${(s.count / mostNcs) * 100}%`, minWidth: 6 }}>
                            {s.critical > 0 && <span className="h-full rounded-full" style={{ flexGrow: s.critical, flexBasis: 0, background: "var(--chart-critical)" }} />}
                            {s.count - s.critical > 0 && <span className="h-full rounded-full" style={{ flexGrow: s.count - s.critical, flexBasis: 0, background: "var(--chart-neutral)" }} />}
                          </span>
                        </td>
                        <td className={`${td} tabular-nums`}>{s.count}</td>
                        <td className={`${td} tabular-nums ${s.critical ? "text-error-color" : "text-secondary-text"}`}>{s.critical}</td>
                        <td className={`${td} text-right`}>
                          <Link to={`${NCR_REGISTER}?supplier=${s.id}&supplierLabel=${encodeURIComponent(s.name)}`} className="whitespace-nowrap text-link-color hover:underline">
                            In the register
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty>No non-conformance named a supplier in this period.</Empty>
              )}
            </Card>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {perf?.available && (
          <Card title="Performance bands" subtitle={`${plural(perf.scored, "supplier")} scored over the period with the current scoring model`}>
            {perf.scored ? <SplitBar parts={bandParts} label="Performance bands" tall showZero /> : <Empty>No suppliers to score.</Empty>}
          </Card>
        )}
        <Card title="Risk" subtitle="The latest risk rating of each supplier in use" className={perf?.available ? "" : "xl:col-span-2"}>
          {riskParts.some((r) => r.count) ? <SplitBar parts={riskParts} label="Risk" tall showZero /> : <Empty>No suppliers yet.</Empty>}
        </Card>
      </div>


      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <Card
          title="Corrective action requests"
          subtitle="Running requests, by where each one stands"
          action={
            <Link to={SCAR_REGISTER} className={cardLink}>
              All requests <ArrowRightIcon aria-hidden="true" />
            </Link>
          }
          className="xl:col-span-7">
          {scarSteps.some((s) => s.count) ? <Pipeline steps={scarSteps} label="Corrective action requests by status" /> : <Empty>No corrective action request is running.</Empty>}
        </Card>
        <Card title="Responses overdue" subtitle="Corrective action requests past the date the supplier was to answer by" className="xl:col-span-5">
          {data?.overdueScarList.length ? (
            <ul aria-label="Corrective action requests overdue" className="flex flex-col divide-y divide-border-color text-sm">
              {data.overdueScarList.map((s) => (
                <li key={s.id} className={`${row} flex-wrap justify-between`}>
                  <span className="flex min-w-0 items-center gap-2">
                    <Initial name={s.supplier.name} />
                    <span className="flex min-w-0 flex-col">
                      <Link to={scarPath(s.id)} className={nameLink}>
                        {s.reference} · {s.title}
                      </Link>
                      <span className="text-xs text-secondary-text">{s.supplier.name}</span>
                    </span>
                  </span>
                  <Chip tone="error">
                    Due {formatDate(s.dueOn)} ({plural(s.daysOverdue, "day")} overdue)
                  </Chip>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No response is overdue.</Empty>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-12">
        <Card
          title="Certifications and documents"
          subtitle="Expired, or expiring within 60 days, soonest first"
          action={
            <Link to="/Supplier-Quality/Expiry" className={cardLink}>
              Expiry watchlist <ArrowRightIcon aria-hidden="true" />
            </Link>
          }
          className="md:col-span-2 xl:col-span-6">
          {data?.expiryList.length ? (
            <table className="w-full text-sm" aria-label="Records expiring">
              <thead className="text-secondary-text">
                <tr>
                  <th className={th}>Supplier</th>
                  <th className={th}>Record</th>
                  <th className={th}>Expires</th>
                </tr>
              </thead>
              <tbody>
                {data.expiryList.map((e) => (
                  <tr key={`${e.kind}-${e.id}`} className="border-t border-border-color">
                    <td className={td}>
                      <Link to={supplierPath(e.supplier.id, e.kind === "document" ? "documents" : "qualification")} className={nameLink}>
                        {e.supplier.name}
                      </Link>
                    </td>
                    <td className={td}>
                      {e.title}
                      <span className="block text-xs text-secondary-text">{e.kind === "document" ? "Document" : "Certification"}</span>
                    </td>
                    <td className={td}>
                      <span className="flex flex-wrap items-center gap-2">
                        {formatDate(e.expiresOn)}
                        <Chip tone={e.days < 0 ? "error" : "warning"}>{daysWords(e.days)}</Chip>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Nothing has expired or expires within 60 days.</Empty>
          )}
        </Card>
        <Card title="Approvals waiting" subtitle="Proposed approvals that someone other than the proposer must decide" className="xl:col-span-3">
          {data?.approvalList.length ? (
            <ul aria-label="Approvals waiting" className="flex flex-col divide-y divide-border-color text-sm">
              {data.approvalList.map((a) => (
                <li key={a.id} className={row}>
                  <Initial name={a.supplier.name} />
                  <span className="flex min-w-0 flex-col">
                    <Link to={supplierPath(a.supplier.id, "qualification")} className={nameLink}>
                      {a.supplier.name}
                    </Link>
                    <span className="text-xs text-secondary-text">
                      {a.target === "conditional" ? "Conditional approval" : "Approval"} proposed {formatDate(a.proposedAt.slice(0, 10))}
                      {a.proposedBy ? ` by ${a.proposedBy}` : ""}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No approval is waiting for a decision.</Empty>
          )}
        </Card>
        <Card title="Risk reviews overdue" subtitle="Suppliers whose risk assessment was due to be looked at again" className="xl:col-span-3">
          {data?.riskReviewList.length ? (
            <ul aria-label="Risk reviews overdue" className="flex flex-col divide-y divide-border-color text-sm">
              {data.riskReviewList.map((r) => (
                <li key={r.supplier.id} className={`${row} flex-wrap justify-between`}>
                  <span className="flex flex-wrap items-center gap-2">
                    <Initial name={r.supplier.name} />
                    <Link to={supplierPath(r.supplier.id, "qualification")} className={nameLink}>
                      {r.supplier.name}
                    </Link>
                    <RiskBadge risk={r.rating} />
                  </span>
                  <Chip tone="error">
                    Review was due {formatDate(r.reviewOn)} ({plural(r.daysOverdue, "day")} ago)
                  </Chip>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No risk review is overdue.</Empty>
          )}
        </Card>
      </div>
    </div>
  );
};

export default SupplierDashboard;
