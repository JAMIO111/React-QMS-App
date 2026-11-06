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
