import { Link } from "react-router-dom";
import { format } from "date-fns";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CircleCheckIcon, ClipboardCheckIcon, ClipboardListIcon, HistoryIcon, HourglassIcon, TriangleAlertIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import Callout from "../ui/Callout";
import { DashboardPeriodPicker } from "../dashboard/DashboardPeriod";
import { ArcGauge, Chip, Empty, HeroCard, Meter, RankList, SeriesLegend, SplitBar, StatTile, headerLink } from "../dashboard/DashboardGraphics";
import { Card, ChartTooltip, grid, percent, pctChange, stackedBarShape, tick } from "../dashboard/DashboardParts";
import { useDashboardPeriod } from "../../hooks/useDashboardPeriod";
import { useAuditsDashboard } from "../../hooks/useAudits";
import { describeApiError } from "../../lib/api-client";
import { formatDate, formatDateTime } from "../../lib/processControl";

// Fixed colour per state (never by rank), from the validated chart palette.
const PLANNED_SERIES = [
  { key: "done", label: "Done on time", color: "var(--chart-series-3)" },
  { key: "late", label: "Done late", color: "var(--chart-warning)" },
  { key: "overdue", label: "Overdue", color: "var(--chart-serious)" },
  { key: "missed", label: "Missed", color: "var(--chart-critical)" },
  { key: "upcoming", label: "Still to come", color: "var(--chart-neutral)" },
];
const RESULT_SERIES = [
  { key: "pass", label: "Passed", color: "var(--chart-series-3)" },
  { key: "fail", label: "Failed", color: "var(--chart-critical)" },
];
const KIND_LABEL = { machine: "Machine", operation: "Operation", department: "Department", supplier: "Supplier" };
const th = "py-1 pr-3 text-left text-xs font-medium uppercase tracking-wide";
const td = "py-2 pr-3 align-top";
const row = "flex flex-wrap items-center justify-between gap-2 py-2";
const sum = (rows, series) => series.map((s) => ({ key: s.key, label: s.label, color: s.color, count: (rows ?? []).reduce((n, b) => n + (b[s.key] ?? 0), 0) }));

