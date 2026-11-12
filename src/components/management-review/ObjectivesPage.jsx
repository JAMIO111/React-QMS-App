import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PlusIcon, TargetIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import SlidingToggle from "../ui/SlidingToggle";
import { Empty } from "../dashboard/DashboardGraphics";
import { useQualityObjectives } from "../../hooks/useManagementReview";
import { describeApiError } from "../../lib/api-client";
import { basisWords, formatValue, frequencyLabel, objectivePath, STANDING, standingLabel, targetWords } from "../../lib/qualityObjectives";
import ObjectiveChart from "./ObjectiveChart";
import { ObjectiveDialog } from "./ObjectiveDialogs";

/**
 * Quality objectives (`/Management-Review/Objectives`): one card per objective with its target, the latest value and whether it is on target, and its last six periods.
 * Managers define objectives here; the owner of an objective without the permission sees only their own.
 */
const ObjectivesPage = () => {
  const [all, setAll] = useState(false);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const { data, isLoading, error } = useQualityObjectives({ all });
  const objectives = data?.data ?? [];
  const counts = objectives.filter((o) => o.active).reduce((c, o) => ({ ...c, [o.standing]: (c[o.standing] ?? 0) + 1 }), {});

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <TargetIcon className="h-6 w-6" aria-hidden="true" />
            Quality objectives
          </h1>
          <p className="text-sm text-secondary-text" aria-live="polite">
            {data ? `${counts.on_target ?? 0} on target · ${counts.off_target ?? 0} off target · ${counts.no_value ?? 0} with no value yet` : "What the organisation aims for, and how it is doing"}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <SlidingToggle ariaLabel="Which objectives" options={[{ value: "", label: "In use" }, { value: "all", label: "All" }]} value={all ? "all" : ""} onChange={(v) => setAll(v === "all")} />
          {data?.canManage && (
            <CTAButton type="main" onClick={() => setCreating(true)}>
              <PlusIcon aria-hidden="true" /> New objective
            </CTAButton>
          )}
        </div>
      </div>

      {error && (
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      )}

      {!isLoading && !error && objectives.length === 0 && <Empty>{data?.canManage ? "No objectives yet. Define the first one." : "No objectives yet."}</Empty>}

      <ul aria-label="Quality objectives" className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {objectives.map((o) => {
          const latest = o.latest;
          const basis = basisWords(o.measure, latest);
          return (
            <li key={o.id} className={`flex flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-4 ${o.active ? "" : "opacity-70"}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col">
                  <Link to={objectivePath(o.id)} className="font-semibold text-primary-text hover:underline">
                    {o.reference} · {o.title}
                  </Link>
                  <span className="text-xs text-secondary-text">
                    {o.measureLabel} · {frequencyLabel(o.frequency)} · {o.owner.name}
                    {!o.active ? " · retired" : ""}
                  </span>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STANDING[o.standing]?.pill ?? ""}`}>{standingLabel(o.standing)}</span>
              </div>
              <div className="flex items-end justify-between gap-3">
                <div className="flex flex-col">
                  <span className="text-2xl font-semibold tabular-nums text-primary-text">{o.available ? formatValue(latest?.value, o.unit) : "—"}</span>
                  <span className="text-xs text-secondary-text">
                    {latest ? `${latest.label}${latest.current ? " so far" : ""}${basis ? ` · ${basis}` : ""}` : o.available ? "No value yet" : "You may not read what this counts"}
                  </span>
                </div>
                <span className="text-sm text-secondary-text">Target: {targetWords(o)}</span>
              </div>
              {o.available && o.trend.some((p) => p.value !== null) && <ObjectiveChart objective={o} periods={o.trend} height="h-20" compact />}
            </li>
          );
        })}
      </ul>

      {creating && <ObjectiveDialog onClose={() => setCreating(false)} onSaved={(saved) => navigate(objectivePath(saved.id))} />}
    </div>
  );
};

export default ObjectivesPage;
