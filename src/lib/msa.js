/**
 * Words and small helpers for the measurement system studies (Gauge R&R, Type 1, attribute agreement). Information only: nothing here decides
 * anything the database or the API has not already decided; it only says it in words.
 */

export const STUDY_TYPES = [
  { value: "grr_crossed", label: "Gauge R&R (crossed)", short: "Gauge R&R", hint: "Several appraisers measure the same parts several times: how much of what you see is the gauge and the people, not the parts." },
  { value: "type1", label: "Type 1 (bias and repeatability)", short: "Type 1", hint: "One part with a known reference value, measured again and again with one gauge: bias, repeatability and Cg / Cgk." },
  { value: "attribute", label: "Attribute agreement", short: "Attribute", hint: "Pass / fail decisions on samples whose true answer is known: do people agree with each other and with the standard?" },
];
export const typeOf = (value) => STUDY_TYPES.find((t) => t.value === value) ?? { value, label: value, short: value, hint: "" };

export const STATUSES = [
  { value: "draft", label: "Draft", tone: "neutral" },
  { value: "collecting", label: "Collecting readings", tone: "warning" },
  { value: "completed", label: "Completed", tone: "success" },
  { value: "cancelled", label: "Cancelled", tone: "neutral" },
];
export const statusOf = (value) => STATUSES.find((s) => s.value === value) ?? { value, label: value, tone: "neutral" };

export const VERDICTS = [
  { value: "acceptable", label: "Acceptable", tone: "success" },
  { value: "marginal", label: "Marginal", tone: "warning" },
  { value: "unacceptable", label: "Not acceptable", tone: "error" },
  { value: "not_judged", label: "Not judged", tone: "neutral" },
];
export const verdictOf = (value) => VERDICTS.find((v) => v.value === value) ?? { value, label: "—", tone: "neutral" };

export const CONCLUSIONS = [
  { value: "accepted", label: "Accepted" },
  { value: "accepted_with_conditions", label: "Accepted with conditions" },
  { value: "not_accepted", label: "Not accepted" },
];
export const conclusionLabel = (value) => CONCLUSIONS.find((c) => c.value === value)?.label ?? "—";

/** Colour classes for a tone: tint plus the matching text colour, so the light-mode contrast rule in index.css applies. */
export const TONE_CLASS = {
  success: "bg-success-color/15 text-success-color",
  warning: "bg-warning-color/15 text-warning-color",
  error: "bg-error-color/15 text-error-color",
  neutral: "bg-border-color text-secondary-text",
};

/** How long a completed study stays valid, in words. `validity` is `{ state: valid|expiring|expired, daysLeft }` or null. */
export const validityWords = (validity, validUntil) => {
  if (!validity) return "";
  if (validity.state === "expired") return `Expired${validUntil ? ` on ${validUntil}` : ""}`;
  if (validity.state === "expiring") return `Valid for ${validity.daysLeft} more ${validity.daysLeft === 1 ? "day" : "days"}`;
  return validUntil ? `Valid until ${validUntil}` : "Valid";
};
export const VALIDITY_TONE = { valid: "success", expiring: "warning", expired: "error" };

export const STUDY_SORTS = { reference: "reference", type: "type", gauge: "gauge", characteristic: "characteristic", status: "status", verdict: "verdict", validUntil: "validUntil", createdAt: "createdAt", completedAt: "completedAt" };

export const msaPath = (id) => `/Calibration/Gauge-RR/${id}`;
export const msaReportPath = (id) => `/Calibration/Gauge-RR/${id}/report`;

/** A number for display: `digits` decimals, no trailing noise, "—" when there is none. */
export const fmt = (value, digits = 3) => {
  if (value === null || value === undefined || value === "" || Number.isNaN(Number(value))) return "—";
  const n = Number(value);
  if (n === 0) return "0";
  if (Math.abs(n) < 10 ** -digits || Math.abs(n) >= 1e9) return n.toExponential(2);
  return n.toLocaleString("en-GB", { maximumFractionDigits: digits, useGrouping: false });
};
/** A figure that is already a percentage (13.2). */
export const fmtPct = (value, digits = 1) => (value === null || value === undefined ? "—" : `${Number(value).toFixed(digits)}%`);
/** A rate between 0 and 1 shown as a percentage. */
export const fmtRate = (value, digits = 1) => (value === null || value === undefined ? "—" : `${(Number(value) * 100).toFixed(digits)}%`);

