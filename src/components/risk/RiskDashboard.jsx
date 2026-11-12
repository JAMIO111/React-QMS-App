import { Link } from "react-router-dom";
import { format } from "date-fns";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CalendarClockIcon, ClipboardListIcon, HandshakeIcon, ShieldAlertIcon, SparklesIcon, TriangleAlertIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import Callout from "../ui/Callout";
import { DashboardPeriodPicker } from "../dashboard/DashboardPeriod";
import { Chip, Empty, HeroCard, Pipeline, RankList, SplitBar, StatTile, headerLink as linkClass } from "../dashboard/DashboardGraphics";
import { Card, ChartTooltip, grid, tick } from "../dashboard/DashboardParts";
import { useDashboardPeriod } from "../../hooks/useDashboardPeriod";
import { useRiskDashboard, useRiskHeatmap, useRiskModel } from "../../hooks/useRisk";
import { describeApiError } from "../../lib/api-client";
import { BAND_PILL, bandLabel, formatDay, linkKindLabel, riskPath, statusLabel, strategyLabel } from "../../lib/risk";
import RiskMatrix from "./RiskMatrix";

/** Band colours for charts: the status colours, worst first; "not assessed" is grey. */
const BAND_COLOUR = { critical: "var(--chart-critical)", high: "var(--chart-serious)", medium: "var(--chart-warning)", low: "var(--chart-series-3)", unassessed: "var(--chart-neutral)" };
const TREND = [
  { key: "raised", label: "Raised", color: "var(--chart-series-1)" },
  { key: "closed", label: "Closed", color: "var(--chart-series-3)" },
];
const STAGES = ["draft", "open", "treating", "monitoring", "closed"];
const th = "py-1 pr-3 text-left text-xs font-medium uppercase tracking-wide";
const td = "py-2 pr-3 align-middle";
const late = (days) => `${days} ${days === 1 ? "day" : "days"} late`;

/**
 * Risk dashboard (`/Risk`): what is high or critical now, what is untreated, overdue for review or waiting for acceptance, a small heat map of where risks sit,
 * and what was raised and closed in the period in the address. Figures are the API's (`GET /risks-dashboard`); nothing is worked out here.
 */
