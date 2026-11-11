import { Link } from "react-router-dom";
import { format } from "date-fns";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CircleCheckIcon, ClipboardListIcon, ClockIcon, FileTextIcon, HourglassIcon, PackageIcon, ShieldAlertIcon, TriangleAlertIcon, TruckIcon, UsersIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import { DashboardPeriodPicker } from "../dashboard/DashboardPeriod";
import { Card, ChartTooltip, HBars, Kpi, grid, percent, stackedBarShape, tick } from "../dashboard/DashboardParts";
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

const th = "py-1 pr-2 text-left font-medium";
const td = "py-1.5 pr-2 align-top";
const Empty = ({ children }) => <p className="py-6 text-center text-sm text-secondary-text">{children}</p>;
const linkClass = "inline-flex min-h-9.5 shrink-0 items-center whitespace-nowrap rounded-lg border border-border-color bg-secondary-bg px-3 py-1.5 text-sm text-primary-text hover:bg-border-color/50";
const nameLink = "font-medium text-primary-text hover:underline";
const supplierPath = (id, tab) => `/Suppliers/${id}${tab ? `?tab=${tab}` : ""}`;
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const daysWords = (days) => (days < 0 ? `${plural(-days, "day")} ago` : days === 0 ? "today" : `in ${plural(days, "day")}`);
const number = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("en-GB"));

