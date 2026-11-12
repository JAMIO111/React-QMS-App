/** Quality objectives (MR1): words and helpers shared by the pages. */
export const FREQUENCIES = [
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
];
export const DIRECTIONS = [
  { value: "at_least", label: "At least the target", hint: "Higher is better" },
  { value: "at_most", label: "At most the target", hint: "Lower is better" },
];
export const frequencyLabel = (f) => FREQUENCIES.find((x) => x.value === f)?.label ?? f;

export const STANDING = {
  on_target: { label: "On target", tone: "success", pill: "bg-success-color/15 text-success-color" },
  off_target: { label: "Off target", tone: "error", pill: "bg-error-color/15 text-error-color" },
  no_value: { label: "No value yet", tone: "neutral", pill: "bg-border-color text-secondary-text" },
  unavailable: { label: "Not available to you", tone: "neutral", pill: "bg-border-color text-secondary-text" },
};
export const standingLabel = (s) => STANDING[s]?.label ?? s;

/** A number with its unit: "95 %", "420 PPM", "3 NCs", "12.5". */
export const formatValue = (value, unit) => {
  if (value === null || value === undefined) return "—";
  const n = Number(value).toLocaleString("en-GB", { maximumFractionDigits: 4 });
  if (!unit) return n;
  return unit === "%" ? `${n}%` : `${n} ${unit}`;
};

/** "At least 95%" / "At most 500 PPM". */
export const targetWords = (o) => `${o.direction === "at_most" ? "At most" : "At least"} ${formatValue(o.target, o.unit)}`;

/** A system value's basis in words: "3 of 4", "420 of 1,000,000"; nothing for a count or a typed value. */
export const basisWords = (measure, p) => {
  if (!p || p.denominator === null || p.denominator === undefined) return null;
  const d = Number(p.denominator).toLocaleString("en-GB");
  const n = Number(p.numerator ?? 0).toLocaleString("en-GB");
  if (measure === "supplier_ppm") return `${n} rejected of ${d} received`;
  if (measure === "capa_on_time") return `${n} of ${d} closed on time`;
  if (measure === "audit_pass_rate") return `${n} of ${d} passed`;
  return null;
};

export const objectivePath = (id) => `/Management-Review/Objectives/${id}`;

/** Management reviews (MR2). */
export const REVIEW_STATUS = {
  planned: { label: "Planned", pill: "bg-border-color text-secondary-text" },
  in_progress: { label: "Being held", pill: "bg-warning-color/15 text-warning-color" },
  completed: { label: "Completed", pill: "bg-success-color/15 text-success-color" },
  cancelled: { label: "Cancelled", pill: "bg-border-color text-secondary-text" },
};
export const DECISION_CATEGORIES = [
  { value: "improvement", label: "Improvement" },
  { value: "resources", label: "Resources" },
  { value: "qms_change", label: "Change to the QMS" },
  { value: "other", label: "Other" },
];
export const decisionCategoryLabel = (c) => DECISION_CATEGORIES.find((x) => x.value === c)?.label ?? c;
export const ATTENDANCE = [
  { value: "invited", label: "Invited" },
  { value: "present", label: "Present" },
  { value: "apologies", label: "Apologies" },
];
export const reviewPath = (id) => `/Management-Review/Reviews/${id}`;
export const formatDay = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
/** A gathered figure in words: "4", "92.5%", "£1,200". */
export const figureWords = (f) => {
  if (f.value === null || f.value === undefined) return "—";
  if (typeof f.value === "string") return f.value;
  return formatValue(f.value, f.unit);
};
