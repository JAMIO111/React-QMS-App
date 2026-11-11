/** Competence (docs/competence-plan.md): the fixed 0–4 scale and small helpers for skills and positions. */
export const LEVELS = [
  { value: 0, label: "None", hint: "No experience" },
  { value: 1, label: "Learning", hint: "Being taught; not yet working alone" },
  { value: 2, label: "Supervised", hint: "Works with supervision" },
  { value: 3, label: "Competent", hint: "Works unsupervised to the standard" },
  { value: 4, label: "Can train others", hint: "Competent and able to teach and assess" },
];

export const levelLabel = (value) => (value === null || value === undefined || value === "" ? "—" : (LEVELS.find((l) => l.value === Number(value))?.label ?? "—"));

/** Levels a position can require (a requirement of 0 means nothing, so 1 to 4). */
export const REQUIRED_LEVELS = LEVELS.filter((l) => l.value >= 1);

/** "Every 12 months", "Every month", or "No refresh" for a skill's refresh interval. */
export const refreshLabel = (months) => {
  if (!months) return "No refresh";
  if (months === 1) return "Every month";
  if (months % 12 === 0) return months === 12 ? "Every year" : `Every ${months / 12} years`;
  return `Every ${months} months`;
};

/** Skills grouped by category label, in the order given, for the lists. */
export const groupByCategory = (skills) => {
  const groups = new Map();
  for (const s of skills) {
    const label = s.category?.label ?? s.category ?? "Other";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(s);
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }));
};

/** What a position requires, in one line: "CMM operation 3, Visual inspection 2". */
export const requirementSummary = (position) =>
  position.skills.length === 0 ? "Requires no skills yet" : position.skills.map((s) => `${s.name} ${s.requiredLevel}`).join(", ");

/** How a skill stands for a person (worked out by the server). Tones are the app's: success / warning / error / neutral. */
export const STATUS = {
  ok: { label: "On track", tone: "success" },
  gap: { label: "Below required", tone: "error" },
  not_assessed: { label: "Not assessed", tone: "warning" },
  expired: { label: "Assessment expired", tone: "error" },
  expiring: { label: "Expiring soon", tone: "warning" },
  extra: { label: "Not required", tone: "neutral" },
};
export const statusLabel = (status) => STATUS[status]?.label ?? "—";

/** Tailwind classes for a status pill / matrix cell (tint plus the matching text colour, which the light-mode overrides in index.css rely on). */
export const STATUS_CLASS = {
  success: "bg-success-color/15 text-success-color",
  warning: "bg-warning-color/15 text-warning-color",
  error: "bg-error-color/15 text-error-color",
  neutral: "bg-secondary-bg text-secondary-text",
};
export const statusClass = (status) => STATUS_CLASS[STATUS[status]?.tone ?? "neutral"];

/** A matrix cell in words: "Level 2 of 3 needed, expires 2027-01-05". */
export const describeCell = (cell) => {
  if (!cell) return "";
  const parts = [];
  parts.push(cell.level === null ? "Not assessed" : `${levelLabel(cell.level)} (${cell.level})`);
  if (cell.required !== null) parts.push(`needs ${cell.required}`);
  if (cell.expiresOn) parts.push(`${cell.expiry === "expired" ? "expired" : "expires"} ${cell.expiresOn}`);
  return parts.join(" · ");
};

/** Matrix status filter choices. */
export const MATRIX_STATUS_OPTIONS = [
  { value: "all", label: "Everyone" },
  { value: "attention", label: "Needs attention" },
  { value: "gap", label: "Gaps" },
  { value: "expiring", label: "Expiring" },
  { value: "expired", label: "Expired" },
];