/** A stacked bar chart per week or month; the legend is given beside it by whoever draws it. */
const Stacked = ({ data, series, bucketLabel, name }) => (
  <div className="h-60">
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="20%" aria-label={name}>
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
 * Audits dashboard (/Audits): audits planned and done in a period, results, findings, the questions that fail most, how recently each machine, operation and
 * department was covered, and the latest changes to audit templates. Findings and coverage are as of today. The period is in the URL.
 */
const AuditsDashboard = () => {
  const period = useDashboardPeriod("90d");
  const { fromIso: from, toIso: to } = period;
  const { data, isLoading, isFetching, error } = useAuditsDashboard({ from, to });
  const k = data?.kpis;
  const bucket = data?.period.bucket ?? "week";
  const bucketLabel = (start) => format(new Date(`${start}T00:00:00`), bucket === "month" ? "MMM yy" : "d MMM");
  const plannedParts = sum(data?.planned, PLANNED_SERIES);
  const resultParts = sum(data?.results, RESULT_SERIES);

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <ClipboardCheckIcon className="h-6 w-6" aria-hidden="true" />
            Audits dashboard
          </h1>
          <p className="text-sm text-secondary-text" aria-live="polite">
            Audits {formatDate(from)} – {formatDate(to)} · findings and coverage as of today
            {isFetching && !isLoading ? " · updating…" : ""}
          </p>
        </div>
        <div className="flex flex-nowrap items-end gap-3 max-sm:flex-wrap">
          <Link to="/Audits/Schedule" className={headerLink}>
            Audit schedule
          </Link>
          <Link to="/Audits/Records" className={headerLink}>
            Audit records
          </Link>
          <DashboardPeriodPicker period={period} />
        </div>
      </div>

      {error && (
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      )}

      {/* What was planned and how it went. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12" aria-busy={isLoading || undefined}>
        <HeroCard
          label="Done as planned"
          icon={ClipboardCheckIcon}
          value={k ? `${k.done} of ${k.planned}` : "—"}
          note={k ? (k.onTimeRate === null ? "Nothing decided yet" : `${percent(k.onTimeRate)} on time`) : "Audits due in the period"}
          to="/Audits/Schedule"
          className="xl:col-span-5">
          <span className="text-sm font-semibold text-primary-text">How the audits due in the period stand</span>
          {plannedParts.some((p) => p.count) ? <SplitBar parts={plannedParts} label="Audits due in the period" unit="audit" tall /> : <Empty>No audit was due in this period.</Empty>}
        </HeroCard>

        <Card title="How the audits went" subtitle={`Audits due and completed ${formatDate(from)} – ${formatDate(to)}`} className="rounded-3xl xl:col-span-7">
          <div className="grid flex-1 grid-cols-2 gap-3 lg:grid-cols-4">
            <ArcGauge label="Completion" value={k?.completionRate ?? null} display={k ? percent(k.completionRate) : "—"} note="Done, of those done, missed or overdue" />
            <ArcGauge label="On time" value={k?.onTimeRate ?? null} display={k ? percent(k.onTimeRate) : "—"} note="Done by the due date and its grace, of those done or missed" />
            <ArcGauge label="Passed" value={k?.passRate ?? null} display={k ? percent(k.passRate) : "—"} note="Of the audits completed in the period" />
            <ArcGauge label="Average score" value={k?.averageScore ?? null} display={k ? percent(k.averageScore) : "—"} note="Across the audits completed in the period" />
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-busy={isLoading || undefined}>
        <StatTile icon={HourglassIcon} label="Overdue or missed" value={k ? k.overdue + k.missed : "—"} note={k ? `${k.overdue} overdue · ${k.missed} missed` : ""} to="/Audits/Schedule?state=overdue" alert={k?.overdue + k?.missed > 0} />
        <StatTile
          icon={ClipboardListIcon}
          label="Audits completed"
          value={k ? k.completed : "—"}
          change={k ? pctChange(k.completed, k.completedPrevious) : null}
          note={k ? (k.passRate === null ? "None in the period" : `${percent(k.passRate)} passed${k.averageScore === null ? "" : ` · average score ${k.averageScore}%`}`) : ""}
          to="/Audits/Records"
        />
        <StatTile
          icon={TriangleAlertIcon}
          label="Open findings"
          value={k ? k.openFindings : "—"}
          note={k ? (k.overdueFindings ? `${k.overdueFindings} overdue` : "None overdue") : ""}
          to="/Audits/Findings?status=open"
          alert={k?.overdueFindings > 0}>
          {k?.openFindings > 0 && <Meter part={k.overdueFindings} whole={k.openFindings} color="var(--chart-critical)" label="Open findings past their due date" />}
        </StatTile>
        <StatTile
          icon={CircleCheckIcon}
          label="Findings raised"
          value={k ? k.findingsRaised : "—"}
          change={k ? pctChange(k.findingsRaised, k.findingsRaisedPrevious) : null}
          higherIsWorse
          note={k ? `${k.nonconformances} became a non-conformance` : ""}
          to="/Audits/Findings"
        />
        <StatTile icon={HistoryIcon} label="Template changes" value={k ? k.versionsSaved : "—"} note="New versions of audits in the period" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="Planned and done" subtitle={`Audits due per ${bucket}, by how they stand`}>
          <SeriesLegend series={PLANNED_SERIES} label="How audits stand" />
          <Stacked data={data?.planned ?? []} series={PLANNED_SERIES} bucketLabel={bucketLabel} name="Audits due per period" />
        </Card>

        <Card title="Results" subtitle={`Audits completed per ${bucket}`}>
          <SplitBar parts={resultParts} label="Results of the audits completed in the period" unit="audit" showZero />
          <Stacked data={data?.results ?? []} series={RESULT_SERIES} bucketLabel={bucketLabel} name="Audit results per period" />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <Card title="Findings by classification" subtitle="Raised in the period (withdrawn ones left out); non-conformities in red" className="xl:col-span-5">
          {data?.findingsByClassification.some((c) => c.count) ? (
            <RankList items={data.findingsByClassification} label="Findings by classification" colorOf={(d) => (d.kind === "nonconformity" ? "var(--chart-critical)" : "var(--chart-series-1)")} />
          ) : (
            <Empty>No findings were raised in this period.</Empty>
          )}
          <p className="text-xs text-secondary-text">{(data?.findingsByStatus ?? []).map((s) => `${s.label} ${s.count}`).join(" · ")}</p>
        </Card>

        <Card title="Questions that fail most often" subtitle="Across the audits completed in the period" className="xl:col-span-7">
          {data?.failedQuestions.length ? (
            <table className="w-full text-sm" aria-label="Questions that fail most often">
              <thead className="text-secondary-text">
                <tr>
                  <th className={th}>Question</th>
                  <th className={th}>Audit</th>
                  <th className={`${th} w-1/4`}>
                    <span className="sr-only">Share failed</span>
                  </th>
                  <th className={`${th} text-right`}>Failed</th>
                </tr>
              </thead>
              <tbody className="text-primary-text">
                {data.failedQuestions.map((q) => (
                  <tr key={`${q.auditId}-${q.question}`} className="border-t border-border-color">
                    <td className={td}>{q.question}</td>
                    <td className={td}>
                      <Link className="text-link-color hover:underline" to={`/Audits/Templates/${q.auditId}`}>
                        {q.auditReference}
                      </Link>
                    </td>
                    <td className={`${td} align-middle`} aria-hidden="true">
                      <Meter part={q.failed} whole={q.answered} color="var(--chart-critical)" label="Share failed" />
                    </td>
                    <td className={`${td} whitespace-nowrap text-right tabular-nums`}>
                      {q.failed} of {q.answered} <span className="text-secondary-text">({percent(q.failRate)})</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No question failed in this period.</Empty>
          )}
        </Card>
      </div>

      <Card
        title="Coverage"
        subtitle={
          data
            ? `${data.coverage.listed} machines, operations, departments and suppliers named by active audits · ${data.coverage.never} never audited · ${data.coverage.stale} not audited for over ${data.coverage.staleAfterDays} days`
            : "When each was last covered by a completed audit"
        }>
        {data?.coverage.listed > 0 && (
          <SplitBar
            label="Coverage"
            unit="item"
            parts={[
              { key: "covered", label: `Audited in the last ${data.coverage.staleAfterDays} days`, color: "var(--chart-series-3)", count: Math.max(0, data.coverage.listed - data.coverage.never - data.coverage.stale) },
              { key: "stale", label: `Not for over ${data.coverage.staleAfterDays} days`, color: "var(--chart-warning)", count: data.coverage.stale },
              { key: "never", label: "Never audited", color: "var(--chart-critical)", count: data.coverage.never },
            ]}
            showZero
          />
        )}
        {data?.coverage.items.length ? (
          <table className="w-full text-sm" aria-label="Coverage">
            <thead className="text-secondary-text">
              <tr>
                <th className={th}>Covered</th>
                <th className={th}>Kind</th>
                <th className={th}>Last audited</th>
                <th className={th}>By</th>
              </tr>
            </thead>
            <tbody className="text-primary-text">
              {data.coverage.items.map((c) => (
                <tr key={`${c.kind}-${c.label}`} className="border-t border-border-color">
                  <td className={td}>{c.label}</td>
                  <td className={td}>{KIND_LABEL[c.kind]}</td>
                  <td className={td}>
                    {c.lastAuditedOn === null ? (
                      <Chip tone="error">Never</Chip>
                    ) : (
                      <span className="flex flex-wrap items-center gap-2">
                        {formatDate(c.lastAuditedOn)}
                        <Chip tone={c.daysSince > data.coverage.staleAfterDays ? "warning" : "neutral"}>{c.daysSince === 0 ? "today" : `${c.daysSince} ${c.daysSince === 1 ? "day" : "days"} ago`}</Chip>
                      </span>
                    )}
                  </td>
                  <td className={td}>{c.audits.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No active audit names a machine, operation, department or supplier.</Empty>
        )}
        {data && data.coverage.listed > data.coverage.items.length && <p className="text-xs text-secondary-text">The {data.coverage.items.length} longest without an audit are shown.</p>}
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="Audits that need doing" subtitle="Overdue now, or missed in the period">
          {data?.slotsNeedingAttention.length ? (
            <ul aria-label="Audits that need doing" className="flex flex-col divide-y divide-border-color text-sm text-primary-text">
              {data.slotsNeedingAttention.map((s) => (
                <li key={`${s.auditId}-${s.dueOn}`} className={row}>
                  <span>
                    <Link className="font-medium text-link-color hover:underline" to={`/Audits/Templates/${s.auditId}`}>
                      {s.auditReference}
                    </Link>{" "}
                    · {s.auditTitle}
                  </span>
                  <Chip tone={s.state === "missed" ? "error" : "warning"}>
                    {s.state === "missed" ? "Missed" : "Overdue"}, due {formatDate(s.dueOn)}
                  </Chip>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing is overdue or missed.</Empty>
          )}
        </Card>

        <Card title="Findings past their due date" subtitle="Still open">
          {data?.overdueFindings.length ? (
            <ul aria-label="Findings past their due date" className="flex flex-col divide-y divide-border-color text-sm text-primary-text">
              {data.overdueFindings.map((f) => (
                <li key={f.id} className={row}>
                  <span className="flex min-w-0 flex-col">
                    <span>
                      <Link className="font-medium text-link-color hover:underline" to={`/Audits/Findings/${f.id}`}>
                        {f.reference}
                      </Link>{" "}
                      · {f.title}
                    </span>
                    <span className="text-xs text-secondary-text">
                      {f.classification} · due {formatDate(f.dueOn)}
                      {f.owner ? ` · ${f.owner}` : ""}
                    </span>
                  </span>
                  <Chip tone="error">
                    {f.daysOverdue} {f.daysOverdue === 1 ? "day" : "days"} late
                  </Chip>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No open finding is past its due date.</Empty>
          )}
        </Card>

        <Card title="Latest failed audits" subtitle="Completed in the period">
          {data?.failedRecords.length ? (
            <ul aria-label="Latest failed audits" className="flex flex-col divide-y divide-border-color text-sm text-primary-text">
              {data.failedRecords.map((r) => (
                <li key={r.id} className={row}>
                  <span>
                    <Link className="font-medium text-link-color hover:underline" to={`/Audits/Records/${r.id}`}>
                      {r.reference}
                    </Link>{" "}
                    · {r.auditTitle}
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-xs text-secondary-text">
                    {formatDate(r.performedOn)}
                    {r.score === null ? "" : ` · ${r.score}%`}
                    {r.criticalFailed ? <Chip tone="error">{r.criticalFailed} critical</Chip> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No audit failed in this period.</Empty>
          )}
        </Card>

        <Card title="Recent changes to audits" subtitle="New versions, with the reason">
          {data?.recentVersions.length ? (
            <ul aria-label="Recent changes to audits" className="flex flex-col divide-y divide-border-color text-sm text-primary-text">
              {data.recentVersions.map((v) => (
                <li key={`${v.auditId}-${v.version}`} className="flex flex-col gap-0.5 py-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <span>
                      <Link className="font-medium text-link-color hover:underline" to={`/Audits/Templates/${v.auditId}`}>
                        {v.auditReference}
                      </Link>{" "}
                      · {v.auditTitle}
                    </span>
                    <Chip>version {v.version}</Chip>
                  </span>
                  <span className="text-xs text-secondary-text">
                    {v.reason} — {formatDateTime(v.at)}
                    {v.by ? `, ${v.by}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No audit was changed in this period.</Empty>
          )}
        </Card>
      </div>
    </div>
  );
};

export default AuditsDashboard;
