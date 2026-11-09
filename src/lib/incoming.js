/** Shared definitions for incoming inspection (SQ4b). */

export const STRATEGIES = [
  { value: "full", label: "Every unit (100%)", hint: "Inspect the whole delivery" },
  { value: "fixed", label: "A fixed sample", hint: "The same number of units every delivery", fields: ["sampleSize", "acceptNumber"] },
  { value: "percentage", label: "A percentage of the lot", hint: "Rounded up, at least one unit", fields: ["percentage", "acceptNumber"] },
  { value: "plan", label: "A sampling plan by lot size", hint: "Your own table: sample size and accept number per band of lot sizes", fields: ["plan"] },
  { value: "first_article", label: "First delivery only", hint: "Inspect the first delivery of the part from the supplier", fields: ["sampleSize", "acceptNumber"] },
  { value: "skip_lot", label: "Every Nth delivery (skip-lot)", hint: "Inspect one delivery in N", fields: ["sampleSize", "skipEvery", "acceptNumber"] },
  { value: "none", label: "No incoming inspection", hint: "Goods are accepted on arrival" },
];
export const strategyLabel = (v) => STRATEGIES.find((s) => s.value === v)?.label ?? v;

export const LEVELS = [
  { value: "increased", label: "Increased" },
  { value: "normal", label: "Normal" },
  { value: "reduced", label: "Reduced" },
  { value: "skip", label: "Skip" },
];
export const levelLabel = (v) => LEVELS.find((l) => l.value === v)?.label ?? v;

export const REQUIREMENT_STATUS = {
  draft: { label: "Draft", tone: "bg-border-color text-primary-text" },
  approved: { label: "Approved", tone: "bg-success-color/15 text-success-color" },
  superseded: { label: "Superseded", tone: "bg-border-color text-secondary-text" },
  retired: { label: "Retired", tone: "bg-border-color text-secondary-text" },
};

export const REQUIREMENT_FILTERS = [
  { value: "active", label: "Current" },
  { value: "superseded,retired", label: "History" },
  { value: "all", label: "All" },
];

export const RISKS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

/** What a requirement asks for, in words. */
export const strategySummary = (r) => {
  switch (r.strategy) {
    case "full": return "Every unit";
    case "none": return "No inspection";
    case "fixed": return `A sample of ${r.sampleSize}${r.acceptNumber ? `, accept up to ${r.acceptNumber} failing` : ""}`;
    case "percentage": return `${r.percentage}% of the lot${r.acceptNumber ? `, accept up to ${r.acceptNumber} failing` : ""}`;
    case "first_article": return `First delivery only, a sample of ${r.sampleSize}`;
    case "skip_lot": return `Every ${r.skipEvery}th delivery, a sample of ${r.sampleSize}`;
    case "plan": return `A plan of ${r.plan?.length ?? 0} ${r.plan?.length === 1 ? "band" : "bands"}`;
    default: return r.strategy;
  }
};

/** Who or what a requirement applies to, in words ("Everything" when it names nothing). */
export const appliesTo = (r) => {
  const parts = [r.supplier && `${r.supplier.code} · ${r.supplier.name}`, r.part && r.part.partNumber, r.partFamily && `family ${r.partFamily.name}`, r.classification && r.classification.label, r.riskRating && `${r.riskRating} risk suppliers`].filter(Boolean);
  return parts.length ? parts.join(", ") : "Everything (the default)";
};

export const LINE_STATUS = {
  not_required: { label: "No inspection needed", tone: "bg-border-color text-secondary-text" },
  pending: { label: "Awaiting inspection", tone: "bg-warning-color/20 text-primary-text" },
  held: { label: "Held", tone: "bg-warning-color/20 text-primary-text" },
  accepted: { label: "Accepted", tone: "bg-success-color/15 text-success-color" },
  conditional: { label: "Accepted on conditions", tone: "bg-info-color/15 text-info-color" },
  rejected: { label: "Rejected", tone: "bg-error-color/15 text-error-color" },
};

export const DECISIONS = [
  { value: "accepted", label: "Accept" },
  { value: "held", label: "Hold" },
  { value: "rejected", label: "Reject" },
  { value: "conditional", label: "Accept on conditions" },
];

export const REQUIREMENTS_PATH = "/Supplier-Quality/Inspection-Requirements";
