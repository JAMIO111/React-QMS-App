/**
 * Import templates (UI2c): the step-by-step transforms a field row can have, what each needs, and helpers for the template screens.
 * The server is the only place values are worked out (T3): nothing here reads or converts a value from a file.
 */

export const UNIT_OPTIONS = [
  { value: "mm", label: "Millimetres (mm)" },
  { value: "cm", label: "Centimetres (cm)" },
  { value: "m", label: "Metres (m)" },
  { value: "in", label: "Inches (in)" },
  { value: "ft", label: "Feet (ft)" },
  { value: "g", label: "Grams (g)" },
  { value: "kg", label: "Kilograms (kg)" },
  { value: "lb", label: "Pounds (lb)" },
  { value: "oz", label: "Ounces (oz)" },
  { value: "c", label: "Degrees Celsius (°C)" },
  { value: "f", label: "Degrees Fahrenheit (°F)" },
];

export const IF_TEST_OPTIONS = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "contains", label: "contains" },
  { value: "starts_with", label: "starts with" },
  { value: "empty", label: "is empty" },
  { value: "not_empty", label: "is not empty" },
  { value: "one_of", label: "is one of" },
];

const DATE_FORMATS = [
  { value: "iso", label: "Year-month-day (2026-11-09)" },
  { value: "dmy", label: "Day/month/year (09/11/2026)" },
  { value: "mdy", label: "Month/day/year (11/09/2026)" },
  { value: "excel", label: "Excel date number" },
  { value: "pattern", label: "A pattern such as dd.MM.yyyy" },
];

/**
 * Every step kind with its group, label, what it does and its settings. A setting: `{ key, label, type, options?, required?, hint? }` where type is
 * text | number | select | boolean | columns (a list of columns) | values (from=to lines) | list (one per line) | parts (join pieces) | date (a date format).
 */
export const STEP_KINDS = [
  { kind: "trim", group: "Text", label: "Trim spaces", hint: "Removes spaces at the start and end", settings: [] },
  { kind: "upper", group: "Text", label: "Capitals", hint: "ABC", settings: [] },
  { kind: "lower", group: "Text", label: "Lower case", hint: "abc", settings: [] },
  { kind: "title", group: "Text", label: "Each word with a capital", hint: "Big Lathe", settings: [] },
  { kind: "collapse_spaces", group: "Text", label: "Single spaces", hint: "Runs of spaces become one", settings: [] },
  {
    kind: "replace", group: "Text", label: "Replace", hint: "Every time it appears",
    settings: [{ key: "find", label: "Find", type: "text", required: true }, { key: "with", label: "Replace with", type: "text" }, { key: "ignoreCase", label: "Ignore case", type: "boolean", default: true }],
  },
  { kind: "remove", group: "Text", label: "Remove characters", hint: "Each character listed is removed", settings: [{ key: "characters", label: "Characters", type: "text", required: true }] },
  { kind: "left", group: "Text", label: "First characters", settings: [{ key: "count", label: "How many", type: "number", required: true, min: 1, max: 1000 }] },
  { kind: "right", group: "Text", label: "Last characters", settings: [{ key: "count", label: "How many", type: "number", required: true, min: 1, max: 1000 }] },
  {
    kind: "split", group: "Text", label: "Take one part", hint: "Split at a separator and keep one part",
    settings: [{ key: "separator", label: "Separator", type: "text", required: true }, { key: "part", label: "Part (1 = first, -1 = last)", type: "number", required: true, min: -50, max: 50 }],
  },
  { kind: "prefix", group: "Text", label: "Add before", settings: [{ key: "text", label: "Text", type: "text", required: true }] },
  { kind: "suffix", group: "Text", label: "Add after", settings: [{ key: "text", label: "Text", type: "text", required: true }] },
  {
    kind: "number", group: "Number", label: "Read a number",
    settings: [
      { key: "decimal", label: "Decimal mark", type: "select", options: [{ value: ".", label: "Point (1.5)" }, { value: ",", label: "Comma (1,5)" }], default: "." },
      { key: "thousands", label: "Thousands separator", type: "select", options: [{ value: "", label: "None" }, { value: ",", label: "Comma" }, { value: ".", label: "Point" }, { value: " ", label: "Space" }, { value: "'", label: "Apostrophe" }], default: "" },
    ],
  },
  { kind: "round", group: "Number", label: "Round", settings: [{ key: "places", label: "Decimal places", type: "number", required: true, min: 0, max: 10, default: 0 }] },
  { kind: "multiply", group: "Number", label: "Multiply", settings: [{ key: "by", label: "By", type: "number", required: true }] },
  { kind: "divide", group: "Number", label: "Divide", settings: [{ key: "by", label: "By", type: "number", required: true }] },
  {
    kind: "convert", group: "Number", label: "Convert units",
    settings: [{ key: "from", label: "From", type: "select", options: UNIT_OPTIONS, required: true }, { key: "to", label: "To", type: "select", options: UNIT_OPTIONS, required: true }],
  },
  { kind: "date", group: "Date", label: "Read a date", settings: [{ key: "format", label: "Written as", type: "date", required: true, default: "iso" }] },
  { kind: "add_days", group: "Date", label: "Add days", settings: [{ key: "days", label: "Days (negative goes back)", type: "number", required: true, min: -36500, max: 36500 }] },
  {
    kind: "map", group: "Logic", label: "Translate values", hint: "Ignoring case and spaces at the ends",
    settings: [
      { key: "values", label: "One per line: value in the file=value in Fortress", type: "values", required: true },
      { key: "unmatched", label: "A value not in the list", type: "select", options: [{ value: "keep", label: "Keep it" }, { value: "empty", label: "Leave the field empty" }, { value: "error", label: "Reject the row" }], default: "keep" },
    ],
  },
  {
    kind: "if", group: "Logic", label: "If … then …",
    settings: [
      { key: "test", label: "When the value", type: "select", options: IF_TEST_OPTIONS, required: true, default: "equals" },
      { key: "value", label: "Value", type: "text", showWhen: (s) => ["equals", "not_equals", "contains", "starts_with"].includes(s.test) },
      { key: "list", label: "One per line", type: "list", showWhen: (s) => s.test === "one_of" },
      { key: "then", label: "Then use", type: "text" },
      { key: "else", label: "Otherwise use (empty keeps the value)", type: "text" },
    ],
  },
  { kind: "coalesce", group: "Logic", label: "First non-empty column", hint: "Uses the value, else the first of these columns with something in it", settings: [{ key: "columns", label: "Columns", type: "columns", required: true }] },
  { kind: "join", group: "Logic", label: "Join columns and text", settings: [{ key: "parts", label: "Pieces", type: "parts", required: true }, { key: "separator", label: "Put between them", type: "text" }] },
  { kind: "default", group: "Logic", label: "When empty, use", settings: [{ key: "text", label: "Value", type: "text", required: true }] },
];
export const STEP_BY_KIND = Object.fromEntries(STEP_KINDS.map((s) => [s.kind, s]));
export const STEP_OPTIONS = STEP_KINDS.map((s) => ({ value: s.kind, label: s.label, hint: s.group }));
export { DATE_FORMATS as STEP_DATE_FORMATS };

