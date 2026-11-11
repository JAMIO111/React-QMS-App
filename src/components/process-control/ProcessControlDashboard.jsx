import { Link } from "react-router-dom";
import { format } from "date-fns";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ActivityIcon,
  CalendarIcon,
  CircleCheckIcon,
  ClipboardCheckIcon,
  ClipboardListIcon,
  HourglassIcon,
  TriangleAlertIcon,
} from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import { DashboardPeriodPicker } from "../dashboard/DashboardPeriod";
import { useDashboardPeriod } from "../../hooks/useDashboardPeriod";
import RHFComboBox from "../ui/RHFComboBox";
import {
  Card,
  ChartTooltip,
  HBars,
  Kpi,
  grid,
  percent,
  pctChange,
  stackedBarShape,
  tick,
} from "../dashboard/DashboardParts";
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
const REVISION_COLOR = {
  draft: "var(--chart-neutral)",
  pending_approval: "var(--chart-warning)",
  approved: "var(--chart-series-1)",
  effective: "var(--chart-series-3)",
  superseded: "var(--chart-neutral)",
  obsolete: "var(--chart-neutral)",
};
const ATTENTION = {
  awaiting_approval: {
    label: "Awaiting approval",
    detail: (r) =>
      `Revision ${r.revisionCode} submitted${r.by ? ` by ${r.by}` : ""}`,
  },
  no_effective_revision: {
    label: "No effective revision",
    detail: () => "Inspections cannot start for its parts",
  },
  review_due: {
    label: "Review due",
    detail: (r) =>
      `Revision ${r.revisionCode} effective since ${formatDate(r.since)}`,
  },
};
const th = "py-1 pr-2 text-left font-medium";
const td = "py-1.5 pr-2 align-top";
const ruleName = (rule) =>
  rule === "range" ? "Range / moving range" : (RULE_LABEL[rule]?.short ?? rule);
