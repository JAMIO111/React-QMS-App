import { Link } from "react-router-dom";
import { format } from "date-fns";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import DashboardSkeleton from "@/components/dashboard/DashboardSkeleton";
import { ArrowRightIcon, ClockIcon, PackageIcon, TriangleAlertIcon, RotateCcwIcon, UsersIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import { DashboardPeriodPicker } from "../dashboard/DashboardPeriod";
import { Card, ChartTooltip, grid, percent, stackedBarShape, tick } from "../dashboard/DashboardParts";
import { ArcGauge, Chip, Empty, HeroCard, Meter, SplitBar, StatTile, Tile, cardLink, headerLink as linkClass } from "../dashboard/DashboardGraphics";
import Callout from "../ui/Callout";
import { useDashboardPeriod } from "../../hooks/useDashboardPeriod";
import { useCustomerDashboard } from "../../hooks/useCustomerQuality";
import { describeApiError } from "../../lib/api-client";
import { NCR_REGISTER } from "../../lib/ncr";
import { formatDate } from "../../lib/processControl";

const SEVERITY_SERIES = [
  { key: "critical", label: "Critical", color: "var(--chart-critical)" },
  { key: "major", label: "Major", color: "var(--chart-serious)" },
  { key: "minor", label: "Minor", color: "var(--chart-warning)" },
];
const th = "py-1 pr-3 text-left text-xs font-medium uppercase tracking-wide";
const td = "py-2 pr-3 align-middle";
const nameLink = "font-medium text-primary-text hover:underline";
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const number = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("en-GB"));
const customerNcs = (id) => `${NCR_REGISTER}?customer=${id}&source=customer`;
const money = (value, currency) => {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: currency || "GBP", maximumFractionDigits: 0 }).format(value);
  } catch {
    return number(value);
  }
};

/** Counts per week or month, stacked; the split bar above carries the legend. */
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

/**
 * Customer quality dashboard (`/Shipping`): what was shipped in the period, on time and in full against the order lines, what customers reported as defective
 * (units and PPM), what came back under an RMA and who needs a look. Every figure is worked out by the database for each customer and added up here. PPM is
 * "defects reported in the period over units shipped in the period" and is shown beside a traced-by-lot figure; neither is a customer's own scorecard.
 */