/** A new step of a kind, with its defaults. */
export const newStep = (kind) => {
  const def = STEP_BY_KIND[kind];
  const step = { kind };
  for (const s of def?.settings ?? []) if (s.default !== undefined) step[s.key] = s.default;
  if (kind === "join") step.parts = [{ current: true }];
  return step;
};

/** A one-line description of a step ("Replace "-" with "/"", "Convert in → mm"). */
export const describeStep = (step) => {
  const d = STEP_BY_KIND[step.kind];
  if (!d) return step.kind;
  switch (step.kind) {
    case "replace": return `Replace "${step.find ?? ""}" with "${step.with ?? ""}"`;
    case "remove": return `Remove ${JSON.stringify(step.characters ?? "")}`;
    case "left": case "right": return `${d.label}: ${step.count ?? "?"}`;
    case "split": return `Part ${step.part ?? "?"} after splitting at "${step.separator ?? ""}"`;
    case "prefix": return `Add "${step.text ?? ""}" before`;
    case "suffix": return `Add "${step.text ?? ""}" after`;
    case "round": return `Round to ${step.places ?? 0} places`;
    case "multiply": return `Multiply by ${step.by ?? "?"}`;
    case "divide": return `Divide by ${step.by ?? "?"}`;
    case "convert": return `Convert ${step.from ?? "?"} → ${step.to ?? "?"}`;
    case "date": return `Read a date (${step.format ?? "iso"})`;
    case "add_days": return `Add ${step.days ?? 0} days`;
    case "map": return `Translate ${Object.keys(step.values ?? {}).length} values`;
    case "if": return `If ${IF_TEST_OPTIONS.find((t) => t.value === step.test)?.label ?? step.test} ${step.test === "one_of" ? (step.list ?? []).join(", ") : step.value ?? ""} → ${step.then ?? ""}`.replace(/\s+/g, " ");
    case "coalesce": return `First of ${(step.columns ?? []).join(", ") || "…"}`;
    case "join": return `Join ${(step.parts ?? []).map((p) => (p.current ? "value" : p.column ? `[${p.column}]` : `"${p.text}"`)).join(" + ")}`;
    case "default": return `When empty, use "${step.text ?? ""}"`;
    default: return d.label;
  }
};

/** What is missing from a step's settings (the server checks again before saving). */
export const stepProblem = (step) => {
  const d = STEP_BY_KIND[step.kind];
  if (!d) return "Choose what the step does";
  for (const s of d.settings) {
    if (!s.required || (s.showWhen && !s.showWhen(step))) continue;
    const v = step[s.key];
    const missing = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0) || (s.type === "values" && Object.keys(v ?? {}).length === 0);
    if (missing) return `${d.label}: ${s.label.toLowerCase()} is needed`;
  }
  if (step.kind === "date" && step.format !== undefined && !["iso", "dmy", "mdy", "excel"].includes(step.format) && !/[yMd]/.test(step.format)) return "Write the date pattern with yyyy, MM and dd";
  if (step.kind === "divide" && Number(step.by) === 0) return "Cannot divide by 0";
  return null;
};