const StackedBars = ({ data, series, label, bucketLabel }) => (
  <div className="h-72">
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="20%" aria-label={label}>
        <CartesianGrid {...grid} />
        <XAxis dataKey="start" tickFormatter={bucketLabel} tick={tick} axisLine={false} tickLine={false} minTickGap={12} />
        <YAxis allowDecimals={false} tick={tick} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={<ChartTooltip labelFormat={bucketLabel} />} />
        <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-secondary-text">{v}</span>} />
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} stackId="s" fill={s.color} stroke="rgb(var(--secondary-bg))" strokeWidth={1} shape={stackedBarShape(series.map((x) => x.key))} maxBarSize={36} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  </div>
);

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

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-busy={isLoading || undefined}>
        <Kpi icon={UsersIcon} label="Suppliers" value={k ? k.suppliers : "—"} note={k ? `${k.approved} approved · ${k.pendingApproval} pending approval` : ""} to="/Suppliers" />
        <Kpi
          icon={CircleCheckIcon}
          label="Approvals waiting"
          value={k ? k.approvalsWaiting : "—"}
          note="Proposed, waiting for a second person to decide"
          alert={k?.approvalsWaiting > 0}
        />
        <Kpi
          icon={ShieldAlertIcon}
          label="High or critical risk"
          value={k ? k.highRisk : "—"}
          note={k ? `${k.riskNotAssessed} not assessed · ${plural(k.riskReviewsOverdue, "review")} overdue` : ""}
          to="/Suppliers?risk=high,critical"
          alert={k?.highRisk > 0}
        />
        <Kpi
          icon={FileTextIcon}
          label="Expired records"
          value={k ? k.expired : "—"}
          note={k ? `Certifications and documents · ${k.expiring} expiring within 60 days` : ""}
          to="/Supplier-Quality/Expiry"
          alert={k?.expired > 0}
        />
        <Kpi
          icon={ClipboardListIcon}
          label="Open corrective actions"
          value={k ? k.openScars : "—"}
          note={k ? `${k.overdueScars} with a response overdue` : ""}
          to={k?.overdueScars ? `${SCAR_REGISTER}?filter=overdue` : SCAR_REGISTER}
          alert={k?.overdueScars > 0}
        />
        <Kpi
          icon={TriangleAlertIcon}
          label="Open supplier NCs"
          value={ncs?.available ? ncs.open : "—"}
          note={!ncs ? "" : ncs.available ? `${ncs.raised} raised in the period` : "You may not read non-conformances"}
        />
      </div>

      {rec && !rec.available ? (
        <Callout tone="info" title="Deliveries and performance are not shown">
          On-time delivery, PPM, rejections and the performance bands come from goods receiving, which you may not read.
        </Callout>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-busy={isLoading || undefined}>
          <Kpi
            icon={ClockIcon}
            label="On-time delivery"
            value={perf ? percent(perf.otdPercent) : "—"}
            note={perf ? `${perf.onTimeLines} of ${plural(perf.matchedLines, "delivered line")} against an order` : ""}
          />
          <Kpi icon={TruckIcon} label="In full" value={perf ? percent(perf.inFullPercent) : "—"} note="Order lines due in the period, within tolerance" />
          <Kpi
            icon={TriangleAlertIcon}
            label="PPM (rejected)"
            value={perf ? number(perf.ppm) : "—"}
            note={perf ? `${number(perf.rejectedUnits)} of ${number(perf.receivedUnits)} units received` : ""}
            alert={perf?.ppm > 0}
          />
          <Kpi
            icon={PackageIcon}
            label="Lines rejected"
            value={rec ? percent(rec.lotRejectionPercent) : "—"}
            note={rec ? `${rec.rejectedLines} of ${plural(rec.lines, "delivered line")} (not PPM)` : ""}
            alert={rec?.rejectedLines > 0}
          />
          <Kpi
            icon={HourglassIcon}
            label="Waiting for a decision"
            value={rec ? rec.awaitingDecision : "—"}
            note={rec ? `Received lines to inspect or decide · ${plural(rec.certificatesToReview, "certificate")} to review` : ""}
            to="/Supplier-Quality/Goods-Receipts"
          />
          <Kpi
            icon={ClockIcon}
            label="Late order lines"
            value={rec ? rec.lateOrderLines : "—"}
            note="Open lines past their date, as of today"
            to="/Supplier-Quality/Purchase-Orders?filter=late"
            alert={rec?.lateOrderLines > 0}
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {perf?.available && (
          <Card
            title="Suppliers needing attention"
            subtitle="Scored poor or watch over the period, or carrying a warning; worst first"
            action={<Link to="/Supplier-Quality/Watchlist" className="text-sm text-link-color hover:underline">Watchlist</Link>}
            className="xl:col-span-2">
            {perf.truncated && <Callout tone="info">Only the first {perf.scored} suppliers by code are scored here.</Callout>}
            {perf.attention.length ? (
              <table className="w-full text-sm" aria-label="Suppliers needing attention">
                <thead className="text-secondary-text">
                  <tr>
                    <th className={th}>Supplier</th>
                    <th className={th}>Band</th>
                    <th className={th}>Score</th>
                    <th className={th}>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {perf.attention.map((s) => (
                    <tr key={s.id} className="border-t border-border-color">
                      <td className={td}>
                        <Link to={supplierPath(s.id, "performance")} className={nameLink}>
                          {s.name}
                        </Link>{" "}
                        <span className="text-xs text-secondary-text">{s.code}</span>
                      </td>
                      <td className={td}>
                        <BandPill band={s.band} />
                      </td>
                      <td className={td}>{formatScore(s.score)}</td>
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

        <Card title="Approval status" subtitle="Active suppliers, as of today">
          {data?.byStatus.some((s) => s.count) ? (
            <HBars
              data={SUPPLIER_STATUSES.map((s) => ({ key: s.key, label: s.label, count: data.byStatus.find((x) => x.key === s.key)?.count ?? 0 })).filter((s) => s.count > 0)}
              colorOf={(d) => STATUS_COLOUR[d.key]}
              name="Suppliers"
              labelWidth={150}
            />
          ) : (
            <Empty>No suppliers yet.</Empty>
          )}
        </Card>

        <Card title="Risk" subtitle="The latest risk rating of each supplier in use">
          {data?.byRisk.some((r) => r.count) ? (
            <HBars
              data={data.byRisk.map((r) => ({ key: r.key, label: r.key === "none" ? "Not assessed" : (RISK_RATINGS.find((x) => x.id === r.key)?.name ?? r.key), count: r.count }))}
              colorOf={(d) => RISK_COLOUR[d.key]}
              name="Suppliers"
              height={190}
              labelWidth={110}
            />
          ) : (
            <Empty>No suppliers yet.</Empty>
          )}
        </Card>

        {perf?.available && (
          <Card title="Performance bands" subtitle={`${plural(perf.scored, "supplier")} scored over the period with the current scoring model`}>
            {perf.scored ? (
              <HBars data={perf.bands.map((b) => ({ key: b.key, label: BAND[b.key].label, count: b.count }))} colorOf={(d) => BAND_COLOUR[d.key]} name="Suppliers" height={190} labelWidth={130} />
            ) : (
              <Empty>No suppliers to score.</Empty>
            )}
          </Card>
        )}

        {rec?.available && (
          <Card title="Deliveries" subtitle={`Delivered lines per ${per}, by the latest decision on each`}>
            {rec.trend.length ? <StackedBars data={rec.trend} series={DELIVERY_SERIES} label="Delivered lines per period" bucketLabel={bucketLabel} /> : <Empty>Nothing was delivered in this period.</Empty>}
          </Card>
        )}

        {ncs?.available && (
          <Card title="Supplier non-conformances" subtitle={`Raised per ${per} against a supplier, by severity`}>
            {ncs.trend.length ? (
              <StackedBars data={ncs.trend} series={NC_SERIES} label="Supplier non-conformances per period" bucketLabel={bucketLabel} />
            ) : (
              <Empty>No non-conformance named a supplier in this period.</Empty>
            )}
          </Card>
        )}

        {ncs?.available && (
          <Card title="Non-conformances by supplier" subtitle="Most raised in the period (top 8)">
            {ncs.bySupplier.length ? (
              <table className="w-full text-sm" aria-label="Non-conformances by supplier">
                <thead className="text-secondary-text">
                  <tr>
                    <th className={th}>Supplier</th>
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
                      <td className={td}>{s.count}</td>
                      <td className={`${td} ${s.critical ? "text-error-color" : "text-secondary-text"}`}>{s.critical}</td>
                      <td className={`${td} text-right`}>
                        <Link to={`${NCR_REGISTER}?supplier=${s.id}&supplierLabel=${encodeURIComponent(s.name)}`} className="text-link-color hover:underline">
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

        <Card title="Corrective action requests" subtitle="Running requests by status" action={<Link to={SCAR_REGISTER} className="text-sm text-link-color hover:underline">All requests</Link>}>
          {data?.scarsByStatus.some((s) => s.count) ? (
            <HBars
              data={data.scarsByStatus.filter((s) => s.count > 0).map((s) => ({ key: s.key, label: SCAR_STATUSES.find((x) => x.key === s.key)?.label ?? s.key, count: s.count }))}
              name="Requests"
              labelWidth={170}
            />
          ) : (
            <Empty>No corrective action request is running.</Empty>
          )}
        </Card>

        <Card title="Responses overdue" subtitle="Corrective action requests past the date the supplier was to answer by">
          {data?.overdueScarList.length ? (
            <ul aria-label="Corrective action requests overdue" className="flex flex-col divide-y divide-border-color text-sm">
              {data.overdueScarList.map((s) => (
                <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                  <span>
                    <Link to={scarPath(s.id)} className={nameLink}>
                      {s.reference} · {s.title}
                    </Link>{" "}
                    <span className="text-xs text-secondary-text">{s.supplier.name}</span>
                  </span>
                  <span className="text-xs text-error-color">
                    Due {formatDate(s.dueOn)} ({plural(s.daysOverdue, "day")} overdue)
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No response is overdue.</Empty>
          )}
        </Card>

        <Card title="Approvals waiting" subtitle="Proposed approvals that someone other than the proposer must decide">
          {data?.approvalList.length ? (
            <ul aria-label="Approvals waiting" className="flex flex-col divide-y divide-border-color text-sm">
              {data.approvalList.map((a) => (
                <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                  <Link to={supplierPath(a.supplier.id, "qualification")} className={nameLink}>
                    {a.supplier.name}
                  </Link>
                  <span className="text-xs text-secondary-text">
                    {a.target === "conditional" ? "Conditional approval" : "Approval"} proposed {formatDate(a.proposedAt.slice(0, 10))}
                    {a.proposedBy ? ` by ${a.proposedBy}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No approval is waiting for a decision.</Empty>
          )}
        </Card>

        <Card
          title="Certifications and documents"
          subtitle="Expired, or expiring within 60 days, soonest first"
          action={<Link to="/Supplier-Quality/Expiry" className="text-sm text-link-color hover:underline">Expiry watchlist</Link>}>
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
                      {e.title} <span className="text-secondary-text">· {e.kind}</span>
                    </td>
                    <td className={`${td} ${e.days < 0 ? "text-error-color" : ""}`}>
                      {formatDate(e.expiresOn)} <span className="text-xs">({daysWords(e.days)})</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Nothing has expired or expires within 60 days.</Empty>
          )}
        </Card>

        <Card title="Risk reviews overdue" subtitle="Suppliers whose risk assessment was due to be looked at again">
          {data?.riskReviewList.length ? (
            <ul aria-label="Risk reviews overdue" className="flex flex-col divide-y divide-border-color text-sm">
              {data.riskReviewList.map((r) => (
                <li key={r.supplier.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <Link to={supplierPath(r.supplier.id, "qualification")} className={nameLink}>
                      {r.supplier.name}
                    </Link>
                    <RiskBadge risk={r.rating} />
                  </span>
                  <span className="text-xs text-error-color">
                    Review was due {formatDate(r.reviewOn)} ({plural(r.daysOverdue, "day")} ago)
                  </span>
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
