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

/** The ten ways a checklist question can be answered. `hint` is an example question; the template's choice decides what the audit record form shows. */
export const ANSWER_TYPES = [
  { value: "yes_no", label: "Yes / No", hint: "Is the procedure being followed?" },
  { value: "compliant", label: "Compliant / Non-compliant", hint: "Does the process meet requirements?" },
  { value: "pass_fail", label: "Pass / Fail", hint: "Does the product meet specifications?" },
  { value: "yes_no_na", label: "Yes / No / N/A", hint: "Is the requirement applicable?" },
  { value: "numeric", label: "Numeric", hint: "What was the measured temperature?" },
  { value: "text", label: "Text", hint: "Describe the observation" },
  { value: "multiple_choice", label: "Multiple choice", hint: "Select applicable condition" },
  { value: "measurement", label: "Measurement", hint: "Enter actual dimensional measurement" },
  { value: "evidence", label: "Evidence required", hint: "Upload photograph/document" },
  { value: "rating", label: "Rating", hint: "Score from 1–5" },
];
export const answerTypeLabel = (v) => ANSWER_TYPES.find((t) => t.value === v)?.label ?? v;

/** Can the question fail? Only such a question may be critical, and only it counts towards the score. */
export const isScoredType = (q) =>
  ["yes_no", "compliant", "pass_fail", "yes_no_na", "multiple_choice", "measurement"].includes(q.answerType) ||
  (q.answerType === "numeric" && (hasValue(q.lowerLimit) || hasValue(q.upperLimit))) ||
  (q.answerType === "rating" && hasValue(q.passRating));
const hasValue = (v) => v !== "" && v !== null && v !== undefined;

export const AUDITOR_KINDS = [
  { value: "none", label: "Nobody in particular" },
  { value: "person", label: "A named person" },
  { value: "role", label: "Anyone with a role" },
  { value: "department", label: "A department" },
];
export const auditorLabel = (a) => (a && a.kind !== "none" && a.name ? a.name : "Anyone who may perform audits");

/** A sentence about the limits of a numeric or measurement question, e.g. "6 to 9 %". */
export const limitsLabel = (q) => {
  if (q.answerType !== "numeric" && q.answerType !== "measurement") return null;
  const unit = q.unit ? ` ${q.unit}` : "";
  if (q.lowerLimit != null && q.upperLimit != null) return `${q.lowerLimit} to ${q.upperLimit}${unit}`;
  if (q.lowerLimit != null) return `at least ${q.lowerLimit}${unit}`;
  if (q.upperLimit != null) return `at most ${q.upperLimit}${unit}`;
  return null;
};

/** What the template says about how a question is answered and what passes, in words (for the audit page and the record). */
export const questionRule = (q) => {
  switch (q.answerType) {
    case "yes_no":
    case "yes_no_na":
      return `"${q.passAnswer}" passes`;
    case "compliant":
      return "Compliant passes";
    case "pass_fail":
      return "Pass passes";
    case "numeric":
      return limitsLabel(q) ? `passes ${limitsLabel(q)}` : "recorded, not scored";
    case "measurement":
      return `nominal ${q.nominal}${q.unit ? ` ${q.unit}` : ""}; passes ${limitsLabel(q)}`;
    case "multiple_choice":
      return `acceptable: ${(q.options ?? []).filter((o) => o.passes).map((o) => o.label).join(", ")}`;
    case "rating":
      return q.passRating != null ? `1 to ${q.ratingMax}; ${q.passRating} or more passes` : `1 to ${q.ratingMax}; not scored`;
    case "evidence":
      return "at least one photograph or document is needed";
    default:
      return "a note, not scored";
  }
};

export const emptyOption = () => ({ key: Math.random().toString(36).slice(2), label: "", passes: true });
export const emptyQuestion = () => ({
  key: Math.random().toString(36).slice(2),
  question: "",
  guidance: "",
  answerType: "pass_fail",
  passAnswer: "yes",
  unit: "",
  lowerLimit: "",
  upperLimit: "",
  nominal: "",
  tolMinus: "",
  tolPlus: "",
  options: [emptyOption(), emptyOption()],
  ratingMax: "5",
  passRating: "",
  critical: false,
});

