/** Words and rules for CMM and measurement file imports (docs/cmm-ingestion-plan.md). */

export const IMPORT_STATUS = {
  previewed: { label: "Preview", tone: "warning" },
  applying: { label: "Being recorded", tone: "warning" },
  applied: { label: "Recorded", tone: "success" },
  discarded: { label: "Discarded", tone: "neutral" },
};

export const MATCH_KIND = {
  balloon: "By balloon number",
  map: "Saved match",
  manual: "Matched by hand",
  none: "Not matched",
};

export const APPLY_MODES = [
  { value: "new", label: "New readings" },
  { value: "retest", label: "Retest" },
  { value: "correct", label: "Correction" },
];

export const APPLY_MODE_HINT = {
  new: "Each part in the file becomes a sample, taken as the sampling plan asks.",
  retest: "Each reading re-measures the latest failed reading of its check.",
  correct: "Replaces the readings of the part already measured (found by its serial or reference); the originals are kept.",
};

/** What still stands in the way of applying a preview, in words (the server checks the same things). */
export const importBlockers = (detail) => {
  if (!detail) return [];
  const out = [];
  if (detail.status !== "previewed") return out;
  if (detail.expired) out.push("This preview is over a day old; upload the file again.");
  if (detail.inspection?.status !== "in_progress") out.push("The inspection is no longer in progress.");
  if (detail.counts.toRecord === 0) out.push("No feature is matched to a check of this inspection.");
  if (detail.counts.mismatches > 0 && !detail.mismatchesConfirmedAt) out.push("Some features differ from the control plan: confirm you have checked them.");
  return out;
};

/** "25.05" / "≤ 0.02" / "24.95 – 25.05" for a check or a file's own limits. */
export const limitsWords = (lower, upper, unit) => {
  const u = unit ? ` ${unit}` : "";
  if (lower == null && upper == null) return "—";
  if (lower == null) return `≤ ${upper}${u}`;
  if (upper == null) return `≥ ${lower}${u}`;
  return `${lower} – ${upper}${u}`;
};

/** The value of a row as the check takes it, in words. */
export const rowValueWords = (row, check) => {
  if (row.valuePass != null) return row.valuePass ? "Pass" : "Fail";
  if (row.valueCount != null) return String(row.valueCount);
  if (row.valueNumeric != null) return `${row.valueNumeric}${check?.unit ? ` ${check.unit}` : ""}`;
  return row.valueText ?? "—";
};

/** Whether the value shown was converted from the file's own unit. */
export const converted = (row, check) => !!(row.unitRead && check?.unit && row.unitRead !== check.unit && row.readValue != null);

export const checkLabel = (c) => [c.charNumber ? `${c.charNumber}.` : null, c.name].filter(Boolean).join(" ");

// ---- profile settings ----

export const COLUMN_FIELDS = [
  { key: "feature", label: "Feature name or id", required: true },
  { key: "actual", label: "Measured value" },
  { key: "passFail", label: "Pass / fail" },
  { key: "nominal", label: "Nominal" },
  { key: "upperTolerance", label: "Upper tolerance" },
  { key: "lowerTolerance", label: "Lower tolerance" },
  { key: "upperLimit", label: "Upper limit" },
  { key: "lowerLimit", label: "Lower limit" },
  { key: "unit", label: "Unit" },
  { key: "balloon", label: "Balloon number" },
  { key: "axis", label: "Axis (added to the feature name)" },
  { key: "unitSplit", label: "Part / serial (splits the file into parts)" },
];

export const HEADER_LABELS = [
  { key: "partNumber", label: "Part number" },
  { key: "serial", label: "Serial" },
  { key: "workOrder", label: "Work order" },
  { key: "lot", label: "Lot" },
  { key: "program", label: "Program" },
  { key: "operator", label: "Operator" },
];

export const DELIMITERS = [
  { value: "auto", label: "Work it out from the file" },
  { value: ",", label: "Comma" },
  { value: ";", label: "Semicolon" },
  { value: "tab", label: "Tab" },
  { value: "|", label: "Bar |" },
];

