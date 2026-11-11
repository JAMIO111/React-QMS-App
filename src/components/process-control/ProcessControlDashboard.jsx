import { Link } from "react-router-dom";
import { format } from "date-fns";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ActivityIcon, ArrowRightIcon, ChartNoAxesCombinedIcon, CircleCheckIcon, ClipboardCheckIcon, ClipboardListIcon, HourglassIcon, TriangleAlertIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import Callout from "../ui/Callout";
import { DashboardPeriodPicker } from "../dashboard/DashboardPeriod";
import { ChangeNote, Chip, Empty, HeroCard, Meter, Pipeline, RankList, SeriesLegend, SplitBar, StatTile, cardLink, headerLink } from "../dashboard/DashboardGraphics";
import { Card, ChartTooltip, grid, percent, pctChange, stackedBarShape, tick } from "../dashboard/DashboardParts";
import { useDashboardPeriod } from "../../hooks/useDashboardPeriod";
import { usePermissions } from "../../hooks/useQmsApi";
import { useProcessControlDashboard } from "../../hooks/useProcessControl";
import { describeApiError } from "../../lib/api-client";
import { formatDate, formatDateTime } from "../../lib/processControl";
import { RULE_LABEL } from "../../lib/spc";

const RESULT_SERIES = [
  { key: "pass", label: "Passed", color: "var(--chart-series-3)" },
  { key: "fail", label: "Failed", color: "var(--chart-critical)" },
  { key: "inProgress", label: "In progress", color: "var(--chart-series-1)" },
];
const ATTENTION = {
  awaiting_approval: {
    label: "Awaiting approval",
    detail: (r) => `Revision ${r.revisionCode} submitted${r.by ? ` by ${r.by}` : ""}`,
  },
  no_effective_revision: {
    label: "No effective revision",
    detail: () => "Inspections cannot start for its parts",
  },
  review_due: {
    label: "Review due",
    detail: (r) => `Revision ${r.revisionCode} effective since ${formatDate(r.since)}`,
  },
};
const th = "py-1 pr-3 text-left text-xs font-medium uppercase tracking-wide";
const td = "py-2 pr-3 align-top";
const ruleName = (rule) => (rule === "range" ? "Range / moving range" : (RULE_LABEL[rule]?.short ?? rule));
const age = (hours) => (hours < 24 ? `${Math.round(hours)} h` : `${Math.floor(hours / 24)} d ${Math.round(hours % 24)} h`);

/**
 * Process control dashboard (/Process-Control): the control plan pipeline and SPC signals as of today,
 * inspection activity for a period, and the failures and inspections that need someone. The period is in the URL.
 */