/** A question from the API → what the form edits (a measurement's tolerance is its nominal against its limits). */
export const questionToForm = (q) => ({
  key: q.id,
  question: q.question,
  guidance: q.guidance ?? "",
  answerType: q.answerType,
  passAnswer: q.passAnswer ?? "yes",
  unit: q.unit ?? "",
  lowerLimit: q.lowerLimit ?? "",
  upperLimit: q.upperLimit ?? "",
  nominal: q.nominal ?? "",
  tolMinus: q.nominal != null && q.lowerLimit != null ? Number((q.nominal - q.lowerLimit).toFixed(10)) : "",
  tolPlus: q.nominal != null && q.upperLimit != null ? Number((q.upperLimit - q.nominal).toFixed(10)) : "",
  options: q.options ? q.options.map((o) => ({ key: Math.random().toString(36).slice(2), label: o.label, passes: o.passes })) : [emptyOption(), emptyOption()],
  ratingMax: String(q.ratingMax ?? 5),
  passRating: q.passRating == null ? "" : String(q.passRating),
  critical: q.critical,
});

const num = (v) => (v === "" || v === null || v === undefined ? null : Number(v));
/** A measurement's limits from its nominal and tolerance. */
export const measurementLimits = (q) => {
  const nominal = num(q.nominal);
  const minus = num(q.tolMinus);
  const plus = num(q.tolPlus);
  if (nominal === null || minus === null || plus === null) return null;
  return { lower: Number((nominal - minus).toFixed(10)), upper: Number((nominal + plus).toFixed(10)) };
};

/** What is wrong with a question as written, in words (empty when it can be saved). */
export const questionProblems = (q, n) => {
  const at = `Question ${n}`;
  const out = [];
  if (!q.question.trim()) out.push("Every question needs its words");
  if (q.answerType === "numeric" && num(q.lowerLimit) !== null && num(q.upperLimit) !== null && num(q.lowerLimit) > num(q.upperLimit)) out.push(`${at}: the lower limit is above the upper limit`);
  if (q.answerType === "measurement") {
    if (num(q.nominal) === null || num(q.tolMinus) === null || num(q.tolPlus) === null || !q.unit.trim()) out.push(`${at}: a measurement needs a nominal value, its tolerance (− and +) and a unit`);
    else if (num(q.tolMinus) < 0 || num(q.tolPlus) < 0) out.push(`${at}: a tolerance cannot be negative`);
  }
  if (q.answerType === "multiple_choice") {
    const labels = q.options.map((o) => o.label.trim().toLowerCase());
    if (q.options.length < 2 || labels.some((l) => !l)) out.push(`${at}: give at least two options, each with its words`);
    else if (new Set(labels).size !== labels.length) out.push(`${at}: an option is listed twice`);
    else if (!q.options.some((o) => o.passes)) out.push(`${at}: at least one option must be acceptable`);
  }
  return out;
};

