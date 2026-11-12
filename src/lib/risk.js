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
  { value: "treating", label: "Treating" },
  { value: "monitoring", label: "Monitoring" },
  { value: "closed", label: "Closed" },
  { value: "retired", label: "Retired" },
  { value: "all", label: "All" },
];

/** What will be done about it. An opportunity is exploited or left; a risk is never "exploited". */
export const STRATEGIES = [
  { value: "mitigate", label: "Mitigate", hint: "Make it less likely or less serious", kinds: ["risk"] },
  { value: "avoid", label: "Avoid", hint: "Stop doing what causes it", kinds: ["risk"] },
  { value: "transfer", label: "Transfer", hint: "Pass it on: insurance, a contract, a supplier", kinds: ["risk"] },
  { value: "accept", label: "Accept", hint: "Live with it as it is", kinds: ["risk"] },
  { value: "exploit", label: "Exploit", hint: "Go after it", kinds: ["opportunity"] },
  { value: "accept", label: "Leave", hint: "Not pursued for now", kinds: ["opportunity"] },
];
export const strategyOptions = (kind) => STRATEGIES.filter((s) => s.kinds.includes(kind === "opportunity" ? "opportunity" : "risk")).map(({ value, label, hint }) => ({ value, label, hint }));
export const strategyLabel = (strategy, kind) => strategyOptions(kind).find((s) => s.value === strategy)?.label ?? "Not decided";

export const outcomeOptions = (kind) =>
  kind === "opportunity"
    ? [
        { value: "treated", label: "Realised", hint: "It was pursued and the work is done" },
        { value: "accepted", label: "Left", hint: "Not pursued" },
        { value: "no_longer_applies", label: "No longer applies", hint: "Things have changed" },
      ]
    : [
        { value: "treated", label: "Treated", hint: "The actions are done and what is left is acceptable" },
        { value: "accepted", label: "Accepted", hint: "Lived with as it is" },
        { value: "no_longer_applies", label: "No longer applies", hint: "Things have changed" },
      ];
export const outcomeLabel = (outcome, kind) => outcomeOptions(kind).find((o) => o.value === outcome)?.label ?? outcome;

export const ACTION_STATUS = {
  open: { label: "Open", tone: "bg-warning-color/15 text-warning-color" },
  done: { label: "Done", tone: "bg-success-color/15 text-success-color" },
  cancelled: { label: "Cancelled", tone: "bg-secondary-bg text-secondary-text" },
};
export const ACCEPTANCE_STATUS = {
  proposed: { label: "Waiting for an approver", tone: "bg-warning-color/15 text-warning-color" },
  approved: { label: "Approved", tone: "bg-success-color/15 text-success-color" },
  rejected: { label: "Rejected", tone: "bg-error-color/15 text-error-color" },
  withdrawn: { label: "Withdrawn", tone: "bg-secondary-bg text-secondary-text" },
};

/** "Review overdue since 3 Nov 2026" / "Next review 3 Feb 2027" / null when there is none. */
export const reviewWords = (risk) => (!risk?.nextReviewOn ? null : risk.reviewOverdue ? `Review overdue since ${formatDay(risk.nextReviewOn)}` : `Next review ${formatDay(risk.nextReviewOn)}`);

/** Whether an open action is past its date (dates are yyyy-MM-dd, compared with the person's own today). */
export const actionOverdue = (action, today) => action.status === "open" && !!action.dueDate && action.dueDate < today;
export const BAND_OPTIONS = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "unassessed", label: "Not assessed" },
];

export const riskPath = (id) => `/Risk/Register/${id}`;

/** What a risk can be linked to, in the order the link editor offers them. */
export const LINK_KINDS = [
  { value: "ncr", label: "Non-conformance", plural: "Non-conformances" },
  { value: "capa", label: "8D", plural: "8Ds" },
  { value: "audit_finding", label: "Audit finding", plural: "Audit findings" },
  { value: "supplier", label: "Supplier", plural: "Suppliers" },
  { value: "part", label: "Part", plural: "Parts" },
  { value: "part_family", label: "Part family", plural: "Part families" },
  { value: "machine", label: "Machine", plural: "Machines" },
  { value: "document", label: "Document", plural: "Documents" },
  { value: "operation_code", label: "Operation", plural: "Operations" },
];
export const linkKindLabel = (kind) => LINK_KINDS.find((k) => k.value === kind)?.label ?? kind;

/** The page of a linked record, or null when it has none (an operation code). */
export const linkPath = (link) => {
  if (!link?.id) return null;
  switch (link.kind) {
    case "ncr":
      return `/Non-Conformance/Register/${link.id}`;
    case "capa":
      return `/CAPA/${link.id}`;
    case "audit_finding":
      return `/Audits/Findings/${link.id}`;
    case "supplier":
      return `/Suppliers/${link.id}`;
    case "part":
      return `/Parts/${link.id}`;
    case "part_family":
      return `/Part-Families/${link.id}`;
    case "machine":
      return "/Machines";
    case "document":
      return `/Documentation/Documents/${link.id}`;
    default:
      return null;
  }
};

/** "NC-0012 · Cracked weld", or a plain word when the reader may not see the record. */
export const linkWords = (link) =>
  link.kind === "operation_code" ? link.code : link.readable ? [link.reference, link.name].filter(Boolean).join(" · ") : `A ${linkKindLabel(link.kind).toLowerCase()} you cannot open`;

/** The body the API takes for a list of links. */
export const linksBody = (links) => links.map((l) => (l.kind === "operation_code" ? { kind: l.kind, code: l.code } : { kind: l.kind, id: l.id }));

/** The same link twice (same kind and record, or the same operation ignoring case). */
export const sameLink = (a, b) => a.kind === b.kind && (a.kind === "operation_code" ? a.code?.toUpperCase() === b.code?.toUpperCase() : a.id === b.id);

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

export function formatDay(value) {
  if (!value) return "—";
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
