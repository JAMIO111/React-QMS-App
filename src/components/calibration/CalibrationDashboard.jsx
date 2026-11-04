import { Link, useSearchParams } from "react-router-dom";
import { format, startOfYear, subDays, subMonths } from "date-fns";
import { Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  CalendarClockIcon,
  CalendarIcon,
  CircleCheckIcon,
  ClipboardCheckIcon,
  GaugeIcon,
  ShieldAlertIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  TriangleAlertIcon,
} from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import RHFComboBox from "../ui/RHFComboBox";
import { useCalibrationDashboard } from "../../hooks/useCalibration";
import { describeApiError } from "../../lib/api-client";
import { describeDue } from "../../lib/calibration";
import { formatDate } from "../../lib/ncr";
import { GaugeStatusPill } from "./Pills";

const PERIODS = [
  { id: "30d", name: "Last 30 days", from: (t) => subDays(t, 29) },
  { id: "90d", name: "Last 90 days", from: (t) => subDays(t, 89) },
  { id: "12m", name: "Last 12 months", from: (t) => subDays(subMonths(t, 12), -1) },
  { id: "ytd", name: "Year to date", from: (t) => startOfYear(t) },
  { id: "24m", name: "Last 24 months", from: (t) => subDays(subMonths(t, 24), -1) },
];
// Fixed colour per outcome and status (never by rank), from the validated chart palette.
const OUTCOME_SERIES = [
  { key: "pass", label: "Pass", color: "var(--chart-series-3)" },
  { key: "adjusted", label: "Adjusted", color: "var(--chart-warning)" },
  { key: "fail", label: "Fail", color: "var(--chart-critical)" },
];
const STATUS_COLOR = {
  active: "var(--chart-series-3)",
  in_calibration: "var(--chart-series-1)",
  quarantined: "var(--chart-critical)",
  out_of_service: "var(--chart-warning)",
  retired: "var(--chart-neutral)",
  lost: "var(--chart-neutral)",
};
const SINGLE = "var(--brand-primary)";
const tick = { className: "fill-secondary-text", fontSize: 12 };
const grid = { stroke: "var(--chart-grid)", vertical: false };
const pct = (now, before) => (before ? Math.round(((now - before) / before) * 100) : null);
const percent = (v) => (v === null || v === undefined ? "—" : `${v.toLocaleString("en-GB")}%`);

const ChartTooltip = ({ active, payload, label, labelFormat = (l) => l }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border-color bg-primary-bg px-3 py-2 text-xs text-primary-text shadow-lg shadow-shadow-color">
      <p className="mb-1 font-semibold">{labelFormat(label)}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: p.payload?.fill ?? p.color }} aria-hidden="true" />
          <span className="text-secondary-text">{p.name}</span>
          <span className="ml-auto font-medium">{p.value}</span>
        </p>
      ))}
    </div>
  );
};

const Card = ({ title, subtitle, children, className = "" }) => (
  <section aria-label={title} className={`flex min-w-0 flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-4 ${className}`}>
    <div>
      <h2 className="text-base font-semibold text-primary-text">{title}</h2>
      {subtitle && <p className="text-xs text-secondary-text">{subtitle}</p>}
    </div>
    {children}
  </section>
);

