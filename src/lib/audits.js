/** Audits (Documentation → Audits): labels and small helpers shared by the register, the page and the form. */
export const AUDIT_TYPES = [
  { value: "process", label: "Process audit" },
  { value: "product", label: "Product audit" },
  { value: "system", label: "System audit" },
  { value: "supplier", label: "Supplier audit" },
  { value: "housekeeping", label: "Housekeeping / 5S" },
  { value: "layered_process", label: "Layered process audit" },
  { value: "other", label: "Other" },
];
export const auditTypeLabel = (v) => AUDIT_TYPES.find((t) => t.value === v)?.label ?? v;

export const FREQUENCIES = [
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "quarterly", label: "Every quarter" },
  { value: "six_monthly", label: "Every six months" },
  { value: "yearly", label: "Every year" },
  { value: "every_n_days", label: "Every N days" },
  { value: "on_demand", label: "On demand (no schedule)" },
];
export const frequencyLabel = (f) => {
  if (!f) return "—";
  if (f.kind === "every_n_days") return f.interval === 1 ? "Every day" : `Every ${f.interval} days`;
  return FREQUENCIES.find((x) => x.value === f.kind)?.label ?? f.kind;
};

export const ANSWER_TYPES = [
  { value: "pass_fail", label: "Pass / fail / not applicable" },
  { value: "yes_no", label: "Yes / no / not applicable" },
  { value: "number", label: "A number within limits" },
  { value: "text", label: "A note (not scored)" },
];
export const answerTypeLabel = (v) => ANSWER_TYPES.find((t) => t.value === v)?.label ?? v;

export const AUDITOR_KINDS = [
  { value: "none", label: "Nobody in particular" },
  { value: "person", label: "A named person" },
  { value: "role", label: "Anyone with a role" },
  { value: "department", label: "A department" },
];
export const auditorLabel = (a) => (a && a.kind !== "none" && a.name ? a.name : "Anyone who may perform audits");

/** A limits sentence for a number question, e.g. "6 to 9 %". */
export const limitsLabel = (q) => {
  if (q.answerType !== "number") return null;
  const unit = q.unit ? ` ${q.unit}` : "";
  if (q.lowerLimit != null && q.upperLimit != null) return `${q.lowerLimit} to ${q.upperLimit}${unit}`;
  if (q.lowerLimit != null) return `at least ${q.lowerLimit}${unit}`;
  return `at most ${q.upperLimit}${unit}`;
};

export const emptyQuestion = () => ({ key: Math.random().toString(36).slice(2), question: "", guidance: "", answerType: "pass_fail", passAnswer: "yes", unit: "", lowerLimit: "", upperLimit: "", critical: false });

/** A form's questions → the body the API takes. */
export const questionsBody = (questions) =>
  questions.map((q) => ({
    question: q.question.trim(),
    guidance: q.guidance?.trim() || null,
    answerType: q.answerType,
    ...(q.answerType === "yes_no" ? { passAnswer: q.passAnswer } : {}),
    ...(q.answerType === "number" ? { unit: q.unit?.trim() || null, lowerLimit: q.lowerLimit === "" ? null : Number(q.lowerLimit), upperLimit: q.upperLimit === "" ? null : Number(q.upperLimit) } : {}),
    critical: q.answerType === "text" ? false : !!q.critical,
  }));

// ---- audit records and the schedule (AU2, AU3) -----------------------------------------------------
export const RECORD_STATUSES = [
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "abandoned", label: "Abandoned" },
];
export const recordStatusLabel = (v) => RECORD_STATUSES.find((s) => s.value === v)?.label ?? v;
export const RECORD_RESULTS = [
  { value: "pass", label: "Pass" },
  { value: "fail", label: "Fail" },
];
export const resultLabel = (v) => RECORD_RESULTS.find((s) => s.value === v)?.label ?? "—";

/** Pill colours for a record's result and a slot's state (theme tokens only). */
export const RESULT_PILL = { pass: "bg-success-color/15 text-success-color", fail: "bg-error-color/15 text-error-color" };
export const STATUS_PILL = {
  in_progress: "bg-warning-color/15 text-warning-color",
  completed: "bg-success-color/15 text-success-color",
  abandoned: "bg-border-color text-secondary-text",
};

export const SLOT_STATES = [
  { value: "upcoming", label: "Upcoming" },
  { value: "in_progress", label: "In progress" },
  { value: "overdue", label: "Overdue" },
  { value: "missed", label: "Missed" },
  { value: "done", label: "Done" },
  { value: "skipped", label: "Skipped" },
];
export const slotStateLabel = (v) => SLOT_STATES.find((s) => s.value === v)?.label ?? v;
export const SLOT_PILL = {
  upcoming: "bg-brand-primary/15 text-primary-text",
  in_progress: "bg-warning-color/15 text-warning-color",
  overdue: "bg-warning-color/15 text-warning-color",
  missed: "bg-error-color/15 text-error-color",
  done: "bg-success-color/15 text-success-color",
  skipped: "bg-border-color text-secondary-text",
};
/** A done slot is coloured by what the audit found. */
export const slotPill = (item) => (item.state === "done" && item.record?.result === "fail" ? SLOT_PILL.missed : SLOT_PILL[item.state]);
export const slotLabel = (item) => (item.state === "done" ? `Done · ${resultLabel(item.record?.result)}` : slotStateLabel(item.state));

/** "66.7%" from a score; the database keeps two decimals. */
export const formatScore = (score) => (score == null ? "—" : `${Number(Number(score).toFixed(1))}%`);

/**
 * What the database will work out for an answer, used only to show something straight away while the save is on its way (the refetch replaces it with the database's answer).
 */
export const provisionalResult = (q, { answer, value }) => {
  if (answer === "na") return "na";
  if (q.answerType === "pass_fail") return answer === "pass" || answer === "fail" ? answer : null;
  if (q.answerType === "yes_no") return answer === "yes" || answer === "no" ? (answer === q.passAnswer ? "pass" : "fail") : null;
  if (q.answerType === "number") {
    if (value == null) return null;
    return (q.lowerLimit == null || value >= q.lowerLimit) && (q.upperLimit == null || value <= q.upperLimit) ? "pass" : "fail";
  }
  return null;
};

/** A machine / operation / department choice → the body the API takes, and a stable key. */
export const targetKey = (t) => `${t.kind}:${t.id}`;
export const targetBody = (t) => (t.kind === "machine" ? { kind: "machine", machineId: t.id } : t.kind === "operation" ? { kind: "operation", operationCode: t.id } : { kind: "department", departmentId: t.id });

/** The weeks (Monday first) of a month "YYYY-MM" as arrays of "YYYY-MM-DD", padded with the neighbouring months' days. */
export const monthWeeks = (month) => {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const total = Math.ceil((lead + days) / 7) * 7;
  const cells = Array.from({ length: total }, (_, i) => new Date(Date.UTC(y, m - 1, 1 - lead + i)).toISOString().slice(0, 10));
  return Array.from({ length: total / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
};
export const shiftMonth = (month, by) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
};
export const monthBounds = (month) => {
  const [y, m] = month.split("-").map(Number);
  return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
};
export const monthLabel = (month) => new Date(`${month}-01T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