/** The text typed into a reading box is a number (decimal point or comma, optional exponent). */
export const NUMBER_TEXT = /^-?[0-9]+([.,][0-9]+)?([eE][+-]?[0-9]+)?$/;
export const isNumberText = (text) => NUMBER_TEXT.test(String(text).trim());
/** What is sent: the digits as typed, with a decimal comma turned into a point. */
export const toNumberText = (text) => String(text).trim().replace(",", ".");

export const cellKey = (appraiser, part, trial) => `${appraiser}.${part}.${trial}`;

/** `{ [cellKey]: cell }` for the study's cells. */
export const cellMap = (cells = []) => Object.fromEntries(cells.map((c) => [cellKey(c.appraiser, c.part, c.trial), c]));
export const isFilled = (cell) => !!cell && (cell.value !== null && cell.value !== undefined ? true : cell.decision !== null && cell.decision !== undefined);

/** The run sheet of one appraiser: for each trial, the cells in the order they are to be measured. */
export const runSheet = (cells, appraiser) => {
  const mine = cells.filter((c) => c.appraiser === appraiser);
  const trials = [...new Set(mine.map((c) => c.trial))].sort((a, b) => a - b);
  return trials.map((trial) => ({ trial, cells: mine.filter((c) => c.trial === trial).sort((a, b) => a.runOrder - b.runOrder) }));
};

export const progressWords = (progress) => (progress ? `${progress.filled} of ${progress.total} readings` : "");
export const progressPct = (progress) => (progress && progress.total > 0 ? Math.round((progress.filled / progress.total) * 100) : 0);

export const SIGMA_OPTIONS = [
  { value: 6, label: "6 (99.73% of the variation, the usual choice)" },
  { value: 5.15, label: "5.15 (99% of the variation, older AIAG)" },
];
export const ALPHA_OPTIONS = [
  { value: 0.05, label: "0.05 (keep the interaction only when clearly significant)" },
  { value: 0.25, label: "0.25 (the AIAG manual's choice)" },
];

/** The usual design for each type (what a new study starts with). */
export const DEFAULT_DESIGN = {
  grr_crossed: { partCount: 10, appraiserCount: 3, trialCount: 3 },
  type1: { partCount: 1, appraiserCount: 1, trialCount: 25 },
  attribute: { partCount: 30, appraiserCount: 3, trialCount: 3 },
};

/** Names of the variation components in the ANOVA table. */
export const COMPONENT_LABEL = {
  repeatability: "Repeatability (the gauge)",
  appraiser: "Appraiser",
  interaction: "Part × appraiser",
  reproducibility: "Reproducibility (the people)",
  grr: "Total gauge R&R",
  part: "Part-to-part",
  total: "Total variation",
};

export const bandTone = (band) => (band === "acceptable" ? "success" : band === "marginal" ? "warning" : band === "unacceptable" ? "error" : "neutral");
export const bandWords = (band) => (band === "acceptable" ? "Acceptable" : band === "marginal" ? "Marginal" : band === "unacceptable" ? "Not acceptable" : "Not judged");

