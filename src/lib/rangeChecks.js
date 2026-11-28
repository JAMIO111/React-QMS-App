/**
 * Gauge type checks whose point or tolerance depends on the gauge's own range (see docs/gauge-range-checks-plan.md).
 *
 * The database works the numbers out (`app.resolve_type_check`); this file only holds the words, the choices a person makes, the shape rules
 * the API and the database also enforce (so the form can say what is wrong before saving) and the body to send. Nothing here does the arithmetic
 * of a point or a tolerance: the screen asks the server's preview.
 */
import { formatNumber } from "./calibration";

/** Where on the gauge a check is made. */
export const POINT_BASES = [
  { id: "value", name: "A fixed value", hint: "The same point on every gauge of this type, for example 25 mm" },
  { id: "span_percent", name: "A % of the gauge's range", hint: "Each gauge works its own point out from its range: 0 % is the range minimum, 100 % the maximum" },
];

/** How the allowed error is given. */
export const TOLERANCE_BASES = [
  { id: "value", name: "A fixed value", hint: "The same allowed error anywhere in the range, for example ±0.004 mm (the two sides may differ)" },
  { id: "span_percent", name: "A % of the span (full scale)", hint: "For example class 1.0 = ±1 % of the range; the span is the range maximum minus the minimum" },
  { id: "reading_percent", name: "A % of the reading", hint: "The allowed error grows with the value being checked, for example ±1 % of the reading" },
  { id: "value_plus_reading_percent", name: "A fixed value plus a % of the reading", hint: "For example ±(0.003 mm + 0.01 % of the reading), how many micrometer and caliper standards are written" },
];

export const EMPTY_CHECK = {
  kind: "variable",
  name: "",
  nominalBasis: "value",
  nominal: "",
  unitCode: "mm",
  toleranceBasis: "value",
  toleranceMinus: "",
  tolerancePlus: "",
  toleranceReadingPercent: "",
  toleranceSource: "",
  method: "",
};

const str = (v) => (v === null || v === undefined ? "" : String(v));
const isNumber = (v) => v !== "" && v !== null && v !== undefined && !Number.isNaN(Number(v));
const decimals = (n, places) => Math.abs(n * 10 ** places - Math.round(n * 10 ** places)) < 1e-7;

/** A type's check as the form holds it (every box a string). */
export const checkToForm = (c) => ({
  kind: c.kind ?? "variable",
  name: c.name,
  nominalBasis: c.nominalBasis ?? "value",
  nominal: str(c.nominal),
  unitCode: c.unitCode ?? "mm",
  toleranceBasis: c.toleranceBasis ?? "value",
  // A percentage tolerance has one box: both sides are the same.
  toleranceMinus: str(c.toleranceMinus),
  tolerancePlus: str(c.tolerancePlus),
  toleranceReadingPercent: str(c.toleranceReadingPercent),
  toleranceSource: c.toleranceSource ?? "",
  method: c.method ?? "",
});

const symmetric = (basis) => basis !== "value";

/** What is wrong with the form, in words the person can act on (null when it can be saved). */
export const checkProblem = (f) => {
  if (!f.name.trim()) return "Give the check a name";
  if (f.kind === "attribute") return null;
  if (f.nominalBasis === "span_percent") {
    if (!isNumber(f.nominal)) return "Give the point as a percentage of the range";
    const n = Number(f.nominal);
    if (n < 0 || n > 100) return "The point is a percentage of the range: between 0 and 100";
    if (!decimals(n, 3)) return "The point may have at most three decimals";
  } else {
    if (!isNumber(f.nominal)) return "Give the nominal value";
    if (!f.unitCode) return "Choose the unit";
  }
  if (f.toleranceBasis === "value") {
    if (!isNumber(f.toleranceMinus) || !isNumber(f.tolerancePlus)) return "Give the tolerance on both sides";
    if (Number(f.toleranceMinus) < 0 || Number(f.tolerancePlus) < 0) return "A tolerance cannot be negative";
    return null;
  }
  if (!isNumber(f.toleranceMinus)) return f.toleranceBasis === "value_plus_reading_percent" ? "Give the fixed part of the tolerance" : "Give the percentage";
  const side = Number(f.toleranceMinus);
  if (side < 0) return "A tolerance cannot be negative";
  if (f.toleranceBasis === "value_plus_reading_percent") {
    if (!isNumber(f.toleranceReadingPercent) || Number(f.toleranceReadingPercent) <= 0) return "Give the percentage of the reading";
    if (Number(f.toleranceReadingPercent) > 100) return "The percentage of the reading is at most 100";
  } else if (side <= 0 || side > 100) {
    return "A tolerance given as a percentage is more than 0 and at most 100";
  }
  return null;
};