const CustomerDashboard = () => {
  const period = useDashboardPeriod("90d");
  const { fromIso: from, toIso: to } = period;
  const { data, isLoading, isFetching, error } = useCustomerDashboard({ from, to });
  const t = data?.totals;
  const bucketLabel = (start) => format(new Date(`${start}T00:00:00`), data?.period.bucket === "month" ? "MMM yy" : "d MMM");
  const per = data?.period.bucket ?? "week";
  const severityParts = SEVERITY_SERIES.map((s) => ({ ...s, count: data?.bySeverity.find((x) => x.key === s.key)?.count ?? 0 }));
  const maxPpm = Math.max(1, ...(data?.customers ?? []).map((c) => c.ppm ?? 0));

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <PackageIcon className="h-6 w-6" aria-hidden="true" />
            Customer quality dashboard
          </h1>
          <p className="text-sm text-secondary-text" aria-live="polite">
            Shipments, complaints and PPM {formatDate(from)} – {formatDate(to)} · on-time measured against the {data?.period.policy === "agreed" ? "confirmed" : "requested"} date
            {isFetching && !isLoading ? " · updating…" : ""}
          </p>
        </div>
        <div className="flex flex-nowrap items-end gap-3 max-sm:flex-wrap">
          <Link to="/Shipping/Orders" className={linkClass}>
            Customer orders
          </Link>
          <Link to="/Shipping/Shipments" className={linkClass}>
            Shipments
          </Link>
          <DashboardPeriodPicker period={period} />
        </div>
      </div>

      {error && (
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      )}

      {isLoading ? (
        <DashboardSkeleton label="Loading the customer quality dashboard" tiles={5} />
      ) : data && !data.available ? (
        <Callout tone="info" title="Customer figures are not shown">
          {data.reason}
        </Callout>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            <HeroCard
              label="Units shipped"
              icon={UsersIcon}
              value={t ? number(t.shippedUnits) : "—"}
              note={t ? `${plural(t.shipments, "shipment")} to ${plural(t.customers, "customer")}` : "In the period"}
              action={
                <Link to="/Shipping/Shipments" className={cardLink}>
                  Shipments <ArrowRightIcon aria-hidden="true" />
                </Link>
              }
              className="xl:col-span-5">
              <h2 className="text-sm font-semibold text-primary-text">Complaints raised, by severity</h2>
              {t?.ncsRaised ? <SplitBar parts={severityParts} label="Customer complaints by severity" unit="complaint" showZero /> : <Empty>No customer complaint was raised in this period.</Empty>}
            </HeroCard>
            <Card title="Delivery and quality" subtitle={`All customers together, ${formatDate(from)} – ${formatDate(to)}`} className="rounded-3xl xl:col-span-7">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <ArcGauge
                  label="On-time delivery"
                  value={t?.onTimePercent ?? null}
                  display={t ? percent(t.onTimePercent) : "—"}
                  note={t ? `${t.onTimeLines} of ${plural(t.matchedLines, "shipped line")} against an order` : ""}
                />
                <ArcGauge label="In full" value={t?.inFullPercent ?? null} display={t ? percent(t.inFullPercent) : "—"} note={t ? `${t.inFullLines} of ${plural(t.inFullJudged, "order line")} due` : ""} />
                <Tile label="PPM (reported)" className="justify-between bg-primary-bg/50">
                  <span className="text-sm text-secondary-text">PPM (reported)</span>
                  <p className={`text-3xl font-semibold ${t?.ppm > 0 ? "text-error-color" : "text-primary-text"}`}>{t ? number(t.ppm) : "—"}</p>
                  <Meter part={t?.ncUnits ?? 0} whole={t?.shippedUnits ?? 0} color="var(--chart-critical)" label="Units reported defective, of units shipped" />
                  <p className="min-h-4 text-xs text-secondary-text">{t ? `${number(t.ncUnits)} reported of ${number(t.shippedUnits)} shipped` : ""}</p>
                </Tile>
                <Tile label="PPM (by lot)" className="justify-between bg-primary-bg/50">
                  <span className="text-sm text-secondary-text">PPM (by lot)</span>
                  <p className={`text-3xl font-semibold ${t?.ppmLot > 0 ? "text-error-color" : "text-primary-text"}`}>{t ? number(t.ppmLot) : "—"}</p>
                  <p className="min-h-4 text-xs text-secondary-text">{t ? (t.tracedPercent === null ? "Nothing shipped" : `Units traced to a lot: ${percent(t.tracedPercent)} of those shipped`) : ""}</p>
                </Tile>
              </div>
              <p className="text-xs text-secondary-text">
                PPM is defects reported in the period over units shipped in the period, so it lags: a lot shipped in March may be reported in May. The by-lot figure counts only units traced to a lot.
              </p>
            </Card>
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <StatTile icon={TriangleAlertIcon} label="Complaints raised" value={t ? t.ncsRaised : "—"} note={t ? `${number(t.ncUnits)} units affected` : ""} to={`${NCR_REGISTER}?source=customer`} />
            <StatTile icon={TriangleAlertIcon} label="Open complaints" value={t ? t.openNcs : "—"} note="All still open, whenever raised" to={`${NCR_REGISTER}?source=customer`} alert={t?.openNcs > 0} />
            <StatTile icon={ClockIcon} label="Order lines past their date" value={t ? t.openLateLines : "—"} note="Open and not shipped in full, as of today" to="/Shipping/Orders" alert={t?.openLateLines > 0} />
            <StatTile icon={RotateCcwIcon} label="Returned under RMA" value={t ? number(t.returnedUnits) : "—"} note={t ? (t.returnedPercent === null ? "" : `${t.returnedPercent}% of units shipped · kept apart from PPM`) : ""} />
            <StatTile
              icon={PackageIcon}
              label="Complaint cost"
              value={t ? money(t.cost, t.costCurrency) : "—"}
              note={t ? `Net of credits · ${plural(t.shippedWithoutOrder, "shipped line")} with no order, ${t.shippedWithoutLot} with no lot` : ""}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card title="Complaints" subtitle={`Raised per ${per} by customers, by severity`}>
              {data?.trend.some((b) => b.ncs) ? <StackedBars data={data.trend} series={SEVERITY_SERIES} label="Customer complaints per period" bucketLabel={bucketLabel} /> : <Empty>No customer complaint was raised in this period.</Empty>}
            </Card>
            <Card title="PPM per period" subtitle={`Units reported defective per million shipped in each ${per}`}>
              {data?.trend.some((b) => b.ppm !== null) ? (
                <StackedBars data={data.trend.map((b) => ({ ...b, ppm: b.ppm ?? 0 }))} series={[{ key: "ppm", label: "PPM", color: "var(--chart-series-1)" }]} label="PPM per period" bucketLabel={bucketLabel} />
              ) : (
                <Empty>Nothing was shipped in this period.</Empty>
              )}
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            <Card title="Customers needing attention" subtitle="A critical complaint, PPM reported, on time under 90% or lines past their date" className="xl:col-span-5">
              {data?.attention.length ? (
                <ul className="flex flex-col gap-2" aria-label="Customers needing attention">
                  {data.attention.map((c) => (
                    <li key={c.id} className="flex flex-col gap-1 border-t border-border-color pt-2 first:border-t-0 first:pt-0">
                      <Link to={customerNcs(c.id)} className={nameLink}>
                        {c.name} <span className="text-xs font-normal text-secondary-text">{c.code}</span>
                      </Link>
                      <span className="flex flex-wrap gap-1">
                        {c.reasons.map((r) => (
                          <Chip key={r} tone="warning">
                            {r}
                          </Chip>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No customer needs a look.</Empty>
              )}
            </Card>
            <Card title="Order lines past their date" subtitle="Open and not shipped in full, longest first (top 8)" className="xl:col-span-7">
              {data?.lateOrderLines.length ? (
                <table className="w-full text-sm" aria-label="Order lines past their date">
                  <thead className="text-secondary-text">
                    <tr>
                      <th className={th}>Customer</th>
                      <th className={th}>Order</th>
                      <th className={th}>Part</th>
                      <th className={th}>Outstanding</th>
                      <th className={th}>Late</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lateOrderLines.map((l) => (
                      <tr key={`${l.orderId}-${l.lineNumber}`} className="border-t border-border-color">
                        <td className={td}>{l.customer.name}</td>
                        <td className={td}>
                          <Link to={`/Shipping/Orders/${l.orderId}`} className={nameLink}>
                            {l.orderNumber} / {l.lineNumber}
                          </Link>
                        </td>
                        <td className={td}>{l.partNumber}</td>
                        <td className={td}>{number(l.outstanding)}</td>
                        <td className={`${td} text-error-color`}>{plural(l.daysLate, "day")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty>No open order line is past its date.</Empty>
              )}
            </Card>
          </div>

          <Card title="Customer by customer" subtitle="Everyone shipped to or complained about in the period; highest PPM first">
            {data?.customers.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" aria-label="Customer by customer">
                  <thead className="text-secondary-text">
                    <tr>
                      <th className={th}>Customer</th>
                      <th className={th}>Shipped</th>
                      <th className={th}>On time</th>
                      <th className={th}>In full</th>
                      <th className={th}>Complaints</th>
                      <th className={th}>PPM</th>
                      <th className={th}>Returned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.customers.map((c) => (
                      <tr key={c.id} className="border-t border-border-color">
                        <td className={td}>
                          <Link to={customerNcs(c.id)} className={nameLink}>
                            {c.name}
                          </Link>
                          <span className="block text-xs text-secondary-text">{c.code}</span>
                        </td>
                        <td className={td}>{number(c.shippedUnits)}</td>
                        <td className={td}>{c.onTimePercent === null ? "—" : percent(c.onTimePercent)}</td>
                        <td className={td}>{c.inFullPercent === null ? "—" : percent(c.inFullPercent)}</td>
                        <td className={td}>
                          {c.ncs}
                          {c.critical > 0 && <span className="text-error-color"> · {c.critical} critical</span>}
                        </td>
                        <td className={td}>
                          <span className="flex min-w-24 flex-col gap-1">
                            <span>{c.ppm === null ? "No shipments" : number(c.ppm)}</span>
                            {c.ppm !== null && <Meter part={c.ppm} whole={maxPpm} color="var(--chart-critical)" label={`PPM, against the highest of ${number(maxPpm)}`} />}
                          </span>
                        </td>
                        <td className={td}>{number(c.returnedUnits)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>Nothing was shipped to a customer, and no customer complained, in this period.</Empty>
            )}
          </Card>
        </>
      )}
    </div>
  );
};

export default CustomerDashboard;