const age = (hours) =>
  hours < 24
    ? `${Math.round(hours)} h`
    : `${Math.floor(hours / 24)} d ${Math.round(hours % 24)} h`;

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
  const bucketLabel = (start) =>
    format(
      new Date(`${start}T00:00:00`),
      data?.period.bucket === "month" ? "MMM yy" : "d MMM",
    );

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="text-2xl font-semibold text-primary-text">
            Process control dashboard
          </h1>
          <p className="text-sm text-secondary-text" aria-live="polite">
            Plans and SPC as of today · inspections {formatDate(from)} –{" "}
            {formatDate(to)}
            {isFetching && !isLoading ? " · updating…" : ""}
          </p>
        </div>
        <div className="flex flex-nowrap items-end gap-3 max-sm:flex-wrap">
          <Link
            to="/Process-Control/Plans"
            className="shrink-0 whitespace-nowrap rounded-lg border border-border-color bg-secondary-bg px-3 py-1.5 text-sm text-primary-text hover:bg-border-color/50"
          >
            Control plans
          </Link>
          {spc?.available !== false && (
            <Link
              to="/Process-Control/SPC"
              className="shrink-0 whitespace-nowrap rounded-lg border border-border-color bg-secondary-bg px-3 py-1.5 text-sm text-primary-text hover:bg-border-color/50"
            >
              SPC charts
            </Link>
          )}
          <DashboardPeriodPicker period={period} />
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-error-color/40 bg-error-color/10 p-3 text-sm text-primary-text"
        >
          {describeApiError(error)}
        </p>
      )}

      <div
        className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"
        aria-busy={isLoading || undefined}
      >
        <Kpi
          icon={HourglassIcon}
          label="Awaiting approval"
          value={k ? k.awaitingApproval : "—"}
          note="Plan revisions to review"
          to="/Process-Control/Plans"
          alert={k?.awaitingApproval > 0}
        />
        <Kpi
          icon={ClipboardCheckIcon}
          label="Effective plans"
          value={k ? k.effectivePlans : "—"}
          note={
            k
              ? k.plansWithoutEffective
                ? `${k.plansWithoutEffective} active without one`
                : "Every active plan is in force"
              : ""
          }
          to="/Process-Control/Plans"
        />
        <Kpi
          icon={ClipboardListIcon}
          label="Inspections"
          value={k ? k.inspections : "—"}
          change={k ? pctChange(k.inspections, k.inspectionsPrevious) : null}
          note={k ? `${k.inProgress} in progress` : ""}
          to={canInspect ? "/Inspections" : undefined}
        />
        <Kpi
          icon={CircleCheckIcon}
          label="Pass first time"
          value={k ? percent(k.firstPassRate) : "—"}
          note="Completed inspections in the period"
        />
        <Kpi
          icon={TriangleAlertIcon}
          label="Open failures"
          value={k ? k.openFailures : "—"}
          note="Need an acknowledgement or an NC"
          to={canInspect ? "/Inspections" : undefined}
          alert={k?.openFailures > 0}
        />
        <Kpi
          icon={ActivityIcon}
          label="SPC signals (30 days)"
          value={spc?.available ? spc.signalCount : "—"}
          note={
            spc?.available
              ? `${spc.withSignals} of ${spc.monitored} charts`
              : spc
                ? "No access to SPC"
                : ""
          }
          to={spc?.available ? "/Process-Control/SPC" : undefined}
          alert={spc?.signalCount > 0}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {canInspect && (
          <Card
            title="Inspections"
            subtitle={`Started per ${data?.period.bucket ?? "week"}, by result`}
          >
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={data?.inspectionsByPeriod ?? []}
                  margin={{ top: 8, right: 8, bottom: 0, left: -16 }}
                  barCategoryGap="20%"
                >
                  <CartesianGrid {...grid} />
                  <XAxis
                    dataKey="start"
                    tickFormatter={bucketLabel}
                    tick={tick}
                    axisLine={false}
                    tickLine={false}
                    minTickGap={12}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={tick}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    cursor={{ fill: "var(--chart-grid)" }}
                    content={<ChartTooltip labelFormat={bucketLabel} />}
                  />
                  <Legend
                    iconType="square"
                    iconSize={10}
                    wrapperStyle={{ fontSize: 12 }}
                    formatter={(v) => (
                      <span className="text-secondary-text">{v}</span>
                    )}
                  />
                  {RESULT_SERIES.map((s) => (
                    <Bar
                      key={s.key}
                      dataKey={s.key}
                      name={s.label}
                      stackId="results"
                      fill={s.color}
                      stroke="rgb(var(--secondary-bg))"
                      strokeWidth={1}
                      shape={stackedBarShape(RESULT_SERIES.map((x) => x.key))}
                      maxBarSize={36}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        )}

        <Card title="Control plan revisions" subtitle="Active plans, right now">
          <HBars
            data={data?.revisionsByStatus ?? []}
            colorOf={(d) => REVISION_COLOR[d.key]}
            name="Revisions"
            height={230}
          />
        </Card>

        {canInspect && (
          <Card
            title="Failures by characteristic"
            subtitle="Failed readings in the period (corrected ones left out)"
          >
            {data?.failuresByCharacteristic.length ? (
              <HBars
                data={data.failuresByCharacteristic}
                colorOf={() => "var(--chart-critical)"}
                name="Failed readings"
              />
            ) : (
              <p className="py-8 text-center text-sm text-secondary-text">
                No failed readings in this period.
              </p>
            )}
          </Card>
        )}

        {spc?.available && (
          <Card
            title="SPC signals by rule"
            subtitle={`Last ${spc.windowDays} days, across ${spc.monitored} charted characteristic${spc.monitored === 1 ? "" : "s"}${spc.withoutBaseline ? ` · ${spc.withoutBaseline} without a saved baseline` : ""}`}
          >
            {spc.byRule.length ? (
              <HBars
                data={spc.byRule.map((r) => ({
                  key: r.rule,
                  label: ruleName(r.rule),
                  count: r.count,
                }))}
                name="Signals"
                colorOf={() => "var(--chart-serious)"}
              />
            ) : (
              <p className="py-8 text-center text-sm text-secondary-text">
                No signals in the last {spc.windowDays} days.
              </p>
            )}
          </Card>
        )}
      </div>

      {spc?.available && (
        <Card
          title="Latest SPC signals"
          subtitle="A process signal means look into it; it does not mean product is nonconforming"
          action={
            <Link
              to="/Process-Control/SPC"
              className="text-sm text-link-color hover:underline"
            >
              Open SPC charts
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
                        <Link
                          className="text-link-color hover:underline"
                          to={`/Process-Control/SPC?part=${s.partId}&c=${encodeURIComponent(`${s.characteristicKey}|${s.operationCode}`)}`}
                        >
                          {s.partNumber} · {s.characteristicName}
                        </Link>
                        <span className="text-secondary-text">
                          {" "}
                          · {s.operationCode}
                        </span>
                      </td>
                      <td className={td}>
                        <span className="font-medium">{ruleName(s.rule)}</span>{" "}
                        <span className="text-secondary-text">{s.text}</span>
                      </td>
                      <td className={`${td} whitespace-nowrap`}>
                        {formatDateTime(s.at)}
                      </td>
                      <td className={td}>
                        {s.inspections.map((x) => (
                          <Link
                            key={x.id}
                            className="mr-2 text-link-color hover:underline"
                            to={`/Inspections/${x.id}`}
                          >
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
            <p className="py-4 text-center text-sm text-secondary-text">
              No signals in the last {spc.windowDays} days.
            </p>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card
          title="Control plans needing attention"
          subtitle="Awaiting approval, without an effective revision, or in force for over a year"
        >
          {data?.planAttention.length ? (
            <ul
              className="flex flex-col divide-y divide-border-color text-sm"
              aria-label="Control plans needing attention"
            >
              {data.planAttention.map((p, i) => (
                <li
                  key={`${p.planId}-${i}`}
                  className="flex flex-wrap items-baseline justify-between gap-2 py-1.5"
                >
                  <span>
                    <Link
                      className="text-link-color hover:underline"
                      to={
                        p.revisionId
                          ? `/Process-Control/Plans/${p.planId}/revisions/${p.revisionId}`
                          : `/Process-Control/Plans/${p.planId}`
                      }
                    >
                      {p.planCode}
                    </Link>{" "}
                    <span className="text-secondary-text">{p.title}</span>
                  </span>
                  <span className="text-xs text-secondary-text">
                    <strong className="font-medium text-primary-text">
                      {ATTENTION[p.kind].label}
                    </strong>{" "}
                    · {ATTENTION[p.kind].detail(p)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-4 text-center text-sm text-secondary-text">
              Every plan is approved and current.
            </p>
          )}
        </Card>

        {canInspect && (
          <Card
            title="Failures needing action"
            subtitle="Failed readings with no acknowledgement and no non-conformance"
          >
            {data?.openFailures.length ? (
              <div className="overflow-x-auto">
                <table
                  className="w-full text-sm"
                  aria-label="Failures needing action"
                >
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
                          <Link
                            className="text-link-color hover:underline"
                            to={`/Inspections/${f.inspectionId}`}
                          >
                            {f.reference}
                          </Link>{" "}
                          <span className="text-secondary-text">
                            {f.partNumber}
                          </span>
                        </td>
                        <td className={td}>
                          {f.characteristic}:{" "}
                          <span className="font-medium text-error-color tabular-nums">
                            {f.value}
                          </span>
                        </td>
                        <td className={`${td} tabular-nums`}>{f.limits}</td>
                        <td className={`${td} whitespace-nowrap`}>
                          {formatDateTime(f.measuredAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="py-4 text-center text-sm text-secondary-text">
                Every failed reading has been handled.
              </p>
            )}
          </Card>
        )}
      </div>

      {canInspect && (
        <Card
          title="Inspections in progress"
          subtitle="Oldest first; an inspection open for more than a day is highlighted"
        >
          {data?.inProgress.length ? (
            <div className="overflow-x-auto">
              <table
                className="w-full text-sm"
                aria-label="Inspections in progress"
              >
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
                        <Link
                          className="text-link-color hover:underline"
                          to={`/Inspections/${r.id}`}
                        >
                          {r.reference}
                        </Link>
                      </td>
                      <td className={td}>{r.partNumber}</td>
                      <td className={td}>{r.operationCode ?? "All"}</td>
                      <td className={`${td} whitespace-nowrap`}>
                        {formatDateTime(r.startedAt)}
                      </td>
                      <td className={`${td} text-right tabular-nums`}>
                        {r.samples}
                      </td>
                      <td
                        className={`${td} text-right tabular-nums ${r.ageHours >= 24 ? "text-error-color" : ""}`}
                      >
                        {age(r.ageHours)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="py-4 text-center text-sm text-secondary-text">
              No inspections in progress.
            </p>
          )}
        </Card>
      )}
    </div>
  );
};

export default ProcessControlDashboard;