/** The request body for a check. A percentage tolerance sends the same number on both sides, as the database holds it. */
export const checkBody = (f) => {
  if (f.kind === "attribute") return { kind: "attribute", name: f.name.trim(), method: f.method.trim() || null, toleranceSource: f.toleranceSource.trim() || null };
  const side = symmetric(f.toleranceBasis) ? Number(f.toleranceMinus) : null;
  return {
    kind: "variable",
    name: f.name.trim(),
    nominalBasis: f.nominalBasis,
    nominal: Number(f.nominal),
    unitCode: f.nominalBasis === "span_percent" ? null : f.unitCode,
    toleranceBasis: f.toleranceBasis,
    toleranceMinus: side ?? Number(f.toleranceMinus),
    tolerancePlus: side ?? Number(f.tolerancePlus),
    toleranceReadingPercent: f.toleranceBasis === "value_plus_reading_percent" ? Number(f.toleranceReadingPercent) : null,
    toleranceSource: f.toleranceSource.trim() || null,
    method: f.method.trim() || null,
  };
};

/** True when the check's point or tolerance is a percentage of something (its limits depend on the gauge). */
export const isPercentCheck = (c) => c.kind !== "attribute" && ((c.nominalBasis ?? "value") !== "value" || (c.toleranceBasis ?? "value") !== "value");
/** True when a gauge needs a range for it: the point or the tolerance is a % of the span. */
export const needsRange = (c) => c.kind !== "attribute" && (c.nominalBasis === "span_percent" || c.toleranceBasis === "span_percent");

/** "50 % of range" or "25 mm". */
export const pointWords = (c) => (c.nominalBasis === "span_percent" ? `${formatNumber(c.nominal)} % of range` : `${formatNumber(c.nominal)} ${c.unitCode ?? ""}`.trim());

/**
 * The tolerance in words. `unit` is the unit a fixed part is in: the check's own, or the gauge's for a point given as a percentage
 * (pass the gauge's unit; left out, the number stands alone and means the gauge's unit).
 */
export const toleranceWords = (c, unit) => {
  const u = c.unitCode ?? unit ?? "";
  const fixed = (n) => `${formatNumber(n)}${u ? ` ${u}` : ""}`;
  switch (c.toleranceBasis ?? "value") {
    case "span_percent":
      return `±${formatNumber(c.tolerancePlus)} % of span`;
    case "reading_percent":
      return `±${formatNumber(c.tolerancePlus)} % of reading`;
    case "value_plus_reading_percent":
      return `±(${fixed(c.tolerancePlus)} + ${formatNumber(c.toleranceReadingPercent)} % of reading)`;
    default:
      return Number(c.toleranceMinus) === Number(c.tolerancePlus) ? `±${fixed(c.tolerancePlus)}` : `+${fixed(c.tolerancePlus)}/−${fixed(c.toleranceMinus)}`;
  }
};

/** One line for a type's check: "50 % of range, ±(0.003 mm + 0.01 % of reading)". */
export const checkWords = (c) => (c.kind === "attribute" ? "Pass / fail" : `${pointWords(c)}, ${toleranceWords(c)}`);

/** An example sentence for the tolerance choice the form has now: in the person's own numbers, no arithmetic. */
export const toleranceExample = (f) => {
  // A point given as a percentage has no unit of its own: the fixed part is in the gauge's unit (the field says so).
  const fixed = isNumber(f.toleranceMinus) ? `${formatNumber(f.toleranceMinus)}${f.nominalBasis === "span_percent" ? "" : ` ${f.unitCode}`}` : "…";
  const pct = isNumber(f.toleranceMinus) ? formatNumber(f.toleranceMinus) : "…";
  switch (f.toleranceBasis) {
    case "span_percent":
      return `±${pct} % of the span: on a 0 to 100 gauge the allowed error is ±${isNumber(f.toleranceMinus) ? formatNumber(f.toleranceMinus) : "…"} at every point.`;
    case "reading_percent":
      return `±${pct} % of the reading: the higher the reading, the more error is allowed.`;
    case "value_plus_reading_percent":
      return `±(${fixed} + ${isNumber(f.toleranceReadingPercent) ? formatNumber(f.toleranceReadingPercent) : "…"} % of the reading): a fixed part, plus an amount that grows with the reading.`;
    default:
      return "The same allowed error anywhere; the plus and minus sides may differ.";
  }
};

/** Evenly spaced percentages from `from` to `to` (inclusive), rounded to three decimals. `count` is at least 2. */
export const evenPoints = (count, from, to) => {
  const n = Math.max(2, Math.min(21, Math.round(Number(count))));
  const a = Number(from);
  const b = Number(to);
  return Array.from({ length: n }, (_, i) => Math.round((a + ((b - a) * i) / (n - 1)) * 1000) / 1000);
};
/** "25 % of range" for a point made by the evenly spaced helper. */
export const evenName = (p) => `${formatNumber(p)} % of range`;
