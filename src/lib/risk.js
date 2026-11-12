/** Risk register (docs/risk-management-plan.md): labels, colours and small rules shared by the screens. */

export const BANDS = ["low", "medium", "high", "critical"];
export const BAND_LABEL = { low: "Low", medium: "Medium", high: "High", critical: "Critical" };

/** A filled cell of the matrix: the colour always comes with the band's word, never alone. */
export const BAND_CELL = {
  low: "bg-green-600 text-white",
  medium: "bg-yellow-400 text-black",
  high: "bg-orange-500 text-white",
  critical: "bg-red-700 text-white",
};
/** A pill beside words. */
export const BAND_PILL = {
  low: "bg-success-color/15 text-success-color",
  medium: "bg-warning-color/15 text-warning-color",
  high: "bg-orange-500/15 text-orange-600",
  critical: "bg-error-color/15 text-error-color",
};
export const bandLabel = (band) => BAND_LABEL[band] ?? "Not assessed";

export const RISK_KINDS = [
  { value: "risk", label: "Risk", hint: "Something that could go wrong" },
  { value: "opportunity", label: "Opportunity", hint: "Something that could go better" },
];
export const kindLabel = (kind) => (kind === "opportunity" ? "Opportunity" : "Risk");

export const RISK_STATUS = {
  draft: { label: "Draft", tone: "neutral" },
  open: { label: "Open", tone: "warning" },
  treating: { label: "Treating", tone: "info" },
  monitoring: { label: "Monitoring", tone: "info" },
  closed: { label: "Closed", tone: "success" },
  retired: { label: "Retired", tone: "neutral" },
};
const TONE_CLASS = {
  success: "bg-success-color/15 text-success-color",
  warning: "bg-warning-color/15 text-warning-color",
  info: "bg-brand-primary/15 text-brand-primary",
  neutral: "bg-secondary-bg text-secondary-text",
};
export const statusLabel = (status) => RISK_STATUS[status]?.label ?? status;
export const statusPill = (status) => TONE_CLASS[RISK_STATUS[status]?.tone ?? "neutral"];

export const STATUS_OPTIONS = [
  { value: "", label: "In the register" },
  { value: "draft", label: "Draft" },
  { value: "open", label: "Open" },
  { value: "retired", label: "Retired" },
  { value: "all", label: "All" },
];
export const BAND_OPTIONS = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "unassessed", label: "Not assessed" },
];

export const riskPath = (id) => `/Risk/Register/${id}`;

/** The band of a cell (levels 1-5) on a matrix config. */
export const cellBand = (config, likelihood, consequence) => config?.bands?.[likelihood - 1]?.[consequence - 1] ?? null;

/** Whether a band needs an approved acceptance under this matrix. */
export const isAcceptable = (config, band) => BANDS.indexOf(band) <= BANDS.indexOf(config?.acceptanceBand ?? "medium");

/** "4 × 4 = 16 · High". */
export const scoreWords = (a) => (a ? `${a.likelihood} × ${a.consequence} = ${a.score} · ${bandLabel(a.band)}` : "Not assessed");

/** The next band when a cell is clicked in the matrix editor. */
export const nextBand = (band) => BANDS[(BANDS.indexOf(band) + 1) % BANDS.length];

/** What stops a matrix being saved, in words (the database checks again). */
export const modelProblems = (config) => {
  const problems = [];
  for (const [key, word] of [["likelihood", "likelihood"], ["consequence", "consequence"]]) {
    const labels = (config[key] ?? []).map((l) => (l.label ?? "").trim().toLowerCase());
    if (labels.some((l) => !l)) problems.push(`Give every level of ${word} a label`);
    else if (new Set(labels).size !== labels.length) problems.push(`The levels of ${word} need different labels`);
  }
  for (const band of BANDS) {
    const m = Number(config.reviewMonths?.[band]);
    if (!Number.isInteger(m) || m < 1 || m > 60) problems.push(`The review interval for ${BAND_LABEL[band].toLowerCase()} is 1 to 60 months`);
  }
  return problems;
};

export const formatDay = (value) => {
  if (!value) return "—";
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};
