import { Link } from "react-router-dom";
import { usePermissions } from "../../hooks/useQmsApi";
import { useActiveAlerts } from "../../hooks/useDocumentation";
import { formatDay } from "../../lib/qualityAlerts";
import { SeverityBadge } from "./shared";

const WHY = { part: "this part", family: "this part family", machine: "this machine", operation: "this operation" };

/**
 * Quality alerts in force that affect the work on this screen (a part, its family, a machine, an operation), shown where the work happens:
 * starting an inspection, and the part, part family and machine pages. Information only: nothing is ever blocked. It shows nothing when
 * there are no alerts or the person may not read alerts. Pass what is being worked on; at least one of the four.
 */
const ActiveAlertsBanner = ({ partId, partFamilyId, machineId, operationCode, className = "" }) => {
  const { can } = usePermissions();
  const alerts = useActiveAlerts({ partId, partFamilyId, machineId, operationCode }, { enabled: can("documentation.read") });
  const list = alerts.data ?? [];
  if (list.length === 0) return null;
  const waiting = list.filter((a) => a.acknowledged === false).length;

  return (
    <section aria-label="Active quality alerts" className={`flex flex-col gap-2 rounded-2xl border border-border-color bg-secondary-bg p-4 ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-primary-text">
          {list.length === 1 ? "1 active quality alert affects this work" : `${list.length} active quality alerts affect this work`}
        </h2>
        {waiting > 0 && <span className="text-sm text-error-color">{waiting === 1 ? "1 is waiting for your acknowledgement" : `${waiting} are waiting for your acknowledgement`}</span>}
      </div>
      <ul className="flex flex-col gap-2">
        {list.map((a) => (
          <li key={a.id} className="flex flex-col gap-1 rounded-lg border border-border-color bg-primary-bg p-3">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={a.severity} />
              <Link to={`/Documentation/Quality-Alerts/${a.id}`} className="font-medium text-link-color hover:underline">
                {a.reference} rev {a.revisionLetter} · {a.title}
              </Link>
              {a.acknowledged === false && <span className="rounded-full border border-error-color px-2 py-0.5 text-xs text-error-color">Not acknowledged</span>}
              {a.acknowledged === true && <span className="text-xs text-secondary-text">Acknowledged</span>}
            </div>
            {a.requiredAction && (
              <p className="text-sm text-primary-text">
                <span className="text-secondary-text">Required action: </span>
                {a.requiredAction}
              </p>
            )}
            <p className="text-xs text-secondary-text">
              Affects {a.matched.map((m) => WHY[m]).join(", ")} · in force since {formatDay(a.effectiveDate)}
              {a.acknowledgeBy ? ` · acknowledge by ${formatDay(a.acknowledgeBy)}` : ""}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
};

export default ActiveAlertsBanner;
