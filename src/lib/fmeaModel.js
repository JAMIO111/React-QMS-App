/** The FMEA rating model (docs/fmea-plan.md FM2): the words, and the checks that tell a person what is still missing before the server decides. */
export const SCALE_DIMENSIONS = [
  { key: "severity", label: "Severity", letter: "S", hint: "How serious the effect is. 1 is the least serious." },
  { key: "occurrence", label: "Occurrence", letter: "O", hint: "How likely the cause is. 1 is the least likely." },
  { key: "detection", label: "Detection", letter: "D", hint: "How well the controls would catch it. 1 is almost certain to be caught, 10 means it cannot be." },
];
export const MODEL_KINDS = [
  { value: "process", label: "Process" },
  { value: "design", label: "Design" },
];
export const PRIORITY_LABEL = { high: "High", medium: "Medium", low: "Low" };
/** A pill beside its word. */
export const PRIORITY_PILL = {
  high: "bg-error-color/15 text-error-color",
  medium: "bg-warning-color/15 text-warning-color",
  low: "bg-success-color/15 text-success-color",
};
export const priorityLabel = (priority) => PRIORITY_LABEL[priority] ?? "—";

export const methodLabel = (method) => (method === "ap" ? "Action priority grid" : "RPN (severity × occurrence × detection)");
export const methodWords = (config) =>
  config.method === "ap"
    ? `Priority comes from your action priority grid (${config.apRules.length} ${config.apRules.length === 1 ? "range" : "ranges"}).`
    : `Priority comes from the RPN: high from ${config.rpnHighFrom}, medium from ${config.rpnMediumFrom}.`;

const wholeBetween = (value, min, max) => {
  const n = Number(value);
  return value !== "" && value !== null && Number.isInteger(n) && n >= min && n <= max;
};

/** What a model still needs before it can be saved (the database checks the same things again). */
export const modelProblems = (config) => {
  const problems = [];
  if (config.method === "ap" && config.apRules.length === 0) problems.push("The action priority method needs an action priority grid: import one, or choose RPN");
  if (config.method === "rpn" || config.method === "ap") {
    if (!wholeBetween(config.rpnHighFrom, 2, 1000)) problems.push("High priority starts at an RPN of 2 to 1,000");
    else if (!wholeBetween(config.rpnMediumFrom, 1, Number(config.rpnHighFrom) - 1)) problems.push("Medium priority starts at a lower RPN than high");
  }
  if (!wholeBetween(config.severityFloor, 1, 10)) problems.push("The severity that always needs attention is 1 to 10");
  if (!wholeBetween(config.reviewMonths, 1, 120)) problems.push("The review interval is 1 to 120 months");
  for (const kind of MODEL_KINDS) {
    for (const dim of SCALE_DIMENSIONS) {
      const levels = config.scales[kind.value][dim.key];
      const where = `${dim.label.toLowerCase()} (${kind.label.toLowerCase()})`;
      if (levels.some((l) => !l.label.trim())) problems.push(`Every level of ${where} needs a label`);
      else if (levels.some((l) => l.label.trim().length > 40)) problems.push(`A label of ${where} is up to 40 characters`);
      else if (new Set(levels.map((l) => l.label.trim().toLowerCase())).size < levels.length) problems.push(`The levels of ${where} need different labels`);
      if (levels.some((l) => (l.criteria ?? "").length > 300)) problems.push(`The criteria of ${where} are up to 300 characters each`);
    }
  }
  return problems;
};

/** The model as the server wants it: whole numbers, trimmed words, no empty criteria. */
export const cleanModel = (config) => ({
  method: config.method,
  rpnHighFrom: Number(config.rpnHighFrom),
  rpnMediumFrom: Number(config.rpnMediumFrom),
  severityFloor: Number(config.severityFloor),
  reviewMonths: Number(config.reviewMonths),
  scales: Object.fromEntries(
    MODEL_KINDS.map((k) => [
      k.value,
      Object.fromEntries(
        SCALE_DIMENSIONS.map((d) => [
          d.key,
          config.scales[k.value][d.key].map((l) => ({ label: l.label.trim(), ...((l.criteria ?? "").trim() ? { criteria: l.criteria.trim() } : {}) })),
        ]),
      ),
    ]),
  ),
  apRules: config.apRules.map((r) => ({ sFrom: r.sFrom, sTo: r.sTo, oFrom: r.oFrom, oTo: r.oTo, dFrom: r.dFrom, dTo: r.dTo, priority: r.priority })),
});

/** "S 9–10 · O any · D any → High" for a range of the grid. */
export const ruleWords = (r) => {
  const span = (letter, from, to) => (from === 1 && to === 10 ? `${letter} any` : from === to ? `${letter} ${from}` : `${letter} ${from}–${to}`);
  return `${span("S", r.sFrom, r.sTo)} · ${span("O", r.oFrom, r.oTo)} · ${span("D", r.dFrom, r.dTo)} → ${priorityLabel(r.priority)}`;
};
