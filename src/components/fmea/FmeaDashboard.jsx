import { Link } from "react-router-dom";
import { format } from "date-fns";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CalendarClockIcon, ClipboardListIcon, ListTreeIcon, TriangleAlertIcon, UsersIcon } from "@/components/icons";
import DashboardSkeleton from "@/components/dashboard/DashboardSkeleton";
import Breadcrumb from "../Breadcrumb";
import Callout from "../ui/Callout";
import { DashboardPeriodPicker } from "../dashboard/DashboardPeriod";
import { Chip, Empty, HeroCard, SplitBar, StatTile, headerLink as linkClass } from "../dashboard/DashboardGraphics";
import { Card, ChartTooltip, grid, tick } from "../dashboard/DashboardParts";
import { useDashboardPeriod } from "../../hooks/useDashboardPeriod";
import { useFmeaDashboard } from "../../hooks/useFmea";
import { describeApiError } from "../../lib/api-client";
import { formatDay, fmeaPath, kindLabel, priorityLabel, revisionPath } from "../../lib/fmea";

const PRIORITY_COLOUR = { high: "var(--chart-critical)", medium: "var(--chart-warning)", low: "var(--chart-series-3)", unrated: "var(--chart-neutral)" };
const TREND = [
  { key: "approved", label: "Revisions approved", color: "var(--chart-series-1)" },
  { key: "actionsDone", label: "Actions finished", color: "var(--chart-series-3)" },
];
const th = "py-1 pr-3 text-left text-xs font-medium uppercase tracking-wide";
const td = "py-2 pr-3 align-middle";
const days = (n) => `${n} ${n === 1 ? "day" : "days"}`;

/**
 * FMEA dashboard (`/FMEA`): what is in force, which causes in those FMEAs still need attention, and what is late (reviews, actions) as of today, then what
 * was approved, finished and started in the period in the address. The figures are the API's (`GET /fmea-dashboard`); nothing is worked out here.
 */