const ProcessControlDashboard = () => {
  const { can } = usePermissions();
  const period = useDashboardPeriod("90d");
  const { fromIso: from, toIso: to } = period;
  const { data, isLoading, isFetching, error } = useProcessControlDashboard({
    from,
    to,
  });
  const k = data?.kpis;
  const spc = data?.spc;
  const canInspect = can("inspection.read");
  const inspectionChange = k ? pctChange(k.inspections, k.inspectionsPrevious) : null;
  const resultParts = RESULT_SERIES.map((r) => ({ key: r.key, label: r.label, color: r.color, count: (data?.inspectionsByPeriod ?? []).reduce((n, b) => n + (b[r.key] ?? 0), 0) }));
  const bucketLabel = (start) => format(new Date(`${start}T00:00:00`), data?.period.bucket === "month" ? "MMM yy" : "d MMM");

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <ChartNoAxesCombinedIcon className="h-6 w-6" aria-hidden="true" />
            Process control dashboard
          </h1>
          <p className="text-sm text-secondary-text" aria-live="polite">
            Plans and SPC as of today · inspections {formatDate(from)} – {formatDate(to)}
            {isFetching && !isLoading ? " · updating…" : ""}
          </p>
        </div>
        <div className="flex flex-nowrap items-end gap-3 max-sm:flex-wrap">
          <Link
            to="/Process-Control/Plans"
            className={headerLink}
          >
            Control plans
          </Link>
          {spc?.available !== false && (
            <Link
              to="/Process-Control/SPC"
              className={headerLink}
            >
              SPC charts
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

      {/* Inspections in the period beside where the control plan revisions stand today. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12" aria-busy={isLoading || undefined}>
        <HeroCard
          label="Inspections"
          icon={ClipboardListIcon}
          value={k ? k.inspections.toLocaleString("en-GB") : "—"}
          note={
            k ? (
              <>
                {inspectionChange !== null && (
                  <span className="mr-2">
                    <ChangeNote change={inspectionChange} />
                  </span>
                )}
                <span>{k.inProgress} in progress</span>
              </>
            ) : (
              "Started in the period"
            )
          }
          to={canInspect ? "/Inspections" : undefined}
          className="xl:col-span-5">
          {canInspect && (
            <>
              <span className="text-sm font-semibold text-primary-text">Results</span>
              {resultParts.some((r) => r.count) ? <SplitBar parts={resultParts} label="Inspection results in the period" unit="inspection" tall showZero /> : <Empty>No inspections in this period.</Empty>}
            </>
          )}
        </HeroCard>

        <Card
          title="Control plan revisions"
          subtitle="Active plans, by where each revision stands right now"
          action={
            <Link to="/Process-Control/Plans" className={cardLink}>
              Control plans <ArrowRightIcon aria-hidden="true" />
            </Link>
          }
          className="justify-between rounded-3xl xl:col-span-7">
          {data?.revisionsByStatus?.length ? <Pipeline steps={data.revisionsByStatus} label="Control plan revisions by status" layout="six" /> : <Empty>No control plans yet.</Empty>}
          <p className="text-xs text-secondary-text">
            {k ? (k.plansWithoutEffective ? `${k.plansWithoutEffective} active ${k.plansWithoutEffective === 1 ? "plan has" : "plans have"} no effective revision, so inspections cannot start for their parts.` : "Every active plan has a revision in force.") : ""}
          </p>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-busy={isLoading || undefined}>
        <StatTile icon={HourglassIcon} label="Awaiting approval" value={k ? k.awaitingApproval : "—"} note="Plan revisions to review" to="/Process-Control/Plans" alert={k?.awaitingApproval > 0} />
        <StatTile
          icon={ClipboardCheckIcon}
          label="Effective plans"
          value={k ? k.effectivePlans : "—"}
          note={k ? (k.plansWithoutEffective ? `${k.plansWithoutEffective} active without one` : "Every active plan is in force") : ""}
          to="/Process-Control/Plans"
        />
        <StatTile icon={CircleCheckIcon} label="Pass first time" value={k ? percent(k.firstPassRate) : "—"} note="Completed inspections in the period">
          {k?.firstPassRate !== null && k?.firstPassRate !== undefined && <Meter part={k.firstPassRate} whole={100} label="Completed inspections that passed first time" />}
        </StatTile>
        <StatTile icon={TriangleAlertIcon} label="Open failures" value={k ? k.openFailures : "—"} note="Need an acknowledgement or an NC" to={canInspect ? "/Inspections" : undefined} alert={k?.openFailures > 0} />
        <StatTile
          icon={ActivityIcon}
          label="SPC signals (30 days)"
          value={spc?.available ? spc.signalCount : "—"}
          note={spc?.available ? `${spc.withSignals} of ${spc.monitored} charts` : spc ? "No access to SPC" : ""}
          to={spc?.available ? "/Process-Control/SPC" : undefined}
          alert={spc?.signalCount > 0}>
          {spc?.available && spc.monitored > 0 && <Meter part={spc.withSignals} whole={spc.monitored} color="var(--chart-serious)" label="Charts with a signal, of those watched" />}
        </StatTile>
      </div>

      {(canInspect || spc?.available) && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
          {canInspect && (
            <Card title="Inspections" subtitle={`Started per ${data?.period.bucket ?? "week"}, by result`} className="xl:col-span-7">
              <SeriesLegend series={RESULT_SERIES} label="Inspection results" />
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data?.inspectionsByPeriod ?? []} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="20%" aria-label="Inspections per period">
                    <CartesianGrid {...grid} />
                    <XAxis dataKey="start" tickFormatter={bucketLabel} tick={tick} axisLine={false} tickLine={false} minTickGap={12} />
                    <YAxis allowDecimals={false} tick={tick} axisLine={false} tickLine={false} />
                    <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={<ChartTooltip labelFormat={bucketLabel} />} />
                    {RESULT_SERIES.map((s) => (
                      <Bar key={s.key} dataKey={s.key} name={s.label} stackId="results" fill={s.color} stroke="rgb(var(--secondary-bg))" strokeWidth={2} shape={stackedBarShape(RESULT_SERIES.map((x) => x.key))} maxBarSize={24} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          )}

          <div className={`flex flex-col gap-4 ${canInspect ? "xl:col-span-5" : "xl:col-span-12"}`}>
            {canInspect && (
              <Card title="Failures by characteristic" subtitle="Failed readings in the period (corrected ones left out)" className="flex-1">
                {data?.failuresByCharacteristic.length ? (
                  <RankList items={data.failuresByCharacteristic} label="Failed readings by characteristic" color="var(--chart-critical)" />
                ) : (
                  <Empty>No failed readings in this period.</Empty>
                )}
              </Card>
            )}
            {spc?.available && (
              <Card
                title="SPC signals by rule"
                subtitle={`Last ${spc.windowDays} days, across ${spc.monitored} charted characteristic${spc.monitored === 1 ? "" : "s"}${spc.withoutBaseline ? ` · ${spc.withoutBaseline} without a saved baseline` : ""}`}
                className="flex-1">
                {spc.byRule.length ? (
                  <RankList items={spc.byRule.map((r) => ({ key: r.rule, label: ruleName(r.rule), count: r.count }))} label="SPC signals by rule" color="var(--chart-serious)" />
                ) : (
                  <Empty>No signals in the last {spc.windowDays} days.</Empty>
                )}
              </Card>
            )}
          </div>
        </div>
      )}

      {spc?.available && (
        <Card
          title="Latest SPC signals"
          subtitle="A process signal means look into it; it does not mean product is nonconforming"
          action={
            <Link to="/Process-Control/SPC" className={cardLink}>
              Open SPC charts <ArrowRightIcon aria-hidden="true" />
            </Link>
          }
        >
          {spc.recent.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="Latest SPC signals">
                <thead className="text-secondary-text">
                  <tr>
                    <th className={th}>Part · characteristic</th>
                    <th className={th}>Signal</th>
                    <th className={th}>When</th>
                    <th className={th}>Inspection</th>
                  </tr>
                </thead>
                <tbody className="text-primary-text">
                  {spc.recent.map((s, i) => (
                    <tr key={i} className="border-t border-border-color">
                      <td className={td}>
                        <Link className="text-link-color hover:underline" to={`/Process-Control/SPC?part=${s.partId}&c=${encodeURIComponent(`${s.characteristicKey}|${s.operationCode}`)}`}>
                          {s.partNumber} · {s.characteristicName}
                        </Link>
                        <span className="text-secondary-text"> · {s.operationCode}</span>
                      </td>
                      <td className={td}>
                        <span className="font-medium">{ruleName(s.rule)}</span> <span className="text-secondary-text">{s.text}</span>
                      </td>
                      <td className={`${td} whitespace-nowrap`}>{formatDateTime(s.at)}</td>
                      <td className={td}>
                        {s.inspections.map((x) => (
                          <Link key={x.id} className="mr-2 text-link-color hover:underline" to={`/Inspections/${x.id}`}>
                            {x.reference}
                          </Link>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No signals in the last {spc.windowDays} days.</Empty>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="Control plans needing attention" subtitle="Awaiting approval, without an effective revision, or in force for over a year">
          {data?.planAttention.length ? (
            <ul className="flex flex-col divide-y divide-border-color text-sm" aria-label="Control plans needing attention">
              {data.planAttention.map((p, i) => (
                <li key={`${p.planId}-${i}`} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                  <span>
                    <Link className="text-link-color hover:underline" to={p.revisionId ? `/Process-Control/Plans/${p.planId}/revisions/${p.revisionId}` : `/Process-Control/Plans/${p.planId}`}>
                      {p.planCode}
                    </Link>{" "}
                    <span className="text-secondary-text">{p.title}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-xs text-secondary-text">
                    <Chip tone={p.kind === "review_due" ? "neutral" : p.kind === "awaiting_approval" ? "warning" : "error"}>{ATTENTION[p.kind].label}</Chip>
                    {ATTENTION[p.kind].detail(p)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Every plan is approved and current.</Empty>
          )}
        </Card>

        {canInspect && (
          <Card title="Failures needing action" subtitle="Failed readings with no acknowledgement and no non-conformance">
            {data?.openFailures.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" aria-label="Failures needing action">
                  <thead className="text-secondary-text">
                    <tr>
                      <th className={th}>Inspection</th>
                      <th className={th}>Reading</th>
                      <th className={th}>Limits</th>
                      <th className={th}>When</th>
                    </tr>
                  </thead>
                  <tbody className="text-primary-text">
                    {data.openFailures.map((f, i) => (
                      <tr key={i} className="border-t border-border-color">
                        <td className={td}>
                          <Link className="text-link-color hover:underline" to={`/Inspections/${f.inspectionId}`}>
                            {f.reference}
                          </Link>{" "}
                          <span className="text-secondary-text">{f.partNumber}</span>
                        </td>
                        <td className={td}>
                          {f.characteristic}: <span className="font-medium text-error-color tabular-nums">{f.value}</span>
                        </td>
                        <td className={`${td} tabular-nums`}>{f.limits}</td>
                        <td className={`${td} whitespace-nowrap`}>{formatDateTime(f.measuredAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>Every failed reading has been handled.</Empty>
            )}
          </Card>
        )}
      </div>

      {canInspect && (
        <Card title="Inspections in progress" subtitle="Oldest first; an inspection open for more than a day is highlighted">
          {data?.inProgress.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="Inspections in progress">
                <thead className="text-secondary-text">
                  <tr>
                    <th className={th}>Inspection</th>
                    <th className={th}>Part</th>
                    <th className={th}>Operation</th>
                    <th className={th}>Started</th>
                    <th className={`${th} text-right`}>Samples</th>
                    <th className={`${th} text-right`}>Open for</th>
                  </tr>
                </thead>
                <tbody className="text-primary-text">
                  {data.inProgress.map((r) => (
                    <tr key={r.id} className="border-t border-border-color">
                      <td className={td}>
                        <Link className="text-link-color hover:underline" to={`/Inspections/${r.id}`}>
                          {r.reference}
                        </Link>
                      </td>
                      <td className={td}>{r.partNumber}</td>
                      <td className={td}>{r.operationCode ?? "All"}</td>
                      <td className={`${td} whitespace-nowrap`}>{formatDateTime(r.startedAt)}</td>
                      <td className={`${td} text-right tabular-nums`}>{r.samples}</td>
                      <td className={`${td} text-right tabular-nums ${r.ageHours >= 24 ? "text-error-color" : ""}`}>{age(r.ageHours)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No inspections in progress.</Empty>
          )}
        </Card>
      )}
    </div>
  );
};

export default ProcessControlDashboard;
