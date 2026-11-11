import { Link } from "react-router-dom";
import { format } from "date-fns";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowRightIcon, CalendarClockIcon, GaugeIcon, ShieldAlertIcon, TriangleAlertIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import { useCalibrationDashboard } from "../../hooks/useCalibration";
import { describeApiError } from "../../lib/api-client";
import { describeDue } from "../../lib/calibration";
import { formatDate } from "../../lib/ncr";
import { GaugeStatusPill } from "./Pills";
import Callout from "../ui/Callout";
import { ACCENT, ArcGauge, ChangeNote, Chip, Empty, HeroCard, Meter, RankList, SplitBar, StatTile, Tile, cardLink, headerLink } from "../dashboard/DashboardGraphics";
import { Card, ChartTooltip, grid, pctChange, percent, stackedBarShape, tick } from "../dashboard/DashboardParts";
import { DashboardPeriodPicker } from "../dashboard/DashboardPeriod";
import { useDashboardPeriod } from "../../hooks/useDashboardPeriod";

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
const whole = (v) => v.toLocaleString("en-GB");

/**
 * Calibration dashboard (/Calibration): the gauges as of today (how many, their status, what is overdue, due soon or quarantined), calibrations in a
 * period, the due schedule for the next twelve months and the gauges that need attention. The period lives in the URL.
 */