const FmeaDashboard = () => {
  const period = useDashboardPeriod("90d");
  const { fromIso: from, toIso: to } = period;
  const { data, isLoading, isFetching, error } = useFmeaDashboard(period);
  const k = data?.kpis;
  const trendParts = TREND.map((t) => ({ ...t, count: (data?.trend ?? []).reduce((n, b) => n + (b[t.key] ?? 0), 0) }));
  const bucketLabel = (start) => format(new Date(`${start}T00:00:00`), data?.period.bucket === "month" ? "MMM yy" : "d MMM");

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <ListTreeIcon className="h-6 w-6" aria-hidden="true" />
            FMEA dashboard
          </h1>
          <p className="text-sm text-secondary-text" aria-live="polite">
            Approved, finished and started {formatDay(from)} – {formatDay(to)} · what needs attention and what is late as of today
            {isFetching && !isLoading ? " · updating…" : ""}
          </p>
        </div>
        <div className="flex flex-nowrap items-end gap-3 max-sm:flex-wrap">
          <Link to="/FMEA/Register" className={linkClass}>
            All FMEAs
          </Link>
          <Link to="/FMEA/My-Actions" className={linkClass}>
            My actions
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
        <DashboardSkeleton label="Loading the FMEA dashboard" tiles={5} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12" aria-busy={isLoading || undefined}>
            <HeroCard
              label="FMEAs in force"
              icon={ListTreeIcon}
              value={k ? k.inForce : "—"}
              note={k ? `${k.drafts} ${k.drafts === 1 ? "revision" : "revisions"} being prepared · ${k.awaitingApproval} waiting for approval` : "Design and process FMEAs with a revision in effect"}
              to="/FMEA/Register"
              className="xl:col-span-5">
              <span className="text-sm font-semibold text-primary-text">In force by kind</span>
              {data?.byKind.some((t) => t.count) ? (
                <SplitBar parts={data.byKind.filter((t) => t.count).map((t, i) => ({ key: t.kind, label: kindLabel(t.kind), color: `var(--chart-series-${(i % 6) + 1})`, count: t.count }))} label="FMEAs in force by kind" unit="FMEA" showZero />
              ) : (
                <Empty>No FMEA is in force yet.</Empty>
              )}
            </HeroCard>

            <Card title="Causes in the FMEAs in force" subtitle="By the priority the rating model works out" className="rounded-3xl xl:col-span-7">
              {data?.byPriority.some((p) => p.count) ? (
                <SplitBar
                  parts={data.byPriority.map((p) => ({ key: p.priority, label: p.priority === "unrated" ? "Not rated" : priorityLabel(p.priority), color: PRIORITY_COLOUR[p.priority], count: p.count }))}
                  label="Causes by priority"
                  unit="cause"
                  showZero
                />
              ) : (
                <Empty>Nothing to show until an FMEA is in force.</Empty>
              )}
            </Card>
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-busy={isLoading || undefined}>
            <StatTile icon={TriangleAlertIcon} label="Causes needing attention" value={k ? k.needAttention : "—"} note={k ? `${k.highPriority} of high priority · ${k.notInPlan} with no control carried to a plan` : ""} alert={k?.highPriority > 0} />
            <StatTile icon={ClipboardListIcon} label="Actions overdue" value={k ? k.overdueActions : "—"} note={k ? `${k.openActions} open in all` : ""} alert={k?.overdueActions > 0} />
            <StatTile icon={CalendarClockIcon} label="Reviews overdue" value={k ? k.reviewsOverdue : "—"} note="FMEAs in force past their review date" alert={k?.reviewsOverdue > 0} />
            <StatTile icon={UsersIcon} label="Waiting for approval" value={k ? k.awaitingApproval : "—"} note="Revisions submitted and not yet decided" />
            <StatTile icon={ListTreeIcon} label="Approved in the period" value={k ? k.revisionsApproved : "—"} note={k ? `${k.actionsDone} actions finished · ${k.started} FMEAs started · ${k.reviewsRecorded} reviews recorded` : ""} />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            <Card title="Approved and finished" subtitle={`Per ${data?.period.bucket ?? "week"} in the period`} className="xl:col-span-7">
              {trendParts.some((p) => p.count) ? (
                <>
                  <SplitBar parts={trendParts} label="Revisions approved and actions finished in the period" unit="item" showZero />
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={data.trend} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="20%" aria-label="Revisions approved and actions finished per period">
                        <CartesianGrid {...grid} />
                        <XAxis dataKey="start" tickFormatter={bucketLabel} tick={tick} axisLine={false} tickLine={false} minTickGap={12} />
                        <YAxis allowDecimals={false} tick={tick} axisLine={false} tickLine={false} />
                        <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={<ChartTooltip labelFormat={bucketLabel} />} />
                        {TREND.map((s) => (
                          <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={18} />
                        ))}
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </>
              ) : (
                <Empty>No revision approved and no action finished in this period.</Empty>
              )}
            </Card>

            <Card title="Waiting for approval" subtitle="Submitted revisions, longest waiting first" className="xl:col-span-5">
              {data?.awaitingApproval.length ? (
                <ul aria-label="Revisions waiting for approval" className="flex flex-col divide-y divide-border-color text-sm">
                  {data.awaitingApproval.map((r) => (
                    <li key={r.revisionId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="flex min-w-0 flex-col">
                        <Link to={revisionPath(r.fmeaId, r.revisionId)} className="font-medium text-primary-text hover:underline">
                          {r.number}
                          {r.letter ? ` rev ${r.letter}` : ""} · {r.title}
                        </Link>
                        <span className="text-xs text-secondary-text">{r.approver ? `Approver: ${r.approver}` : "No approver named"}</span>
                      </span>
                      {r.submittedAt && <Chip>submitted {formatDay(r.submittedAt.slice(0, 10))}</Chip>}
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No revision is waiting for approval.</Empty>
              )}
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card title="Causes that need attention" subtitle="In the FMEAs in force, highest RPN first">
              {data?.topCauses.length ? (
                <table className="w-full text-sm" aria-label="Causes needing attention">
                  <thead className="text-secondary-text">
                    <tr>
                      <th className={th}>FMEA</th>
                      <th className={th}>Failure mode and cause</th>
                      <th className={th}>RPN</th>
                      <th className={th}>Priority</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topCauses.map((c) => (
                      <tr key={c.causeId} className="border-t border-border-color">
                        <td className={td}>
                          <Link to={revisionPath(c.fmeaId, c.revisionId)} className="font-medium text-primary-text hover:underline">
                            {c.number}
                          </Link>
                        </td>
                        <td className={td}>
                          <span className="block text-primary-text">{c.failureMode}</span>
                          <span className="block text-xs text-secondary-text">
                            {c.cause}
                            {c.hasAction ? " · has an action" : ""}
                          </span>
                        </td>
                        <td className={`${td} whitespace-nowrap`}>{c.rpn ?? "—"}</td>
                        <td className={td}>
                          <Chip tone={c.priority === "high" ? "error" : c.priority === "medium" ? "warning" : "neutral"}>{priorityLabel(c.priority)}</Chip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty>No cause in an FMEA in force needs attention.</Empty>
              )}
            </Card>

            <Card title="Actions overdue" subtitle="Open actions past their due date, oldest first">
              {data?.overdueActions.length ? (
                <ul aria-label="Actions overdue" className="flex flex-col divide-y divide-border-color text-sm">
                  {data.overdueActions.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium text-primary-text">{a.description}</span>
                        <span className="text-xs text-secondary-text">
                          <Link to={revisionPath(a.fmeaId, a.revisionId)} className="hover:underline">
                            {a.number}
                          </Link>{" "}
                          · {a.owner ?? "Unnamed"} · due {formatDay(a.dueOn)}
                        </span>
                      </span>
                      <Chip tone="error">{days(a.days)} late</Chip>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No action is overdue.</Empty>
              )}
            </Card>

            <Card title="Reviews overdue" subtitle="FMEAs in force past their periodic review date">
              {data?.reviewsOverdue.length ? (
                <ul aria-label="FMEA reviews overdue" className="flex flex-col divide-y divide-border-color text-sm">
                  {data.reviewsOverdue.map((f) => (
                    <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="flex min-w-0 flex-col">
                        <Link to={fmeaPath(f.id)} className="font-medium text-primary-text hover:underline">
                          {f.number} · {f.title}
                        </Link>
                        <span className="text-xs text-secondary-text">
                          {kindLabel(f.kind)} · {f.owner ?? "No owner"} · due {f.nextReviewOn ? formatDay(f.nextReviewOn) : "—"}
                        </span>
                      </span>
                      {f.days != null && <Chip tone="error">{days(f.days)} late</Chip>}
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No FMEA is past its review date.</Empty>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
};

export default FmeaDashboard;
