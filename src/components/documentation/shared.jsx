import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "@/components/icons";
import { severityOf, statusOf } from "../../lib/qualityAlerts";

const SEVERITY_ICON = { low: InfoIcon, medium: InfoIcon, high: TriangleAlertIcon, critical: CircleAlertIcon };

/** Severity as a word and an icon, never colour alone. */
export const SeverityBadge = ({ severity }) => {
  const s = severityOf(severity);
  const Icon = SEVERITY_ICON[severity] ?? InfoIcon;
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.className}`}>
      <Icon className="h-3.5 w-3.5" /> {s.label}
    </span>
  );
};

export const StatusPill = ({ alert }) => {
  const s = statusOf(alert.status);
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.className}`}>
      {alert.status === "active" && <CircleCheckIcon className="h-3.5 w-3.5" />}
      {s.label}
      {alert.status === "active" && !alert.inForce ? " · from " + alert.effectiveDate : ""}
    </span>
  );
};

/**
 * What people must do, as numbered line items. Each may be for a department and/or a machine (shown as "for … / on …"). `actions` come from the
 * detail (`departmentLabel`, `machineLabel`) or from the active-alerts list (`department`, `machine`).
 */
export const ActionsList = ({ actions = [], empty = "No actions written yet." }) =>
  actions.length === 0 ? (
    <p className="text-sm text-secondary-text">{empty}</p>
  ) : (
    <ol className="flex flex-col gap-2" aria-label="Required actions">
      {actions.map((x, i) => {
        const dept = x.departmentLabel ?? x.department;
        const machine = x.machineLabel ?? x.machine;
        return (
          <li key={x.id ?? i} className="flex gap-2 text-sm text-primary-text">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary-bg text-xs font-semibold text-secondary-text">{i + 1}</span>
            <div className="min-w-0">
              <p className="whitespace-pre-wrap">{x.description}</p>
              {(dept || machine) && (
                <p className="mt-0.5 flex flex-wrap gap-1.5 text-xs">
                  {dept && <span className="rounded-full border border-border-color px-2 py-0.5 text-secondary-text">For {dept}</span>}
                  {machine && <span className="rounded-full border border-border-color px-2 py-0.5 text-secondary-text">On {machine}</span>}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
