/**
 * Record filters for imports (docs/import-filters-plan.md): which source records an import reads at all. The rules themselves are worked out by the
 * server (the same code filters a preview and a real import), so this file only holds the words, the shape of a rule on screen and the tidying that
 * keeps a half-typed rule out of what is saved.
 */

export const FILTER_MODES = [
  { value: "keep", label: "Read only the records that match", hint: "Everything else in the source is left alone" },
  { value: "leave_out", label: "Read every record except those that match", hint: "The matching records are skipped" },
];

export const FILTER_MATCH = [
  { value: "all", label: "All of these" },
  { value: "any", label: "Any of these" },
];

/** Tests, with whether they take one value, a list, two values or nothing, and whether they compare in order (and so need a way to read the value). */
export const FILTER_TESTS = [
  { value: "equals", label: "is", needs: "one" },
  { value: "not_equals", label: "is not", needs: "one" },
  { value: "contains", label: "contains", needs: "one" },
  { value: "not_contains", label: "does not contain", needs: "one" },
  { value: "starts_with", label: "starts with", needs: "one" },
  { value: "ends_with", label: "ends with", needs: "one" },
  { value: "in", label: "is one of", needs: "list" },
  { value: "not_in", label: "is not one of", needs: "list" },
  { value: "is_empty", label: "is empty", needs: "none" },
  { value: "not_empty", label: "is not empty", needs: "none" },
  { value: "gt", label: "is more than", needs: "one", ordered: true },
  { value: "gte", label: "is at least", needs: "one", ordered: true },
  { value: "lt", label: "is less than", needs: "one", ordered: true },
  { value: "lte", label: "is at most", needs: "one", ordered: true },
  { value: "between", label: "is between", needs: "two", ordered: true },
];

export const FILTER_READ_AS = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
];

export const DECIMAL_MARKS = [
  { value: ".", label: "Point (1,234.50)" },
  { value: ",", label: "Comma (1.234,50)" },
];

export const FILTER_DATE_FORMATS = [
  { value: "iso", label: "2026-11-23" },
  { value: "dmy", label: "23/11/2026" },
  { value: "mdy", label: "11/23/2026" },
  { value: "excel", label: "Excel serial number" },
];

export const MAX_FILTER_RULES = 20;

export const testInfo = (test) => FILTER_TESTS.find((t) => t.value === test) ?? FILTER_TESTS[0];

export const newRule = (column = "") => ({ column, test: "equals", value: "" });
export const newFilter = () => ({ mode: "keep", match: "all", rules: [newRule()] });

/** Whether a rule says enough to be used (a column, and a value where its test needs one). */
export const ruleComplete = (rule) => {
  if (!rule?.column) return false;
  const needs = testInfo(rule.test).needs;
  if (needs === "none") return true;
  if (needs === "list") return (rule.values ?? []).some((v) => String(v).trim() !== "");
  if (needs === "two") return String(rule.value ?? "").trim() !== "" && String(rule.valueTo ?? "").trim() !== "";
  return String(rule.value ?? "").trim() !== "";
};

const tidyRule = (rule) => {
  const needs = testInfo(rule.test).needs;
  const out = { column: rule.column, test: rule.test };
  if (needs === "one" || needs === "two") out.value = String(rule.value ?? "").trim();
  if (needs === "two") out.valueTo = String(rule.valueTo ?? "").trim();
  if (needs === "list") out.values = (rule.values ?? []).map((v) => String(v).trim()).filter(Boolean);
  if (testInfo(rule.test).ordered && rule.as && rule.as !== "text") {
    out.as = rule.as;
    if (rule.as === "number" && rule.decimal) out.decimal = rule.decimal;
    if (rule.as === "date" && rule.dateFormat) out.dateFormat = rule.dateFormat;
  }
  return out;
};

/**
 * What is saved and sent: only the rules that are complete (or the formula), nothing for tests that take no value, and nothing at all (undefined)
 * when the filter does nothing, so a half-typed rule never makes a template look changed.
 */
export const cleanFilter = (filter) => {
  if (!filter) return undefined;
  const formula = String(filter.formula ?? "").trim();
  const base = { mode: filter.mode === "leave_out" ? "leave_out" : "keep", match: filter.match === "any" ? "any" : "all" };
  if (formula) return { ...base, rules: [], formula };
  const rules = (filter.rules ?? []).filter(ruleComplete).map(tidyRule);
  return rules.length ? { ...base, rules } : undefined;
};

export const filterIsActive = (filter) => !!cleanFilter(filter);

/** A rule in words, as the server writes it ("Status is "Cancelled""). */
export const ruleWords = (rule) => {
  const t = testInfo(rule.test);
  const q = (s) => `"${s}"`;
  if (t.needs === "none") return `${rule.column} ${t.label}`;
  if (t.needs === "list") return `${rule.column} ${t.label} ${(rule.values ?? []).map(q).join(", ")}`;
  if (t.needs === "two") return `${rule.column} ${t.label} ${rule.value} and ${rule.valueTo}`;
  return `${rule.column} ${t.label} ${t.ordered ? rule.value : q(rule.value ?? "")}`;
};

/** The filter in a sentence ("Read only the records where Status is "Active" and Type is one of …"). */
export const filterWords = (filter) => {
  const f = cleanFilter(filter);
  if (!f) return "Every record is read.";
  const lead = f.mode === "keep" ? "Read only the records where" : "Skip the records where";
  if (f.formula) return `${lead} the formula ${f.formula} is true.`;
  return `${lead} ${f.rules.map(ruleWords).join(f.match === "all" ? " and " : " or ")}.`;
};

/** The columns a filter reads, rules first, so a sample can show them before the rest. */
export const filterColumns = (filter) => [...new Set((filter?.rules ?? []).map((r) => r.column).filter(Boolean))];

/** The same filter, with a rule replaced, added or removed (kept free of the on-screen draft's empty rules by cleanFilter when saved). */
export const withRule = (filter, i, change) => ({ ...filter, rules: filter.rules.map((r, j) => (j === i ? { ...r, ...change } : r)) });