/** Steps as the API takes them: empty settings and unknown keys left out. */
export const cleanSteps = (steps) =>
  (steps ?? []).map((s) => {
    const d = STEP_BY_KIND[s.kind];
    const out = { kind: s.kind };
    for (const def of d?.settings ?? []) {
      if (def.showWhen && !def.showWhen(s)) continue;
      const v = s[def.key];
      if (v === undefined || v === null) continue;
      if (def.type === "text" && v === "" && !["with", "else", "then", "separator"].includes(def.key)) continue;
      if (def.type === "number") {
        if (v === "") continue;
        out[def.key] = Number(v);
      } else out[def.key] = v;
    }
    return out;
  });

/** Settings a template keeps for an import (NCs are always add only and never matched). */
export const templateSettings = (entityType, s) =>
  entityType === "nonconformance" ? { writeMode: "add_only", matchExisting: false } : { writeMode: s?.writeMode ?? "add_only", matchExisting: !!s?.matchExisting };

const norm = (v) =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined && y !== null && y !== "").sort(([a], [b]) => a.localeCompare(b))) : x));

/** Whether the mapping on screen differs from a template version (key column, fields, import settings). */
export const templateChanged = (version, { keyField, fields, settings }) => {
  if (!version) return true;
  const sort = (list) => [...list].sort((a, b) => a.target.localeCompare(b.target));
  return version.keyField !== keyField || norm(sort(version.fields)) !== norm(sort(fields)) || norm(version.settings) !== norm(settings);
};

/** The template a kind of record would start from: the one used most recently, else the only one. */
export const defaultTemplate = (templates) => {
  const live = (templates ?? []).filter((t) => !t.archived);
  const used = live.filter((t) => t.lastUsedAt).sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  return used[0] ?? (live.length === 1 ? live[0] : null);
};

const fieldSummary = (f) => {
  if (f.formula) return `formula ${f.formula}`;
  const base = f.transform === "constant" ? `always "${f.value}"` : f.transform === "concat" ? (f.sources ?? []).join(" + ") : f.source ?? "—";
  return [base, ...(f.steps ?? []).map(describeStep)].join(" → ");
};

/** What changed from one template version to the next, in words (fields by target; key column; import settings). */
export const versionChanges = (before, after, labelOf = (k) => k) => {
  if (!before) return ["First version"];
  const out = [];
  if (before.keyField !== after.keyField) out.push(`Key column: ${before.keyField} → ${after.keyField}`);
  const b = Object.fromEntries((before.fields ?? []).map((f) => [f.target, f]));
  const a = Object.fromEntries((after.fields ?? []).map((f) => [f.target, f]));
  for (const t of Object.keys(a)) {
    if (!b[t]) out.push(`${labelOf(t)} added: ${fieldSummary(a[t])}`);
    else if (norm(b[t]) !== norm(a[t])) out.push(`${labelOf(t)}: ${fieldSummary(b[t])} → ${fieldSummary(a[t])}`);
  }
  for (const t of Object.keys(b)) if (!a[t]) out.push(`${labelOf(t)} removed`);
  if (norm(before.settings) !== norm(after.settings)) out.push(`Import settings: ${before.settings?.writeMode ?? "—"} → ${after.settings?.writeMode ?? "—"}${after.settings?.matchExisting ? ", match existing" : ""}`);
  return out.length ? out : ["No change"];
};

/** Insert text into a formula at a position; returns the new formula and where the cursor goes. */
export const insertAt = (formula, at, text) => {
  const pos = Math.max(0, Math.min(at ?? formula.length, formula.length));
  return { formula: formula.slice(0, pos) + text + formula.slice(pos), cursor: pos + text.length };
};

/** The word being typed at the cursor (for suggestions): a function name or a column name after "[". */
export const tokenAt = (formula, at) => {
  const left = formula.slice(0, at ?? formula.length);
  const col = /\[([^\]]*)$/.exec(left);
  if (col) return { kind: "column", text: col[1], start: left.length - col[1].length - 1 };
  const fn = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(left);
  if (fn) return { kind: "function", text: fn[1], start: left.length - fn[1].length };
  return null;
};

/** Suggestions for the token at the cursor: columns (written [Name]) or functions (written NAME(). */
export const suggestionsFor = (token, columns, functions) => {
  if (!token) return [];
  const q = token.text.toLowerCase();
  if (token.kind === "column") return columns.filter((c) => c.toLowerCase().includes(q)).slice(0, 8).map((c) => ({ label: c, insert: `[${c.replace(/]/g, "]]")}]`, hint: "column" }));
  return functions.filter((f) => f.name.toLowerCase().startsWith(q)).slice(0, 8).map((f) => ({ label: f.usage, insert: `${f.name}(`, hint: f.description }));
};