export const ENCODINGS = [
  { value: "auto", label: "Work it out from the file" },
  { value: "utf-8", label: "UTF-8" },
  { value: "windows-1252", label: "Windows (Western)" },
  { value: "utf-16le", label: "UTF-16 LE" },
  { value: "utf-16be", label: "UTF-16 BE" },
];

const DEFAULT_PASS = ["OK", "PASS", "IN", "GOOD", "Y", "YES", "TRUE"];
const DEFAULT_FAIL = ["NOK", "NG", "FAIL", "OUT", "BAD", "N", "NO", "FALSE"];

/** Settings as the editor holds them (strings for every input). */
export const settingsToForm = (s = {}) => ({
  delimiter: s.delimiter ?? "auto",
  encoding: s.encoding ?? "auto",
  headingRow: s.headingRow == null || s.headingRow === "auto" ? "" : String(s.headingRow),
  columns: Object.fromEntries(COLUMN_FIELDS.map((f) => [f.key, s.columns?.[f.key] ?? ""])),
  lowerTolerance: s.lowerTolerance ?? "as_written",
  balloonFrom: s.balloonFrom ?? "feature",
  unit: s.unit ?? "",
  decimal: s.decimal ?? ".",
  passValues: (s.passValues ?? DEFAULT_PASS).join(", "),
  failValues: (s.failValues ?? DEFAULT_FAIL).join(", "),
  header: Object.fromEntries(HEADER_LABELS.map((f) => [f.key, s.header?.[f.key] ?? ""])),
});

const words = (text) => text.split(",").map((w) => w.trim()).filter(Boolean);

/** The editor's state as the API's settings (empty inputs left out). */
export const formToSettings = (f) => ({
  delimiter: f.delimiter,
  encoding: f.encoding,
  headingRow: f.headingRow.trim() ? Number(f.headingRow) : "auto",
  columns: Object.fromEntries(Object.entries(f.columns).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()])),
  lowerTolerance: f.lowerTolerance,
  balloonFrom: f.balloonFrom,
  unit: f.unit.trim() || null,
  decimal: f.decimal,
  passValues: words(f.passValues),
  failValues: words(f.failValues),
  header: Object.fromEntries(Object.entries(f.header).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()])),
});

/** What the profile editor still needs, in words (the server checks the same with its schema). */
export const settingsProblems = (f) => {
  const out = [];
  const c = f.columns;
  if (!c.feature.trim()) out.push("Name the column holding the feature name or id");
  if (!c.actual.trim() && !c.passFail.trim()) out.push("Name the column of the measured value or of pass / fail");
  if ((c.upperTolerance.trim() || c.lowerTolerance.trim()) && !c.nominal.trim()) out.push("Tolerances need the nominal column");
  if (f.balloonFrom === "column" && !c.balloon.trim()) out.push("Name the balloon column");
  if (f.headingRow.trim() && !(Number.isInteger(Number(f.headingRow)) && Number(f.headingRow) >= 1 && Number(f.headingRow) <= 500)) {
    out.push("The heading line is a whole number from 1 to 500, or empty to find it");
  }
  return out;
};

/** A file as base64 (for "Try a file"; at most 2 MB). */
export const fileToBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",").pop());
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read"));
    reader.readAsDataURL(file);
  });

// ---- the profile and gauge last used on this browser, per machine ----

const memoryKey = (machineId) => `fortress.cmm-import.${machineId ?? "any"}`;

export const rememberChoice = (machineId, choice) => {
  try {
    localStorage.setItem(memoryKey(machineId), JSON.stringify(choice));
  } catch {
    /* storage may be unavailable */
  }
};

export const recallChoice = (machineId) => {
  try {
    return JSON.parse(localStorage.getItem(memoryKey(machineId)) ?? "null") ?? {};
  } catch {
    return {};
  }
};

export const importPath = (inspectionId, importId, back) => `/Inspections/${inspectionId}/imports/${importId}${back ? `?back=${encodeURIComponent(back)}` : ""}`;
