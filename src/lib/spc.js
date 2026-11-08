/** SPC display helpers (PC6). The statistics are calculated by the API; nothing is recalculated here. */

export const RULE_LABEL = {
  we1: { short: "Rule 1", name: "One point beyond 3σ" },
  we2: { short: "Rule 2", name: "Two of three beyond 2σ, same side" },
  we3: { short: "Rule 3", name: "Four of five beyond 1σ, same side" },
  we4: { short: "Rule 4", name: "Eight in a row on one side of the centre line" },
};
export const RULES = ["we1", "we2", "we3", "we4"];

export const CHART_NAME = {
  imr: "I-MR (individuals and moving range)",
  xbar_r: "X-bar/R (subgroup mean and range)",
  p: "P chart (proportion failed)",
  np: "NP chart (number failed, subgroups of one size)",
  c: "C chart (defects per subgroup)",
  u: "U chart (defects per unit)",
};
export const DISPERSION_NAME = { imr: "Moving range", xbar_r: "Range" };
export const LOCATION_NAME = { imr: "Individual value", xbar_r: "Subgroup mean", p: "Proportion failed", np: "Number failed", c: "Defects", u: "Defects per unit" };
/** Charts of counts of failed checks or defects (no dispersion chart, no specification): np, c and u. */
export const COUNT_VARIANTS = ["np", "c", "u"];
export const formatCount = (v, digits = 2) => (v === null || v === undefined || Number.isNaN(v) ? "—" : String(Math.round(v * 10 ** digits) / 10 ** digits));
export const SUBGROUP_BASIS = [
  { value: "inspection", label: "One inspection" },
  { value: "day", label: "One day" },
  { value: "lot", label: "One lot" },
  { value: "order", label: "One production order" },
];
export const BASIS_LABEL = { inspection: "one inspection", day: "one day", lot: "one lot", order: "one production order" };
export const formatPercent = (v, digits = 1) => (v === null || v === undefined || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(digits)}%`);

/** Decimal places to show: those of the recorded readings plus one (means and limits need a little more), at most 5. */
export const decimalsOf = (points) => {
  let most = 0;
  for (const p of points) for (const r of p.readings) most = Math.max(most, (r.value.split(".")[1] ?? "").length);
  return Math.min(5, most + 1);
};

export const formatValue = (v, decimals) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(decimals));

/** Rows for the charts: one per point, flagged with the rules it breaks. */
export const chartRows = (chart) => {
  const bySignal = new Map();
  for (const s of chart.signals) bySignal.set(s.index, [...(bySignal.get(s.index) ?? []), s.rule]);
  const range = new Set(chart.dispersionSignals);
  return chart.points.map((p) => ({
    n: p.index + 1,
    at: p.at,
    value: p.value,
    dispersion: p.dispersion,
    rules: bySignal.get(p.index) ?? [],
    rangeSignal: range.has(p.index),
    // P charts: checks, failures and this subgroup's own limits (null while there are too few subgroups for limits).
    checked: p.n ?? null,
    failed: p.failed ?? null,
    ucl: p.ucl ?? null,
    lcl: p.lcl ?? null,
    point: p,
  }));
};

/** Y-axis range that holds the data, the control limits and (when shown) the specification, with a little room. */
export const yDomain = (values, extras) => {
  const all = [...values, ...extras].filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!all.length) return ["auto", "auto"];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.08;
  return [lo - pad, hi + pad];
};

/** Y-axis range of a P chart: from zero up to the highest proportion or limit, at most 100 %. */
export const proportionDomain = (rows) => {
  const top = Math.max(0.02, ...rows.flatMap((r) => [r.value, r.ucl ?? 0]));
  return [0, Math.min(1, top * 1.1)];
};

/** Y-axis range of an NP, C or U chart: from zero up to the highest count (or rate) or limit. */
export const countDomain = (rows) => {
  const top = Math.max(1, ...rows.flatMap((r) => [r.value, r.ucl ?? 0]));
  return [0, top * 1.1];
};

export const describeWindow = (b) => `${b.points} ${b.chartType === "imr" ? "readings" : "subgroups"}`;

export const VERDICT_TEXT = { higher: "Higher than the others", lower: "Lower than the others", similar: "Similar to the others" };
export const KIND_NAME = { variable: "Measured", attribute: "Pass / fail", count: "Defect count" };