/** A form's questions → the body the API takes. Only what belongs to the question's type is sent. */
export const questionsBody = (questions) =>
  questions.map((q) => {
    const base = { question: q.question.trim(), guidance: q.guidance?.trim() || null, answerType: q.answerType };
    const critical = isScoredType(q) ? !!q.critical : false;
    switch (q.answerType) {
      case "yes_no":
      case "yes_no_na":
        return { ...base, passAnswer: q.passAnswer, critical };
      case "numeric":
        return { ...base, unit: q.unit?.trim() || null, lowerLimit: num(q.lowerLimit), upperLimit: num(q.upperLimit), critical };
      case "measurement": {
        const limits = measurementLimits(q);
        return { ...base, unit: q.unit?.trim() || null, nominal: num(q.nominal), lowerLimit: limits?.lower ?? null, upperLimit: limits?.upper ?? null, critical };
      }
      case "multiple_choice":
        return { ...base, options: q.options.map((o) => ({ label: o.label.trim(), passes: !!o.passes })), critical };
      case "rating":
        return { ...base, ratingMax: Number(q.ratingMax) || 5, passRating: num(q.passRating), critical };
      default:
        return { ...base, critical };
    }
  });

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
export const provisionalResult = (q, { answer, value, choice }) => {
  if (answer === "na") return "na";
  switch (q.answerType) {
    case "pass_fail":
      return answer === "pass" || answer === "fail" ? answer : null;
    case "compliant":
      return answer === "compliant" ? "pass" : answer === "non_compliant" ? "fail" : null;
    case "yes_no":
    case "yes_no_na":
      return answer === "yes" || answer === "no" ? (answer === q.passAnswer ? "pass" : "fail") : null;
    case "numeric":
    case "measurement":
      if (value == null || (q.lowerLimit == null && q.upperLimit == null)) return null;
      return (q.lowerLimit == null || value >= q.lowerLimit) && (q.upperLimit == null || value <= q.upperLimit) ? "pass" : "fail";
    case "multiple_choice": {
      const option = (q.options ?? []).find((o) => o.label.toLowerCase() === String(choice ?? "").trim().toLowerCase());
      return option ? (option.passes ? "pass" : "fail") : null;
    }
    case "rating":
      if (value == null || q.passRating == null) return null;
      return value >= q.passRating ? "pass" : "fail";
    default:
      return null;
  }
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

// ---- findings (Phase A) -------------------------------------------------------------------------------
export const FINDING_KINDS = [
  { value: "nonconformity", label: "Non-conformity" },
  { value: "observation", label: "Observation" },
  { value: "opportunity", label: "Opportunity for improvement" },
];
export const findingKindLabel = (v) => FINDING_KINDS.find((k) => k.value === v)?.label ?? v;
export const FINDING_STATUSES = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "withdrawn", label: "Withdrawn" },
];
export const findingStatusLabel = (v) => FINDING_STATUSES.find((s) => s.value === v)?.label ?? v;
export const FINDING_STATUS_PILL = {
  open: "bg-warning-color/15 text-warning-color",
  closed: "bg-success-color/15 text-success-color",
  withdrawn: "bg-border-color text-secondary-text",
};
/** A classification's colour follows its kind, so a renamed or added classification still reads right. */
export const FINDING_KIND_PILL = {
  nonconformity: "bg-error-color/15 text-error-color",
  observation: "bg-brand-primary/15 text-primary-text",
  opportunity: "bg-success-color/15 text-success-color",
};
export const SEVERITIES = [
  { value: "critical", label: "Critical" },
  { value: "major", label: "Major" },
  { value: "minor", label: "Minor" },
];
export const severityLabel = (v) => SEVERITIES.find((s) => s.value === v)?.label ?? "—";

/** What a finding raised from a failed answer starts with: the question as its title and the auditor's words as what was found. */
export const findingFromAnswer = (q) => ({
  title: q.question.slice(0, 200),
  description: [q.response?.note, q.response?.choice && `Answered: ${q.response.choice}`].filter(Boolean).join("\n") || q.question,
});

/** The classification to suggest for a failed answer: major for a critical question, else minor, else the first non-conformity, else the first. */
export const suggestClassification = (classifications, q) => {
  const active = classifications.filter((c) => c.active);
  const byKey = (k) => active.find((c) => c.key === k);
  return (q?.critical ? byKey("major_nc") : byKey("minor_nc")) ?? active.find((c) => c.kind === "nonconformity") ?? active[0] ?? null;
};

/** The words of a non-conformance raised from a finding, shown before it is made (the API fills the same ones when none are sent). */
export const ncrPreview = (finding) => ({
  title: finding.title,
  description: `Raised from audit ${finding.record.reference}, finding ${finding.reference}.`,
});