const RiskDashboard = () => {
  const period = useDashboardPeriod("90d");
  const { fromIso: from, toIso: to } = period;
  const { data, isLoading, isFetching, error } = useRiskDashboard(period);
  const model = useRiskModel();
  const heat = useRiskHeatmap({ phase: "effective", kind: "risk" });
  const k = data?.kpis;
  const counts = new Map((heat.data?.cells ?? []).map((c) => [`${c.likelihood}:${c.consequence}`, c.count]));
  const bandParts = (data?.byBand ?? []).map((b) => ({ key: b.band, label: b.band === "unassessed" ? "Not assessed" : bandLabel(b.band), color: BAND_COLOUR[b.band], count: b.count }));
  const statusCount = new Map((data?.byStatus ?? []).map((s) => [s.status, s.count]));
  const trendParts = TREND.map((t) => ({ key: t.key, label: t.label, color: t.color, count: (data?.trend ?? []).reduce((n, b) => n + (b[t.key] ?? 0), 0) }));
  const bucketLabel = (start) => format(new Date(`${start}T00:00:00`), data?.period.bucket === "month" ? "MMM yy" : "d MMM");

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <ShieldAlertIcon className="h-6 w-6" aria-hidden="true" />
            Risk dashboard
          </h1>
          <p className="text-sm text-secondary-text" aria-live="polite">
            Raised and closed {formatDay(from)} – {formatDay(to)} · levels, reviews and actions as of today
            {isFetching && !isLoading ? " · updating…" : ""}
          </p>
        </div>
        <div className="flex flex-nowrap items-end gap-3 max-sm:flex-wrap">
          <Link to="/Risk/Register" className={linkClass}>
            Risk register
          </Link>
          <Link to="/Risk/Heat-map" className={linkClass}>
            Heat map
          </Link>
          <DashboardPeriodPicker period={period} />
        </div>
      </div>

      {error && (
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12" aria-busy={isLoading || undefined}>
        <HeroCard
          label="High and critical risks"
          icon={TriangleAlertIcon}
          value={k ? k.highOrCritical : "—"}
          note={k ? `${k.untreatedHigh} with no treatment chosen · of ${k.risks} live ${k.risks === 1 ? "risk" : "risks"}` : "At the level in force (after treatment when assessed)"}
          to="/Risk/Register?band=high,critical"
          className="xl:col-span-5">
          <span className="text-sm font-semibold text-primary-text">Live risks and opportunities by level</span>
          <span className="text-xs text-secondary-text">The assessment in force: after treatment when there is one, else before</span>
          {bandParts.some((b) => b.count) ? <SplitBar parts={bandParts} label="Live risks by level" unit="risk" showZero /> : <Empty>No risks in the register yet.</Empty>}
        </HeroCard>

        <Card title="Where risks sit" subtitle="Live risks on the matrix, at the level in force" className="rounded-3xl xl:col-span-7">
          {model.data && heat.data ? (
            <div className="flex flex-wrap items-start gap-4">
              <RiskMatrix config={model.data.config} compact marks={(l, c) => counts.get(`${l}:${c}`) || null} ariaLabel="Heat map of live risks" />
              <div className="flex min-w-48 flex-1 flex-col gap-2 text-sm text-secondary-text">
                <span>
                  {heat.data.placed} placed{heat.data.notPlaced ? ` · ${heat.data.notPlaced} not assessed yet` : ""}
                </span>
                <Link to="/Risk/Heat-map" className="font-medium text-primary-text hover:underline">
                  Open the heat map
                </Link>
              </div>
            </div>
          ) : (
            <Empty>{heat.error ? describeApiError(heat.error) : "Loading…"}</Empty>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-busy={isLoading || undefined}>
        <StatTile icon={CalendarClockIcon} label="Reviews overdue" value={k ? k.reviewsOverdue : "—"} note="Live risks past their review date" to="/Risk/Register?overdue=true" alert={k?.reviewsOverdue > 0} />
        <StatTile icon={ClipboardListIcon} label="Open actions" value={k ? k.openActions : "—"} note={k ? `${k.overdueActions} past their due date` : ""} alert={k?.overdueActions > 0} />
        <StatTile icon={HandshakeIcon} label="Waiting for acceptance" value={k ? k.acceptancesWaiting : "—"} note="Proposed, waiting for an approver" alert={k?.acceptancesWaiting > 0} />
        <StatTile icon={ShieldAlertIcon} label="Raised in the period" value={k ? k.raised : "—"} note={k ? `${k.raisedFromRecords} from an NC, 8D or audit finding · ${k.closed} closed` : ""} />
        <StatTile icon={SparklesIcon} label="Opportunities" value={k ? k.opportunities : "—"} note={k ? `${k.unassessed} risks and opportunities not assessed yet` : ""} to="/Risk/Register?kind=opportunity" />
      </div>

      <Card title="Where they stand" subtitle="Risks and opportunities by stage, in order (retired left out)">
        <Pipeline steps={STAGES.map((s) => ({ key: s, label: statusLabel(s), count: statusCount.get(s) ?? 0 }))} label="Risks by stage" layout="six" to={(s) => `/Risk/Register?status=${s.key}`} />
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <Card title="Highest risks" subtitle="Live risks with the highest score in force" className="xl:col-span-7">
          {data?.topRisks.length ? (
            <table className="w-full text-sm" aria-label="Highest risks">
              <thead className="text-secondary-text">
                <tr>
                  <th className={th}>Risk</th>
                  <th className={th}>Level</th>
                  <th className={th}>Owner</th>
                  <th className={th}>Stage</th>
                </tr>
              </thead>
              <tbody>
                {data.topRisks.map((r) => (
                  <tr key={r.id} className="border-t border-border-color">
                    <td className={td}>
                      <Link to={riskPath(r.id)} className="font-medium text-primary-text hover:underline">
                        {r.reference} · {r.title}
                      </Link>
                    </td>
                    <td className={`${td} whitespace-nowrap`}>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${BAND_PILL[r.band] ?? ""}`}>
                        {r.score} · {bandLabel(r.band)}
                      </span>
                    </td>
                    <td className={`${td} text-secondary-text`}>{r.owner ?? "—"}</td>
                    <td className={`${td} text-secondary-text`}>{statusLabel(r.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No assessed risks yet.</Empty>
          )}
        </Card>

        <Card title="By category" subtitle="Live risks and opportunities in each category" className="xl:col-span-5">
          {data?.byCategory.length ? (
            <RankList items={data.byCategory.map((c) => ({ key: c.categoryId, label: c.highOrCritical ? `${c.label} (${c.highOrCritical} high or critical)` : c.label, count: c.count }))} label="Risks by category" />
          ) : (
            <Empty>No risks yet.</Empty>
          )}
          {data?.byStrategy.length > 0 && (
            <div className="mt-4 flex flex-col gap-2">
              <span className="text-sm font-semibold text-primary-text">What is being done</span>
              <RankList items={data.byStrategy.map((s) => ({ key: s.strategy ?? "none", label: s.strategy ? strategyLabel(s.strategy, s.strategy === "exploit" ? "opportunity" : "risk") : "Not decided", count: s.count }))} label="Assessed risks by treatment" />
            </div>
          )}
        </Card>
      </div>

      <Card title="Raised and closed" subtitle={`Per ${data?.period.bucket ?? "week"} in the period`}>
        {trendParts.some((p) => p.count) ? (
          <>
            <SplitBar parts={trendParts} label="Raised and closed in the period" unit="risk" showZero />
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.trend} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="20%" aria-label="Risks raised and closed per period">
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
          <Empty>Nothing raised or closed in this period.</Empty>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="Reviews overdue" subtitle="Live risks past their review date, longest first">
          {data?.overdueReviews.length ? (
            <ul aria-label="Reviews overdue" className="flex flex-col divide-y divide-border-color text-sm">
              {data.overdueReviews.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="flex min-w-0 flex-col">
                    <Link to={riskPath(r.id)} className="font-medium text-primary-text hover:underline">
                      {r.reference} · {r.title}
                    </Link>
                    <span className="text-xs text-secondary-text">{r.owner ?? "No owner"} · due {formatDay(r.nextReviewOn)}</span>
                  </span>
                  <Chip tone="error">{late(r.days)}</Chip>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No reviews are overdue.</Empty>
          )}
        </Card>

        <Card title="Actions overdue" subtitle="Open risk actions past their due date">
          {data?.overdueActions.length ? (
            <ul aria-label="Actions overdue" className="flex flex-col divide-y divide-border-color text-sm">
              {data.overdueActions.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium text-primary-text">{a.description}</span>
                    <span className="text-xs text-secondary-text">
                      <Link to={riskPath(a.riskId)} className="hover:underline">
                        {a.reference} · {a.title}
                      </Link>{" "}
                      · {a.owner ?? "No one"}
                    </span>
                  </span>
                  <Chip tone="error">{late(a.days)}</Chip>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No actions are overdue.</Empty>
          )}
        </Card>

        <Card title="Waiting for acceptance" subtitle="An approver other than the proposer decides">
          {data?.waitingAcceptances.length ? (
            <ul aria-label="Acceptances waiting" className="flex flex-col divide-y divide-border-color text-sm">
              {data.waitingAcceptances.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="flex min-w-0 flex-col">
                    <Link to={riskPath(a.riskId)} className="font-medium text-primary-text hover:underline">
                      {a.reference} · {a.title}
                    </Link>
                    <span className="text-xs text-secondary-text">
                      Proposed by {a.proposedBy ?? "someone"} on {formatDay(a.proposedAt.slice(0, 10))}
                    </span>
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${BAND_PILL[a.band] ?? ""}`}>{bandLabel(a.band)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing is waiting for acceptance.</Empty>
          )}
        </Card>

        <Card title="Raised from a problem" subtitle="The latest risks raised from a non-conformance, an 8D or an audit finding">
          {data?.raisedFromRecords.length ? (
            <ul aria-label="Risks raised from records" className="flex flex-col divide-y divide-border-color text-sm">
              {data.raisedFromRecords.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="flex min-w-0 flex-col">
                    <Link to={riskPath(r.id)} className="font-medium text-primary-text hover:underline">
                      {r.reference} · {r.title}
                    </Link>
                    <span className="text-xs text-secondary-text">
                      From {linkKindLabel(r.originKind).toLowerCase()} · {formatDay(r.createdAt.slice(0, 10))}
                    </span>
                  </span>
                  {r.band ? <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${BAND_PILL[r.band] ?? ""}`}>{bandLabel(r.band)}</span> : <Chip>not assessed</Chip>}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No risks raised from a problem yet.</Empty>
          )}
        </Card>
      </div>
    </div>
  );
};

export default RiskDashboard;
