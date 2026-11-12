import { useState } from "react";
import { useParams } from "react-router-dom";
import { TargetIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import SlidingToggle from "../ui/SlidingToggle";
import { Card } from "../dashboard/DashboardParts";
import LoadingScreen from "../ui/LoadingScreen";
import { useObjectiveMutation, useQualityObjective } from "../../hooks/useManagementReview";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { basisWords, formatValue, frequencyLabel, STANDING, standingLabel, targetWords } from "../../lib/qualityObjectives";
import ObjectiveChart from "./ObjectiveChart";
import { ObjectiveDialog, RetireDialog, ValueDialog } from "./ObjectiveDialogs";

const RANGES = [
  { value: "12", label: "12 periods" },
  { value: "24", label: "24 periods" },
  { value: "60", label: "60 periods" },
];
const th = "py-1 pr-3 text-left text-xs font-medium uppercase tracking-wide";
const td = "py-2 pr-3 align-top";
const when = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/**
 * One quality objective (`/Management-Review/Objectives/:id`): what it is, its target, a chart and a table of every period with its value and standing.
 * A manual objective's owner or a manager records values (a second value for a period is a correction with a note; the old one stays in the table).
 */
const ObjectivePage = () => {
  const { id } = useParams();
  const [range, setRange] = useState("12");
  const [dialog, setDialog] = useState(null);
  const { data: o, isLoading, error } = useQualityObjective(id, Number(range));
  const mutation = useObjectiveMutation();
  const { showToast } = useToast();
  useBreadcrumbNames([
    { path: `/Management-Review/Objectives/${id}`, label: o ? o.reference : null },
    { path: "/Management-Review", label: "Management review", to: "/Management-Review/Objectives" },
  ]);

  if (isLoading) return <LoadingScreen />;
  if (error || !o)
    return (
      <div className="p-4">
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      </div>
    );

  const periods = o.periods;
  const newestFirst = [...periods].reverse();
  const reactivate = () => mutation.mutate({ action: "reactivate", id: o.id }, { onError: (err) => showToast({ type: "error", title: "Not brought back", message: describeApiError(err) }) });

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <TargetIcon className="h-6 w-6" aria-hidden="true" />
            {o.reference} · {o.title}
          </h1>
          <p className="text-sm text-secondary-text">
            {o.measureLabel} · {frequencyLabel(o.frequency)} · owned by {o.owner.name} · target {targetWords(o).toLowerCase()}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {o.canRecord && (
            <CTAButton type="main" onClick={() => setDialog("value")}>
              Record a value
            </CTAButton>
          )}
          {o.canManage && o.active && (
            <>
              <CTAButton type="secondary" onClick={() => setDialog("edit")}>
                Edit
              </CTAButton>
              <CTAButton type="danger" onClick={() => setDialog("retire")}>
                Retire
              </CTAButton>
            </>
          )}
          {o.canManage && !o.active && (
            <CTAButton type="secondary" onClick={reactivate} loading={mutation.isPending}>
              Bring back
            </CTAButton>
          )}
        </div>
      </div>

      {!o.active && (
        <Callout tone="warning" title="Retired">
          {o.retiredReason} {o.retiredBy ? `· ${o.retiredBy}` : ""} {o.retiredAt ? `· ${when(o.retiredAt)}` : ""}
        </Callout>
      )}
      {!o.available && <Callout tone="info">This objective counts records you may not read, so its values are not shown to you.</Callout>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <Card title="Where it stands" subtitle={o.measure === "manual" ? "Typed in for each period" : `${o.measureDescription}. Worked out by the system.`} className="xl:col-span-4">
          <span className={`self-start rounded-full px-2 py-0.5 text-xs font-medium ${STANDING[o.standing]?.pill ?? ""}`}>{standingLabel(o.standing)}</span>
          <span className="text-3xl font-semibold tabular-nums text-primary-text">{o.available ? formatValue(o.latest?.value, o.unit) : "—"}</span>
          <span className="text-sm text-secondary-text">
            {o.latest ? `${o.latest.label}${o.latest.current ? " so far" : ""}` : "No value yet"} · target {targetWords(o).toLowerCase()}
          </span>
          <span className="text-sm text-secondary-text">
            {o.summary.periods ? `${o.summary.onTarget} of ${o.summary.periods} finished ${o.summary.periods === 1 ? "period" : "periods"} on target` : "No finished period with a value yet"}
          </span>
          {o.description && <p className="whitespace-pre-line text-sm text-primary-text">{o.description}</p>}
        </Card>
        <Card
          title="By period"
          subtitle="Bars are green on target and red off it; the dashed line is the target; the period in progress is paler"
          className="xl:col-span-8"
          action={<SlidingToggle ariaLabel="How far back" options={RANGES} value={range} onChange={setRange} />}>
          {o.available && periods.some((p) => p.value !== null) ? <ObjectiveChart objective={o} periods={periods} height="h-56" /> : <p className="py-6 text-center text-sm text-secondary-text">No values to chart yet.</p>}
        </Card>
      </div>

      <Card title="Values" subtitle="Newest first; a corrected value keeps the one it replaced">
        <table className="w-full text-sm" aria-label="Values by period">
          <thead className="text-secondary-text">
            <tr>
              <th className={th}>Period</th>
              <th className={th}>Value</th>
              <th className={th}>Standing</th>
              <th className={th}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {newestFirst.map((p) => {
              const basis = basisWords(o.measure, p);
              return (
                <tr key={p.periodStart} className="border-t border-border-color">
                  <td className={`${td} whitespace-nowrap`}>
                    {p.label}
                    {p.current && <span className="block text-xs text-secondary-text">in progress</span>}
                  </td>
                  <td className={`${td} tabular-nums`}>
                    {o.available ? formatValue(p.value, o.unit) : "—"}
                    {basis && <span className="block text-xs text-secondary-text">{basis}</span>}
                  </td>
                  <td className={td}>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STANDING[p.standing]?.pill ?? ""}`}>{standingLabel(p.standing)}</span>
                  </td>
                  <td className={`${td} text-secondary-text`}>
                    {p.note && <span className="block text-primary-text">{p.note}</span>}
                    {p.recordedBy && (
                      <span className="block text-xs">
                        {p.recordedBy} · {when(p.recordedAt)}
                      </span>
                    )}
                    {p.corrections?.map((c) => (
                      <span key={c.at} className="block text-xs">
                        Replaced {formatValue(c.value, o.unit)} ({c.by ?? "someone"}, {when(c.at)})
                      </span>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {dialog === "value" && <ValueDialog objective={o} onClose={() => setDialog(null)} />}
      {dialog === "edit" && <ObjectiveDialog existing={o} onClose={() => setDialog(null)} />}
      {dialog === "retire" && <RetireDialog objective={o} onClose={() => setDialog(null)} />}
    </div>
  );
};

export default ObjectivePage;
