import { Link } from "react-router-dom";
import { format } from "date-fns";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CalendarClockIcon, ClipboardListIcon, GitPullRequestArrowIcon, TriangleAlertIcon, UsersIcon } from "@/components/icons";
import DashboardSkeleton from "@/components/dashboard/DashboardSkeleton";
import Breadcrumb from "../Breadcrumb";
import Callout from "../ui/Callout";
import { DashboardPeriodPicker } from "../dashboard/DashboardPeriod";
import { Chip, Empty, HeroCard, Pipeline, RankList, SplitBar, StatTile, headerLink as linkClass } from "../dashboard/DashboardGraphics";
import { Card, ChartTooltip, grid, tick } from "../dashboard/DashboardParts";
import { useDashboardPeriod } from "../../hooks/useDashboardPeriod";
import { useChangeDashboard } from "../../hooks/useChange";
import { describeApiError } from "../../lib/api-client";
import { changePath, formatDay, stageLabel } from "../../lib/change";

const STAGES = ["assessment", "approval", "approved", "implementing", "verifying"];
const TREND = [
  { key: "submitted", label: "Submitted", color: "var(--chart-series-1)" },
  { key: "closed", label: "Closed", color: "var(--chart-series-3)" },
];
const th = "py-1 pr-3 text-left text-xs font-medium uppercase tracking-wide";
const td = "py-2 pr-3 align-middle";
const days = (n) => `${n} ${n === 1 ? "day" : "days"}`;

/**
 * Change dashboard (`/Change`): what is open, what is waiting for a board member, what is late and what was past its cut-in point, as of today, then
 * what was submitted and closed in the period in the address. Figures are the API's (`GET /changes-dashboard`); nothing is worked out here.
 */