const CalibrationDashboard = () => {
  const period = useDashboardPeriod("12m");
  const { fromIso: from, toIso: to } = period;
  const { data, isLoading, isFetching, error } = useCalibrationDashboard({ from, to });
  const k = data?.kpis;
  const bucket = data?.period.bucket ?? "month";
  const bucketLabel = (start) => format(new Date(`${start}T00:00:00`), bucket === "month" ? "MMM yy" : "d MMM");
  const monthLabel = (start) => format(new Date(`${start}T00:00:00`), "MMM yy");
  // The first month of the schedule also holds the overdue gauges.
  const schedule = (data?.dueSchedule ?? []).map((m, i) => ({ ...m, label: i === 0 ? `${monthLabel(m.start)} *` : monthLabel(m.start) }));
  const statusParts = (data?.byStatus ?? []).map((s) => ({ key: s.key, label: s.label, color: STATUS_COLOR[s.key] ?? "var(--chart-neutral)", count: s.count }));
  const outcomeParts = OUTCOME_SERIES.map((s) => ({ key: s.key, label: s.label, color: s.color, count: (data?.outcomes ?? []).reduce((n, b) => n + (b[s.key] ?? 0), 0) }));
  const calibratedChange = k ? pctChange(k.calibrated, k.calibratedPrevious) : null;

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <GaugeIcon className="h-6 w-6" aria-hidden="true" />
            Calibration dashboard
          </h1>
          <p className="text-sm text-secondary-text" aria-live="polite">
            Gauges as of today · calibrations {formatDate(from)} – {formatDate(to)}
            {isFetching && !isLoading ? " · updating…" : ""}
          </p>
        </div>
        <div className="flex flex-nowrap items-end gap-3 max-sm:flex-wrap">
          <Link to="/Calibration/Gauges" className={headerLink}>
            Gauge register
          </Link>
          <DashboardPeriodPicker period={period} />
        </div>
      </div>

      {error && (
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      )}

      {/* The gauges today beside how calibration is going. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12" aria-busy={isLoading || undefined}>
        <HeroCard
          label="Gauges"
          icon={GaugeIcon}
          value={k ? whole(k.gauges) : "—"}
          note={k ? `${whole(k.inUse)} in use` : "As of today"}
          action={
            <Link to="/Calibration/Gauges" className={cardLink}>
              Gauge register <ArrowRightIcon aria-hidden="true" />
            </Link>
          }
          className="xl:col-span-5">
          <h2 className="text-sm font-semibold text-primary-text">Gauges by status</h2>
          {statusParts.some((s) => s.count) ? <SplitBar parts={statusParts} label="Gauges by status" unit="gauge" tall /> : <Empty>No gauges yet.</Empty>}
        </HeroCard>

        <Card title="Calibration health" subtitle={`Gauges in date as of today · calibrations ${formatDate(from)} – ${formatDate(to)}`} className="rounded-3xl xl:col-span-7">
          <div className="grid flex-1 grid-cols-2 gap-3 lg:grid-cols-3">
            <ArcGauge label="Compliance" value={k?.compliance ?? null} display={k ? percent(k.compliance) : "—"} note="Gauges in use that are in date" />
            <ArcGauge label="Pass first time" value={k?.firstTimePassRate ?? null} display={k ? percent(k.firstTimePassRate) : "—"} note="Calibrations in the period with the outcome pass" />
            <Tile label="Calibrations in period" className="col-span-2 justify-between bg-primary-bg/50 lg:col-span-1">
              <span className="text-sm text-secondary-text">Calibrations in period</span>
              <p className="text-3xl font-semibold text-primary-text">{k ? whole(k.calibrated) : "—"}</p>
              <Meter part={k?.failed ?? 0} whole={k?.calibrated ?? 0} color="var(--chart-critical)" label="Calibrations that failed, of those in the period" />
              <p className="min-h-4 text-xs text-secondary-text">
                {k ? `${k.failed} failed` : ""}
                {calibratedChange !== null && (
                  <span className="mt-1 block">
                    <ChangeNote change={calibratedChange} />
                  </span>
                )}
              </p>
            </Tile>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-busy={isLoading || undefined}>
        <StatTile icon={TriangleAlertIcon} label="Overdue" value={k ? whole(k.overdue) : "—"} note="In use and past their due date" to="/Calibration/Gauges?due=overdue" alert={k?.overdue > 0} />
        <StatTile icon={CalendarClockIcon} label="Due in 30 days" value={k ? whole(k.dueNext30) : "—"} note="Plan these calibrations" to="/Calibration/Gauges?due=due_30" />
        <StatTile icon={ShieldAlertIcon} label="Quarantined" value={k ? whole(k.quarantined) : "—"} note="Not to be used" to="/Calibration/Gauges?status=quarantined" alert={k?.quarantined > 0} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="Calibrations due" subtitle="Gauges in use, by month of their due date · * includes overdue">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={schedule} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="20%" aria-label="Calibrations due per month">
                <CartesianGrid {...grid} />
                <XAxis dataKey="label" tick={tick} axisLine={false} tickLine={false} minTickGap={8} />
                <YAxis allowDecimals={false} tick={tick} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={<ChartTooltip />} />
                <Bar dataKey="count" name="Due" radius={[4, 4, 0, 0]} maxBarSize={24}>
                  {schedule.map((m, i) => (
                    <Cell key={m.start} fill={i === 0 && k?.overdue ? "var(--chart-critical)" : ACCENT} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title="Calibration results" subtitle={`Per ${bucket}, by calibration date`}>
          {outcomeParts.some((o) => o.count) ? (
            <>
              <SplitBar parts={outcomeParts} label="Calibration results in the period" unit="calibration" showZero />
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data?.outcomes ?? []} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="20%" aria-label="Calibration results per period">
                    <CartesianGrid {...grid} />
                    <XAxis dataKey="start" tickFormatter={bucketLabel} tick={tick} axisLine={false} tickLine={false} minTickGap={12} />
                    <YAxis allowDecimals={false} tick={tick} axisLine={false} tickLine={false} />
                    <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={<ChartTooltip labelFormat={bucketLabel} />} />
                    {OUTCOME_SERIES.map((s) => (
                      <Bar key={s.key} dataKey={s.key} name={s.label} stackId="outcomes" fill={s.color} stroke="rgb(var(--secondary-bg))" strokeWidth={2} shape={stackedBarShape(OUTCOME_SERIES.map((x) => x.key))} maxBarSize={24} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          ) : (
            <Empty>No calibrations in this period.</Empty>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <Card title="Gauges by type" subtitle="Not retired or lost" className="xl:col-span-5">
          {data?.byType.length ? <RankList items={data.byType} label="Gauges by type" /> : <Empty>No gauges yet.</Empty>}
        </Card>

        <Card title="Needs attention" subtitle="Quarantined, overdue and due in the next 30 days" className="xl:col-span-7">
          {data?.attention.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="Gauges needing attention">
                <thead className="text-left text-xs uppercase tracking-wide text-secondary-text">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Gauge</th>
                    <th className="py-1 pr-3 font-medium">Status</th>
                    <th className="py-1 pr-3 font-medium">Site</th>
                    <th className="py-1 pr-3 font-medium">Next due</th>
                    <th className="py-1 text-right font-medium">When</th>
                  </tr>
                </thead>
                <tbody className="text-primary-text">
                  {data.attention.map((g) => (
                    <tr key={g.id} className="border-t border-border-color">
                      <td className="py-2 pr-3">
                        <Link className="font-medium text-link-color hover:underline" to={`/Calibration/Gauges/${g.id}`}>
                          {g.assetNumber}
                        </Link>
                        <span className="block text-xs text-secondary-text">{g.description}</span>
                      </td>
                      <td className="py-2 pr-3">
                        <GaugeStatusPill status={g.status} />
                      </td>
                      <td className="py-2 pr-3">{g.site ?? "—"}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{formatDate(g.nextDueOn)}</td>
                      <td className="py-2 text-right">{describeDue(g.daysUntilDue) ? <Chip tone={g.daysUntilDue < 0 ? "error" : "warning"}>{describeDue(g.daysUntilDue)}</Chip> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>Nothing overdue, due soon or quarantined.</Empty>
          )}
        </Card>
      </div>
    </div>
  );
};

export default CalibrationDashboard;
