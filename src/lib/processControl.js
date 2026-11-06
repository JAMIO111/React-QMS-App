/** Date and time as shown on control plan screens (en-GB). */
export const formatDateTime = (iso) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

export const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");

export const SAMPLING_TRIGGERS = {
  first_off: { label: "First-off", interval: null },
  start_of_shift: { label: "Start of shift", interval: null },
  after_setup: { label: "After set-up", interval: null },
  after_tool_change: { label: "After tool change", interval: null },
  every_n_minutes: { label: "Every N minutes", interval: "minutes" },
  every_n_parts: { label: "Every N parts", interval: "parts" },
  last_off: { label: "Last-off", interval: null },
  manual: { label: "On demand", interval: null },
};

export const REACTION_TRIGGERS = {
  out_of_spec: "Out of specification",
  spc_signal: "SPC signal",
  gauge_invalid: "Gauge invalid or overdue",
  missed_check: "Missed check",
};

export const REACTION_ACTIONS = {
  warn: "Warn",
  hold: "Hold product",
  stop: "Stop the process",
  notify: "Notify quality",
  raise_ncr: "Raise an NC",
};

export const CRITICALITY = {
  critical: { label: "Critical", className: "bg-error-color/15 text-error-color" },
  major: { label: "Major", className: "bg-warning-color/15 text-primary-text" },
  minor: { label: "Minor", className: "bg-border-color text-secondary-text" },
};

/** "Every 30 min × 5", "First-off × 1". */
export const describeSampling = (s) => {
  const t = SAMPLING_TRIGGERS[s.triggerType];
  const label =
    s.triggerType === "every_n_minutes" ? `Every ${s.intervalValue} min` : s.triggerType === "every_n_parts" ? `Every ${s.intervalValue} parts` : t?.label ?? s.triggerType;
  return `${label} × ${s.sampleSize}`;
};

const fmt = (v, decimals) => (v === null || v === undefined ? null : decimals === null || decimals === undefined ? String(v) : Number(v).toFixed(decimals));

/** The requirement as an operator reads it: "25 (24.95 – 25.05) mm", "≤ 1.6 µm", "From part: LENGTH (mm)", "Pass / fail". */
export const describeRequirement = (c) => {
  if (c.dataType === "attribute") return "Pass / fail";
  if (c.dataType === "count") return c.upperLimit !== null && c.upperLimit !== undefined ? `Defects, ≤ ${c.upperLimit} per unit` : "Defects counted";
  if (c.valueSource === "part_spec") return `From part: ${c.specKey}${c.unitCode ? ` (${c.unitCode})` : ""}`;
  const [n, lo, hi] = [fmt(c.nominal, c.decimals), fmt(c.lowerLimit, c.decimals), fmt(c.upperLimit, c.decimals)];
  const unit = c.unitCode ? ` ${c.unitCode}` : "";
  if (lo !== null && hi !== null) return `${n !== null ? `${n} ` : ""}(${lo} – ${hi})${unit}`;
  if (hi !== null) return `${n !== null ? `${n}, ` : ""}≤ ${hi}${unit}`;
  return `${n !== null ? `${n}, ` : ""}≥ ${lo}${unit}`;
};

export const describeSpc = (c) => (c.spcEligible ? (c.chartType === "defects" ? "Defects per unit (C/U)" : c.chartType === "p" ? "P / NP" : `${c.chartType === "xbar_r" ? "X-bar/R" : "I-MR"}${c.chartType === "xbar_r" ? `, n = ${c.subgroupSize}` : ""}`) : null);
