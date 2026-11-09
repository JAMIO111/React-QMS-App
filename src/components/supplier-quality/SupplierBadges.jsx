import { RISK_RATINGS, riskOf, statusOf } from "../../lib/supplierQuality";

export const ApprovalPill = ({ status }) => {
  const s = statusOf(status);
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>;
};

const RISK_SQUARES = ["bg-green-500", "bg-yellow-400", "bg-orange-500", "bg-red-500"];

/** Risk as four squares (green, yellow, orange, red) filled up to the rating, with the rating in words to the right. */
export const RiskBadge = ({ risk }) => {
  const r = riskOf(risk);
  if (!r) return <span className="text-secondary-text">—</span>;
  const level = RISK_RATINGS.findIndex((x) => x.id === r.id) + 1;
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-border-color bg-text-input-color px-2.5 py-1" title={`${r.name} risk`}>
      <span className="flex gap-0.5" aria-hidden="true">
        {RISK_SQUARES.map((tone, i) => (
          <span key={tone} data-filled={i < level ? "true" : "false"} className={`h-2.5 w-2.5 rounded-[2px] ${i < level ? tone : "bg-border-color"}`} />
        ))}
      </span>
      <span className="whitespace-nowrap text-xs font-medium text-primary-text">{r.name}</span>
    </span>
  );
};

/** Operational activity, separate from approval: an approved supplier can be inactive. */
export const ActivityBadge = ({ active }) => (
  <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${active ? "border-success-color/40 text-success-color" : "border-border-color text-secondary-text"}`}>{active ? "Active" : "Inactive"}</span>
);
