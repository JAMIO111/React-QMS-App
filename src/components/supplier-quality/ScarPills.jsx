import { scarSeverityOf, scarStatusOf } from "../../lib/supplierScars";

export const ScarStatusPill = ({ status }) => {
  const s = scarStatusOf(status);
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>;
};

export const ScarSeverityPill = ({ severity }) => {
  const s = scarSeverityOf(severity);
  if (!s) return <span className="text-secondary-text">—</span>;
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>;
};

/** "3 days late" next to a due date that has passed while the supplier's response is awaited. */
export const OverdueFlag = ({ scar }) =>
  scar.overdue ? <span className="ml-2 whitespace-nowrap rounded-full bg-error-color/15 px-2 py-0.5 text-xs font-medium text-error-color">{scar.daysOverdue} {scar.daysOverdue === 1 ? "day" : "days"} late</span> : null;
