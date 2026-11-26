import { Link } from "react-router-dom";
import { format } from "date-fns";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BadgeCheckIcon, CalendarClockIcon, ClockIcon, TriangleAlertIcon, TruckIcon } from "@/components/icons";
import DashboardSkeleton from "@/components/dashboard/DashboardSkeleton";
import Breadcrumb from "../Breadcrumb";
import Callout from "../ui/Callout";
import { DashboardPeriodPicker } from "../dashboard/DashboardPeriod";
import { Chip, Empty, HeroCard, SplitBar, StatTile, headerLink as linkClass } from "../dashboard/DashboardGraphics";
import { Card, ChartTooltip, grid, tick } from "../dashboard/DashboardParts";
import { useDashboardPeriod } from "../../hooks/useDashboardPeriod";
import { usePpapDashboard } from "../../hooks/usePpap";
import { describeApiError } from "../../lib/api-client";
import { ATTENTION, attentionWhen, formatDay, ppapPath, statusLabel } from "../../lib/ppap";

const STATUS_COLOUR = {
  draft: "var(--chart-neutral)",
  in_preparation: "var(--chart-series-2)",
  ready: "var(--chart-series-2)",
  submitted: "var(--chart-series-1)",
  approved: "var(--chart-series-3)",
  interim_approved: "var(--chart-warning)",
  rejected: "var(--chart-critical)",
};
const TREND = [
  { key: "sent", label: "Sent or received", color: "var(--chart-series-1)" },
  { key: "approved", label: "Approved", color: "var(--chart-series-3)" },
  { key: "interim", label: "Approved for now", color: "var(--chart-warning)" },
  { key: "rejected", label: "Rejected", color: "var(--chart-critical)" },
];