const ChangeDashboard = () => {
  const period = useDashboardPeriod("90d");
  const { fromIso: from, toIso: to } = period;
  const { data, isLoading, isFetching, error } = useChangeDashboard(period);
  const k = data?.kpis;
  const stageCount = new Map((data?.byStage ?? []).map((s) => [s.stage, s.count]));
  const trendParts = TREND.map((t) => ({ key: t.key, label: t.label, color: t.color, count: (data?.trend ?? []).reduce((n, b) => n + (b[t.key] ?? 0), 0) }));
  const bucketLabel = (start) => format(new Date(`${start}T00:00:00`), data?.period.bucket === "month" ? "MMM yy" : "d MMM");

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <GitPullRequestArrowIcon className="h-6 w-6" aria-hidden="true" />
            Change dashboard
          </h1>
          <p className="text-sm text-secondary-text" aria-live="polite">
            Submitted and closed {formatDay(from)} – {formatDay(to)} · what is open, waiting and late as of today
            {isFetching && !isLoading ? " · updating…" : ""}
          </p>
        </div>
        <div className="flex flex-nowrap items-end gap-3 max-sm:flex-wrap">
          <Link to="/Change/Register" className={linkClass}>
            All changes
          </Link>
          <Link to="/Change/Mine" className={linkClass}>
            My changes
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
        <DashboardSkeleton label="Loading the change dashboard" tiles={5} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12" aria-busy={isLoading || undefined}>
            <HeroCard
              label="Open changes"
              icon={GitPullRequestArrowIcon}
              value={k ? k.open : "—"}
              note={k ? `${k.expedited} expedited · ${k.drafts} ${k.drafts === 1 ? "draft" : "drafts"} not yet submitted` : "Between assessment and the effectiveness check"}
              to="/Change/Register"
              className="xl:col-span-5">
              <span className="text-sm font-semibold text-primary-text">Open changes by type</span>
              {data?.byType.some((t) => t.count) ? (
                <SplitBar parts={data.byType.filter((t) => t.count).map((t, i) => ({ key: t.type, label: t.type, color: `var(--chart-series-${(i % 6) + 1})`, count: t.count }))} label="Open changes by type" unit="change" showZero />
              ) : (
                <Empty>No changes are open.</Empty>
              )}
            </HeroCard>

            <Card title="Where they stand" subtitle="Open changes by stage, in order" className="rounded-3xl xl:col-span-7">
              <Pipeline steps={STAGES.map((s) => ({ key: s, label: stageLabel(s), count: stageCount.get(s) ?? 0 }))} label="Changes by stage" layout="six" to={(s) => `/Change/Register?stage=${s.key}`} />
            </Card>
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-busy={isLoading || undefined}>
            <StatTile icon={UsersIcon} label="Waiting at the board" value={k ? k.signoffsWaiting : "—"} note={k ? `${k.atBoard} ${k.atBoard === 1 ? "change" : "changes"} out for sign-off` : ""} alert={k?.signoffsWaiting > 0} />
            <StatTile icon={ClipboardListIcon} label="Tasks overdue" value={k ? k.tasksOverdue : "—"} note={k ? `${k.tasksOpen} open in all` : ""} alert={k?.tasksOverdue > 0} />
            <StatTile icon={CalendarClockIcon} label="Past the cut-in point" value={k ? k.pastCutIn : "—"} note="Still open after the date it was to take effect" alert={k?.pastCutIn > 0} />
            <StatTile icon={TriangleAlertIcon} label="Waiting for the customer" value={k ? k.customerWaiting : "—"} note="Customer approval required or asked for" />
            <StatTile icon={GitPullRequestArrowIcon} label="Closed in the period" value={k ? k.closed : "—"} note={k ? `${k.notEffective} found not effective · ${k.submitted} submitted · ${k.approved} approved` : ""} />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            <Card title="Submitted and closed" subtitle={`Per ${data?.period.bucket ?? "week"} in the period`} className="xl:col-span-7">
              {trendParts.some((p) => p.count) ? (
                <>
                  <SplitBar parts={trendParts} label="Submitted and closed in the period" unit="change" showZero />
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={data.trend} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="20%" aria-label="Changes submitted and closed per period">
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
                <Empty>Nothing submitted or closed in this period.</Empty>
              )}
            </Card>

            <Card title="How long it takes" subtitle="Average over the changes that reached each step in the period" className="xl:col-span-5">
              <RankList
                label="Average days"
                showShare={false}
                format={(v) => days(v)}
                items={[
                  { key: "approve", label: k?.daysToApprove == null ? "Submission to approval (none yet)" : "Submission to approval", count: Math.round(k?.daysToApprove ?? 0) },
                  { key: "close", label: k?.daysToClose == null ? "Submission to closure (none yet)" : "Submission to closure", count: Math.round(k?.daysToClose ?? 0) },
                ]}
              />
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card title="Waiting for a sign-off" subtitle="Pending sign-offs in the current round, longest first">
              {data?.waitingSignoffs.length ? (
                <ul aria-label="Sign-offs waiting" className="flex flex-col divide-y divide-border-color text-sm">
                  {data.waitingSignoffs.map((s) => (
                    <li key={`${s.changeId}-${s.signer}-${s.function}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="flex min-w-0 flex-col">
                        <Link to={changePath(s.changeId)} className="font-medium text-primary-text hover:underline">
                          {s.reference} · {s.title}
                        </Link>
                        <span className="text-xs text-secondary-text">
                          {s.signer} for {s.function}
                        </span>
                      </span>
                      <Chip tone={s.days >= 7 ? "error" : "neutral"}>waiting {days(s.days)}</Chip>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No sign-offs are waiting.</Empty>
              )}
            </Card>

            <Card title="Tasks overdue" subtitle="Open tasks on running changes past their due date">
              {data?.overdueTasks.length ? (
                <ul aria-label="Tasks overdue" className="flex flex-col divide-y divide-border-color text-sm">
                  {data.overdueTasks.map((t) => (
                    <li key={t.taskId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium text-primary-text">{t.description}</span>
                        <span className="text-xs text-secondary-text">
                          <Link to={changePath(t.changeId)} className="hover:underline">
                            {t.reference}
                          </Link>{" "}
                          · {t.owner} · due {formatDay(t.dueOn)}
                        </span>
                      </span>
                      <Chip tone="error">{days(t.daysLate)} late</Chip>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No tasks are overdue.</Empty>
              )}
            </Card>

            <Card title="Past the cut-in point" subtitle="Open changes whose cut-in date has gone by (recorded, never enforced)">
              {data?.pastCutInList.length ? (
                <table className="w-full text-sm" aria-label="Changes past their cut-in point">
                  <thead className="text-secondary-text">
                    <tr>
                      <th className={th}>Change</th>
                      <th className={th}>Stage</th>
                      <th className={th}>Cut-in</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pastCutInList.map((c) => (
                      <tr key={c.changeId} className="border-t border-border-color">
                        <td className={td}>
                          <Link to={changePath(c.changeId)} className="font-medium text-primary-text hover:underline">
                            {c.reference} · {c.title}
                          </Link>
                        </td>
                        <td className={`${td} text-secondary-text`}>{stageLabel(c.stage)}</td>
                        <td className={`${td} whitespace-nowrap text-secondary-text`}>
                          {formatDay(c.cutInOn)} · {days(c.daysAgo)} ago
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty>No open change is past its cut-in point.</Empty>
              )}
            </Card>

            <Card title="Recently closed" subtitle="Closed in the period, with the effectiveness check's result">
              {data?.recentlyClosed.length ? (
                <ul aria-label="Recently closed changes" className="flex flex-col divide-y divide-border-color text-sm">
                  {data.recentlyClosed.map((c) => (
                    <li key={c.changeId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="flex min-w-0 flex-col">
                        <Link to={changePath(c.changeId)} className="font-medium text-primary-text hover:underline">
                          {c.reference} · {c.title}
                        </Link>
                        <span className="text-xs text-secondary-text">Closed {formatDay(c.closedOn)}</span>
                      </span>
                      <Chip tone={c.result === "not_effective" ? "error" : "neutral"}>{c.result === "effective" ? "effective" : c.result === "not_effective" ? "not effective" : "no check recorded"}</Chip>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>Nothing closed in this period.</Empty>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
};

export default ChangeDashboard;
