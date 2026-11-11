import { Link } from "react-router-dom";
import { format } from "date-fns";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CircleCheckIcon, FileTextIcon, MessageSquarePlusIcon, TriangleAlertIcon, UsersIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import Callout from "../ui/Callout";
import { DashboardPeriodPicker } from "../dashboard/DashboardPeriod";
import { Chip, Empty, HeroCard, Meter, Pipeline, RankList, SeriesLegend, StatTile, headerLink as linkClass } from "../dashboard/DashboardGraphics";
import { Card, ChartTooltip, grid, tick } from "../dashboard/DashboardParts";
import { useDashboardPeriod } from "../../hooks/useDashboardPeriod";
import { useDocumentsDashboard } from "../../hooks/useDocuments";
import { describeApiError } from "../../lib/api-client";
import { documentPath, formatDay, REVISION_STATUS, revisionPath, statusLabel } from "../../lib/documents";

const ACTIVITY = [
  { key: "effective", label: "Revisions in force", color: "var(--chart-series-1)" },
  { key: "acknowledgements", label: "Acknowledgements", color: "var(--chart-series-3)" },
];
const th = "py-1 pr-3 text-left text-xs font-medium uppercase tracking-wide";
const td = "py-2 pr-3 align-middle";
const daysWords = (days) => (days < 0 ? `${-days} ${days === -1 ? "day" : "days"} ago` : days === 0 ? "today" : `in ${days} ${days === 1 ? "day" : "days"}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const DocCell = ({ row, revision }) => (
  <Link to={revision ? revisionPath(row.documentId, revision) : documentPath(row.documentId)} className="font-medium text-primary-text hover:underline">
    {row.number}
    {row.letter ? ` rev ${row.letter}` : ""} <span className="font-normal text-secondary-text">· {row.title}</span>
  </Link>
);

/**
 * Documents dashboard (`/Documentation`): what is in force, revisions on their way through review, periodic reviews and readers behind, and what happened in the period.
 * Figures are what the caller may read (restricted documents count only for their readers and managers).
 */
const DocumentsDashboard = () => {
  const period = useDashboardPeriod("90d");
  const { fromIso: from, toIso: to } = period;
  const { data, isLoading, isFetching, error } = useDocumentsDashboard({ from, to });
  const k = data?.kpis;
  const steps = k
    ? [
        { key: "draft", label: "Drafts", count: k.drafts },
        { key: "in_review", label: "With reviewers", count: k.inReview },
        { key: "awaiting_approval", label: "With approvers", count: k.awaitingApproval },
        { key: "approved", label: "Approved, waiting for their date", count: k.approvedWaiting ?? 0 },
      ]
    : [];
  const bucketLabel = (start) => format(new Date(`${start}T00:00:00`), data?.period.bucket === "month" ? "MMM yy" : "d MMM");

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <FileTextIcon className="h-6 w-6" aria-hidden="true" />
            Documents dashboard
          </h1>
          <p className="text-sm text-secondary-text" aria-live="polite">
            Activity {formatDay(from)} – {formatDay(to)} · everything else as of today
            {isFetching && !isLoading ? " · updating…" : ""}
          </p>
        </div>
        <div className="flex flex-nowrap items-end gap-3 max-sm:flex-wrap">
          <Link to="/Documentation/Documents" className={linkClass}>
            Documents
          </Link>
          <Link to="/Documentation/Change-Requests" className={linkClass}>
            Change requests
          </Link>
          <DashboardPeriodPicker period={period} />
        </div>
      </div>

      {error && (
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      )}

      {/* What is in force beside the revisions on their way there. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12" aria-busy={isLoading || undefined}>
        <HeroCard
          label="In force"
          icon={CircleCheckIcon}
          value={k ? k.inForce : "—"}
          note={k ? `${k.external} external · ${k.withdrawn} withdrawn` : "Documents, as of today"}
          to="/Documentation/Documents?status=active"
          className="xl:col-span-5">
          <span className="text-sm font-semibold text-primary-text">In force by type</span>
          {data?.byType.length ? <RankList items={data.byType.map((t) => ({ key: t.typeId, label: `${t.prefix} · ${t.name}`, count: t.inForce }))} label="Documents in force by type" /> : <Empty>No documents yet.</Empty>}
        </HeroCard>

        <Card title="Revisions on their way" subtitle="Where each revision in progress stands, and the ones waiting longest for a reviewer or approver" className="rounded-3xl xl:col-span-7">
          {steps.length > 0 && <Pipeline steps={steps} label="Revisions in progress by stage" layout="four" />}
          {data?.waiting.length ? (
            <table className="w-full text-sm" aria-label="Revisions waiting">
              <thead className="text-secondary-text">
                <tr>
                  <th className={th}>Document</th>
                  <th className={th}>Stage</th>
                  <th className={`${th} text-right`}>Waiting</th>
                </tr>
              </thead>
              <tbody>
                {data.waiting.map((w) => (
                  <tr key={w.revisionId} className="border-t border-border-color">
                    <td className={td}>
                      <DocCell row={w} revision={w.revisionId} />
                    </td>
                    <td className={td}>{statusLabel(REVISION_STATUS, w.status)}</td>
                    <td className={`${td} text-right`}>
                      <Chip tone={w.days > 14 ? "error" : "neutral"}>{plural(w.days, "day")}</Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Nothing is waiting for a reviewer or approver.</Empty>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-busy={isLoading || undefined}>
        <StatTile icon={TriangleAlertIcon} label="Reviews overdue" value={k ? k.reviewsOverdue : "—"} note={k ? `${k.reviewsDue30} more due within 30 days` : ""} to="/Documentation/Documents?review=true" alert={k?.reviewsOverdue > 0} />
        <StatTile icon={UsersIcon} label="Readers overdue" value={k ? k.readersOverdue : "—"} note={k ? `${k.readersPending} still to acknowledge` : ""} alert={k?.readersOverdue > 0}>
          {k?.readersPending > 0 && <Meter part={k.readersOverdue} whole={k.readersPending} color="var(--chart-critical)" label="Readers past their date, of those still to acknowledge" />}
        </StatTile>
        <StatTile icon={MessageSquarePlusIcon} label="Change requests open" value={k ? k.changeRequestsOpen : "—"} note={k ? `${k.changeRequestsRaised ?? 0} raised in the period` : ""} to="/Documentation/Change-Requests" />
        <StatTile icon={FileTextIcon} label="Revisions in force" value={k ? k.madeEffective : "—"} note={k ? `took effect in the period · ${plural(k.acknowledgements, "acknowledgement")}` : ""} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <Card title="Activity" subtitle={`Revisions taking effect and readers acknowledging, per ${data?.period.bucket ?? "week"}`} className="xl:col-span-7">
          {data?.activity.length ? (
            <>
              <SeriesLegend series={ACTIVITY} label="Document activity" />
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.activity} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="20%" barGap={2} aria-label="Document activity per period">
                    <CartesianGrid {...grid} />
                    <XAxis dataKey="start" tickFormatter={bucketLabel} tick={tick} axisLine={false} tickLine={false} minTickGap={12} />
                    <YAxis allowDecimals={false} tick={tick} axisLine={false} tickLine={false} />
                    <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={<ChartTooltip labelFormat={bucketLabel} />} />
                    {ACTIVITY.map((s) => (
                      <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={20} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          ) : (
            <Empty>Nothing took effect or was acknowledged in this period.</Empty>
          )}
        </Card>

        <Card title="Periodic reviews due" subtitle="Overdue, or due within 30 days" className="xl:col-span-5">
          {data?.reviewsDue.length ? (
            <table className="w-full text-sm" aria-label="Periodic reviews due">
              <thead className="text-secondary-text">
                <tr>
                  <th className={th}>Document</th>
                  <th className={`${th} text-right`}>Due</th>
                </tr>
              </thead>
              <tbody>
                {data.reviewsDue.map((r) => (
                  <tr key={r.documentId} className="border-t border-border-color">
                    <td className={td}>
                      <DocCell row={r} />
                    </td>
                    <td className={`${td} text-right`}>
                      <span className="flex flex-wrap items-center justify-end gap-2 whitespace-nowrap">
                        {formatDay(r.nextReviewOn)}
                        <Chip tone={r.days < 0 ? "error" : "warning"}>{daysWords(r.days)}</Chip>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No periodic review is due within 30 days.</Empty>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="Readers behind" subtitle="Documents in force with readers past their date">
          {data?.readersBehind.length ? (
            <table className="w-full text-sm" aria-label="Readers behind">
              <thead className="text-secondary-text">
                <tr>
                  <th className={th}>Document</th>
                  <th className={`${th} w-1/4`}>
                    <span className="sr-only">Share overdue</span>
                  </th>
                  <th className={`${th} text-right`}>Overdue</th>
                </tr>
              </thead>
              <tbody>
                {data.readersBehind.map((r) => (
                  <tr key={r.revisionId} className="border-t border-border-color">
                    <td className={td}>
                      <DocCell row={r} revision={r.revisionId} />
                    </td>
                    <td className={td} aria-hidden="true">
                      <Meter part={r.overdue} whole={r.total} color="var(--chart-critical)" label="Share of readers overdue" />
                    </td>
                    <td className={`${td} whitespace-nowrap text-right tabular-nums text-error-color`}>
                      {r.overdue} of {r.total}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Every reader is up to date.</Empty>
          )}
        </Card>

        <Card title="Taking effect soon" subtitle="Approved revisions waiting for their date">
          {data?.effectiveSoon.length ? (
            <table className="w-full text-sm" aria-label="Taking effect soon">
              <thead className="text-secondary-text">
                <tr>
                  <th className={th}>Document</th>
                  <th className={`${th} text-right`}>In force from</th>
                </tr>
              </thead>
              <tbody>
                {data.effectiveSoon.map((r) => (
                  <tr key={r.revisionId} className="border-t border-border-color">
                    <td className={td}>
                      <DocCell row={r} revision={r.revisionId} />
                    </td>
                    <td className={`${td} whitespace-nowrap text-right`}>{formatDay(r.effectiveFrom)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No approved revision is waiting for its date.</Empty>
          )}
        </Card>
      </div>
    </div>
  );
};

export default DocumentsDashboard;
