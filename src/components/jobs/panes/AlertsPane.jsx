import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAlertAttachments, useQualityAlert } from "../../../hooks/useDocumentation";
import { formatDay, referenceText } from "../../../lib/qualityAlerts";
import { ActionsList, SeverityBadge } from "../../documentation/shared";
import AlertFileViewer from "./AlertFileViewer";
import { Pager } from "./SidePanes";

const WHY = { part: "this part", family: "this part family", machine: "this machine", operation: "this operation" };

/**
 * Quality alerts in force for the job's part, family, machine and operation, one at a time with previous/next. The alert's wording and files are
 * fetched for the one on show only. Information only: acknowledging stays on the alert page, linked from here.
 */
const AlertsPane = ({ alerts }) => {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (index >= alerts.length) setIndex(Math.max(0, alerts.length - 1));
  }, [alerts.length, index]);
  const current = alerts[index];
  const detail = useQualityAlert(current?.id);
  const files = useAlertAttachments(current?.id);
  if (!current) return <p className="text-sm text-secondary-text">No quality alerts are in force for this part, family, machine or operation.</p>;
  const d = detail.data;
  const description = d?.description;
  const actions = d?.actions ?? current.actions ?? [];

  return (
    <>
      <Pager index={index} count={alerts.length} onChange={setIndex} label="alert" />
      <article aria-label={referenceText(current)} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={current.severity} />
          {current.acknowledged === false && <span className="rounded-full border border-error-color px-2 py-0.5 text-xs text-error-color">Not acknowledged</span>}
          {current.acknowledged === true && <span className="text-xs text-secondary-text">Acknowledged</span>}
        </div>
        <h3 className="text-base font-semibold text-primary-text">
          {referenceText(current)} · {current.title}
        </h3>
        {description && <p className="whitespace-pre-line text-sm text-primary-text">{description}</p>}
        {actions.length > 0 && (
          <div className="rounded-lg border border-border-color bg-secondary-bg p-3">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-secondary-text">Required {actions.length === 1 ? "action" : "actions"}</span>
            <ActionsList actions={actions} />
          </div>
        )}
        <p className="text-xs text-secondary-text">
          Affects {current.matched.map((m) => WHY[m]).join(", ")} · in force since {formatDay(current.effectiveDate)}
          {current.acknowledgeBy ? ` · acknowledge by ${formatDay(current.acknowledgeBy)}` : ""}
        </p>
        <AlertFileViewer files={files.data} />
        <Link to={`/Documentation/Quality-Alerts/${current.id}`} target="_blank" rel="noopener noreferrer" className="text-sm text-link-color hover:underline">
          {current.acknowledged === false ? "Open the alert to acknowledge it" : "Open the full alert"}
        </Link>
      </article>
    </>
  );
};

export default AlertsPane;
