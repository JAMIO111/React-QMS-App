import { riskOf, statusOf } from "../../lib/supplierQuality";

export const ApprovalPill = ({ status }) => {
  const s = statusOf(status);
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>;
};

export const RiskBadge = ({ risk }) => {
  const r = riskOf(risk);
  if (!r) return <span className="text-secondary-text">—</span>;
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${r.tone}`}>{r.name}</span>;
};

/** Operational activity, separate from approval: an approved supplier can be inactive. */
export const ActivityBadge = ({ active }) => (
  <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${active ? "border-success-color/40 text-success-color" : "border-border-color text-secondary-text"}`}>{active ? "Active" : "Inactive"}</span>
);
