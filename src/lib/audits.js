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