const ItemList = ({ items, label }) => (
  <ul aria-label={label} className="flex flex-col divide-y divide-border-color text-sm">
    {items.map((i) => (
      <li key={`${i.reason}-${i.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
        <span className="flex min-w-0 flex-col">
          <Link to={ppapPath(i.id)} className="font-medium text-primary-text hover:underline">
            {i.reference} · {i.partNumber}
          </Link>
          <span className="text-xs text-secondary-text">
            {i.party ? `${i.party}${i.direction === "received" ? " (supplier)" : ""} · ` : ""}
            {attentionWhen(i)}
          </span>
        </span>
        <Chip tone={ATTENTION[i.reason]?.tone ?? "neutral"}>{ATTENTION[i.reason]?.label ?? i.reason}</Chip>
      </li>
    ))}
  </ul>
);

/**
 * PPAP dashboard (`/PPAP`): where the part approvals stand as of today (in force, waiting for an answer, rejected, on an interim approval, due for revalidation), then what
 * was sent and answered in the period in the address. The figures are the API's (`GET /ppap-dashboard`); nothing is worked out here. Information only.
 */
const PpapDashboard = () => {
  const period = useDashboardPeriod("90d");
  const { fromIso: from, toIso: to } = period;
  const { data, isLoading, isFetching, error } = usePpapDashboard(period);
  const k = data?.kpis;
  const trendParts = TREND.map((t) => ({ ...t, count: (data?.trend ?? []).reduce((n, b) => n + (b[t.key] ?? 0), 0) }));
  const bucketLabel = (start) => format(new Date(`${start}T00:00:00`), data?.period.bucket === "month" ? "MMM yy" : "d MMM");
  const waiting = k ? k.awaitingCustomer + k.awaitingUs : 0;
  const interimOpen = k ? k.interim + k.interimLapsed : 0;

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <BadgeCheckIcon className="h-6 w-6" aria-hidden="true" />
            Part approvals dashboard
          </h1>
          <p className="text-sm text-secondary-text" aria-live="polite">
            Sent and answered {formatDay(from)} – {formatDay(to)} · where each approval stands as of today
            {isFetching && !isLoading ? " · updating…" : ""}
          </p>
        </div>
        <div className="flex flex-nowrap items-end gap-3 max-sm:flex-wrap">
          <Link to="/PPAP/Register" className={linkClass}>
            All part approvals
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
        <DashboardSkeleton label="Loading the part approvals dashboard" tiles={5} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12" aria-busy={isLoading || undefined}>
            <HeroCard
              label="Part approvals in force"
              icon={BadgeCheckIcon}
              value={k ? k.approved : "—"}
              note={k ? `${waiting} waiting for an answer · ${k.inPreparation} being prepared · ${interimOpen} on an interim approval` : "Approved and not replaced by a newer submission"}
              to="/PPAP/Register?status=approved"
              className="xl:col-span-5">
              <span className="text-sm font-semibold text-primary-text">Where they stand</span>
              {data?.byStatus.some((s) => s.count) ? (
                <SplitBar
                  parts={data.byStatus.filter((s) => s.count).map((s) => ({ key: s.status, label: statusLabel(s.status), color: STATUS_COLOUR[s.status], count: s.count }))}
                  label="Part approvals by where they stand"
                  unit="part approval"
                  showZero
                />
              ) : (
                <Empty>No part approval has been started yet.</Empty>
              )}
            </HeroCard>

            <Card title="Needs action" subtitle="Rejected, interim approvals that have run out or are ending, and revalidations overdue" className="rounded-3xl xl:col-span-7">
              {data?.needsAction.length ? <ItemList items={data.needsAction} label="Part approvals that need action" /> : <Empty>Nothing needs action.</Empty>}
            </Card>
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-busy={isLoading || undefined}>
            <StatTile icon={TriangleAlertIcon} label="Rejected" value={k ? k.rejected : "—"} note="Rejected and not yet answered by a resubmission" alert={k?.rejected > 0} />
            <StatTile icon={ClockIcon} label="Interim approvals" value={k ? interimOpen : "—"} note={k ? `${k.interimLapsed} ran out · ${k.interimEnding} ending within 30 days` : ""} alert={k?.interimLapsed > 0} />
            <StatTile icon={CalendarClockIcon} label="Revalidation overdue" value={k ? k.reviewsOverdue : "—"} note="Approved and past the revalidation date" alert={k?.reviewsOverdue > 0} />
            <StatTile icon={TruckIcon} label="Waiting for an answer" value={k ? waiting : "—"} note={k ? `${k.awaitingCustomer} waiting for a customer · ${k.awaitingUs} from a supplier waiting for us` : ""} />
            <StatTile
              icon={BadgeCheckIcon}
              label="Answered in the period"
              value={k ? k.approvedInPeriod + k.interimInPeriod + k.rejectedInPeriod : "—"}
              note={k ? `${k.approvedInPeriod} approved · ${k.interimInPeriod} for now · ${k.rejectedInPeriod} rejected${k.averageDaysToAnswer != null ? ` · ${k.averageDaysToAnswer} days on average` : ""}` : ""}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            <Card title="Sent and answered" subtitle={`Per ${data?.period.bucket ?? "week"} in the period, by the day each was recorded`} className="xl:col-span-7">
              {trendParts.some((p) => p.count) ? (
                <>
                  <SplitBar parts={trendParts} label="Part approvals sent and answered in the period" unit="item" showZero />
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={data.trend} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="20%" aria-label="Part approvals sent and answered per period">
                        <CartesianGrid {...grid} />
                        <XAxis dataKey="start" tickFormatter={bucketLabel} tick={tick} axisLine={false} tickLine={false} minTickGap={12} />
                        <YAxis allowDecimals={false} tick={tick} axisLine={false} tickLine={false} />
                        <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={<ChartTooltip labelFormat={bucketLabel} />} />
                        {TREND.map((s) => (
                          <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={14} />
                        ))}
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </>
              ) : (
                <Empty>No part approval was sent or answered in this period.</Empty>
              )}
            </Card>

            <Card title="Waiting for an answer" subtitle="Sent or received and not yet answered, longest waiting first" className="xl:col-span-5">
              {data?.awaiting.length ? <ItemList items={data.awaiting} label="Part approvals waiting for an answer" /> : <Empty>No part approval is waiting for an answer.</Empty>}
            </Card>
          </div>
        </>
      )}
    </div>
  );
};

export default PpapDashboard;