/** A design problem to show before saving (the server checks again). Returns a sentence or "". */
export const designProblem = (type, d) => {
  if (!d.characteristicName?.trim()) return "Say what is measured.";
  const lower = d.lowerLimit === "" || d.lowerLimit == null ? null : Number(d.lowerLimit);
  const upper = d.upperLimit === "" || d.upperLimit == null ? null : Number(d.upperLimit);
  if (lower !== null && upper !== null && !(upper > lower)) return "The upper limit must be above the lower limit.";
  if (type === "grr_crossed") {
    if (d.appraiserCount < 2) return "A crossed study needs at least 2 appraisers.";
    if (d.partCount < 2) return "A crossed study needs at least 2 parts.";
    if (d.trialCount < 2) return "A crossed study needs at least 2 trials.";
  }
  if (type === "type1") {
    if (d.referenceValue === "" || d.referenceValue == null) return "A Type 1 study needs the reference value of the part.";
    if (d.trialCount < 10) return "A Type 1 study needs at least 10 readings (25 or more is usual).";
  }
  if (type === "attribute") {
    if (d.appraiserCount < 2) return "An attribute study needs at least 2 appraisers.";
    if (d.partCount < 10) return "An attribute study needs at least 10 samples (30 or more is usual).";
  }
  return "";
};

/** The choices of the register's filter drawer, as `{ key, label }`. */
export const STATUS_FILTERS = STATUSES.map((s) => ({ key: s.value, label: s.label }));
export const TYPE_FILTERS = STUDY_TYPES.map((t) => ({ key: t.value, label: t.short }));
export const VERDICT_FILTERS = VERDICTS.filter((v) => v.value !== "not_judged").map((v) => ({ key: v.value, label: v.label }));
export const VALIDITY_FILTERS = [
  { key: "valid", label: "Valid" },
  { key: "expiring", label: "Expiring soon" },
  { key: "expired", label: "Expired" },
];

/** The readings of a Type 1 study stored so far, in the order taken (numbers). */
export const type1Readings = (study) =>
  [...(study.cells ?? [])]
    .filter((c) => c.value !== null && c.value !== undefined)
    .sort((a, b) => a.trial - b.trial)
    .map((c) => Number(c.value));

/**
 * Coverage: for each critical or major characteristic of a plan in force, the gauge it was measured with in the last 12 months and what is known about
 * that pair from Gauge R&R studies. Information only. Order = worst first.
 */
export const COVERAGE_STATES = [
  { value: "not_accepted", label: "Not accepted", tone: "error", hint: "The latest study did not accept this gauge for this characteristic." },
  { value: "expired", label: "Study expired", tone: "error", hint: "The latest study is past its valid-until date." },
  { value: "no_study", label: "No study", tone: "warning", hint: "Readings were taken with this gauge but no completed study covers it." },
  { value: "not_judged", label: "Not judged", tone: "warning", hint: "A study exists but could not be judged (no limits or reference decisions)." },
  { value: "marginal", label: "Marginal", tone: "warning", hint: "The latest study says marginal." },
  { value: "no_readings", label: "No readings", tone: "neutral", hint: "Nothing has been measured with a recorded gauge in the last 12 months." },
  { value: "acceptable", label: "Acceptable", tone: "success", hint: "The latest study is valid and acceptable." },
];
export const coverageOf = (value) => COVERAGE_STATES.find((s) => s.value === value) ?? { value, label: value, tone: "neutral", hint: "" };
export const COVERAGE_ATTENTION = ["not_accepted", "expired", "no_study", "not_judged", "marginal"];
export const COVERAGE_FILTERS = [{ key: "attention", label: "Needs attention" }, ...COVERAGE_STATES.map((s) => ({ key: s.value, label: s.label })), { key: "all", label: "All" }];

/** The worst state among rows (the state list is in order, worst first). */
export const worstCoverage = (states) => {
  const order = COVERAGE_STATES.map((s) => s.value);
  return [...states].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? null;
};

/** What a study planned from a coverage row starts with. */
export const studyDefaultsFor = (row) => ({
  studyType: row.characteristic.dataType === "attribute" ? "attribute" : "grr_crossed",
  gauge: row.gauge ? { id: row.gauge.id, assetNumber: row.gauge.assetNumber, description: row.gauge.description } : null,
  part: row.part ? { id: row.part.id, partNumber: row.part.partNumber, name: row.part.name } : null,
  characteristicKey: row.characteristic.key,
  characteristicName: row.characteristic.name,
});