/** KPI tile: one number, its label, and (optionally) the change on the previous period. */
const Kpi = ({ icon: Icon, label, value, note, change, higherIsWorse = false, to, alert }) => {
  const worse = change !== null && change !== undefined && (higherIsWorse ? change > 0 : change < 0);
  const body = (
    <>
      <div className="flex items-center justify-between text-secondary-text">
        <span className="text-sm">{label}</span>
        <Icon className={`h-5 w-5 ${alert ? "text-error-color" : ""}`} aria-hidden="true" />
      </div>
      <p className={`text-3xl font-semibold ${alert ? "text-error-color" : "text-primary-text"}`}>{value}</p>
      <p className="min-h-4 text-xs text-secondary-text">
        {change !== null && change !== undefined ? (
          <span className={`inline-flex items-center gap-1 ${change === 0 ? "" : worse ? "text-error-color" : "text-success-color"}`}>
            {change > 0 ? <TrendingUpIcon aria-hidden="true" /> : change < 0 ? <TrendingDownIcon aria-hidden="true" /> : null}
            {change === 0 ? "No change" : `${change > 0 ? "Up" : "Down"} ${Math.abs(change)}%`} on previous period
          </span>
        ) : (
          note
        )}
      </p>
    </>
  );
  const cls = "flex flex-col gap-1 rounded-2xl border border-border-color bg-secondary-bg p-4";
  return to ? (
    <Link to={to} className={`${cls} transition-colors hover:border-brand-primary`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
};

const HBars = ({ data, colorOf = () => SINGLE, height }) => (
  <div style={{ height: height ?? Math.max(120, data.length * 34 + 20) }}>
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 36, bottom: 0, left: 0 }} barCategoryGap={6}>
        <XAxis type="number" hide allowDecimals={false} />
        <YAxis type="category" dataKey="label" width={130} tick={tick} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={<ChartTooltip />} />
        <Bar dataKey="count" name="Gauges" radius={[0, 4, 4, 0]} maxBarSize={22} label={{ position: "right", className: "fill-primary-text", fontSize: 12 }}>
          {data.map((d) => (
            <Cell key={d.key} fill={colorOf(d)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  </div>
);

/**
 * Calibration dashboard (/Calibration): gauge KPIs as of today, calibrations in a period, the due
 * schedule for the next twelve months and the gauges that need attention. The period lives in the URL.
 */
const CalibrationDashboard = () => {
  const [params, setParams] = useSearchParams();
  const periodId = PERIODS.some((p) => p.id === params.get("period")) ? params.get("period") : "12m";
  const now = new Date();
  const from = format(PERIODS.find((p) => p.id === periodId).from(now), "yyyy-MM-dd");
  const to = format(now, "yyyy-MM-dd");
  const { data, isLoading, isFetching, error } = useCalibrationDashboard({ from, to });
  const k = data?.kpis;
  const bucketLabel = (start) => (data?.period.bucket === "month" ? format(new Date(`${start}T00:00:00`), "MMM yy") : format(new Date(`${start}T00:00:00`), "d MMM"));
  const monthLabel = (start) => format(new Date(`${start}T00:00:00`), "MMM yy");
  const setPeriod = (v) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (v && v !== "12m") next.set("period", v);
      else next.delete("period");
      return next;
    });
  // The first month of the schedule also holds the overdue gauges.
  const schedule = (data?.dueSchedule ?? []).map((m, i) => ({ ...m, label: i === 0 ? `${monthLabel(m.start)} *` : monthLabel(m.start) }));

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="text-2xl font-semibold text-primary-text">Calibration dashboard</h1>
          <p className="text-sm text-secondary-text" aria-live="polite">
            Gauges as of today · calibrations {formatDate(from)} – {formatDate(to)}
            {isFetching && !isLoading ? " · updating…" : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Link to="/Calibration/Gauges" className="rounded-lg border border-border-color bg-secondary-bg px-3 py-1.5 text-sm text-primary-text hover:bg-border-color/50">
            Gauge register
          </Link>
          <div className="w-48">
            <RHFComboBox label="Period" icon={CalendarIcon} options={PERIODS} value={periodId} onChange={setPeriod} sort={false} clearable={false} />
          </div>
        </div>
      </div>

      {error && <p role="alert" className="rounded-lg border border-error-color/40 bg-error-color/10 p-3 text-sm text-primary-text">{describeApiError(error)}</p>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-busy={isLoading || undefined}>
        <Kpi icon={GaugeIcon} label="Gauges" value={k ? k.gauges.toLocaleString("en-GB") : "—"} note={k ? `${k.inUse} in use` : ""} to="/Calibration/Gauges" />
        <Kpi icon={TriangleAlertIcon} label="Overdue" value={k ? k.overdue.toLocaleString("en-GB") : "—"} note="In use and past their due date" to="/Calibration/Gauges?due=overdue" alert={k?.overdue > 0} />
        <Kpi icon={CalendarClockIcon} label="Due in 30 days" value={k ? k.dueNext30.toLocaleString("en-GB") : "—"} note="Plan these calibrations" to="/Calibration/Gauges?due=due_30" />
        <Kpi icon={ShieldAlertIcon} label="Quarantined" value={k ? k.quarantined.toLocaleString("en-GB") : "—"} note="Not to be used" to="/Calibration/Gauges?status=quarantined" alert={k?.quarantined > 0} />
        <Kpi icon={ClipboardCheckIcon} label="Calibrations in period" value={k ? k.calibrated.toLocaleString("en-GB") : "—"} change={k ? pct(k.calibrated, k.calibratedPrevious) : null}
          note={k ? `${k.failed} failed` : ""} />
        <Kpi icon={CircleCheckIcon} label="Pass first time" value={k ? percent(k.firstTimePassRate) : "—"} note={k ? `Compliance ${percent(k.compliance)} (in use, in date)` : ""} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="Calibrations due" subtitle="Gauges in use, by month of their due date · * includes overdue">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={schedule} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="20%">
                <CartesianGrid {...grid} />
                <XAxis dataKey="label" tick={tick} axisLine={false} tickLine={false} minTickGap={8} />
                <YAxis allowDecimals={false} tick={tick} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={<ChartTooltip />} />
                <Bar dataKey="count" name="Due" radius={[4, 4, 0, 0]} maxBarSize={36}>
                  {schedule.map((m, i) => (
                    <Cell key={m.start} fill={i === 0 && k?.overdue ? "var(--chart-critical)" : SINGLE} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title="Calibration results" subtitle={`Per ${data?.period.bucket ?? "month"}, by calibration date`}>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data?.outcomes ?? []} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="20%">
                <CartesianGrid {...grid} />
                <XAxis dataKey="start" tickFormatter={bucketLabel} tick={tick} axisLine={false} tickLine={false} minTickGap={12} />
                <YAxis allowDecimals={false} tick={tick} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={<ChartTooltip labelFormat={bucketLabel} />} />
                <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-secondary-text">{v}</span>} />
                {OUTCOME_SERIES.map((s, i) => (
                  <Bar key={s.key} dataKey={s.key} name={s.label} stackId="outcomes" fill={s.color} stroke="rgb(var(--secondary-bg))" strokeWidth={1}
                    radius={i === OUTCOME_SERIES.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={36} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title="Gauges by status" subtitle="Right now">
          <HBars data={data?.byStatus ?? []} colorOf={(d) => STATUS_COLOR[d.key]} height={230} />
        </Card>

        <Card title="Gauges by type" subtitle="Not retired or lost">
          {data?.byType.length ? <HBars data={data.byType} /> : <p className="py-8 text-center text-sm text-secondary-text">No gauges yet.</p>}
        </Card>
      </div>

      <Card title="Needs attention" subtitle="Quarantined, overdue and due in the next 30 days">
        {data?.attention.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Gauges needing attention">
              <thead className="text-left text-secondary-text">
                <tr>
                  <th className="py-1 pr-2 font-medium">Gauge</th>
                  <th className="py-1 pr-2 font-medium">Status</th>
                  <th className="py-1 pr-2 font-medium">Site</th>
                  <th className="py-1 pr-2 font-medium">Next due</th>
                  <th className="py-1 text-right font-medium">When</th>
                </tr>
              </thead>
              <tbody className="text-primary-text">
                {data.attention.map((g) => (
                  <tr key={g.id} className="border-t border-border-color">
                    <td className="py-1.5 pr-2">
                      <Link className="text-link-color hover:underline" to={`/Calibration/Gauges/${g.id}`}>{g.assetNumber}</Link>{" "}
                      <span className="text-secondary-text">{g.description}</span>
                    </td>
                    <td className="py-1.5 pr-2"><GaugeStatusPill status={g.status} /></td>
                    <td className="py-1.5 pr-2">{g.site ?? "—"}</td>
                    <td className="py-1.5 pr-2">{formatDate(g.nextDueOn)}</td>
                    <td className={`py-1.5 text-right ${g.daysUntilDue < 0 ? "text-error-color" : ""}`}>{describeDue(g.daysUntilDue) || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="py-4 text-center text-sm text-secondary-text">Nothing overdue, due soon or quarantined.</p>
        )}
      </Card>
    </div>
  );
};

export default CalibrationDashboard;
