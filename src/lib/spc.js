/** SPC display helpers (PC6). The statistics are calculated by the API; nothing is recalculated here. */

export const RULE_LABEL = {
  we1: { short: "Rule 1", name: "One point beyond 3σ" },
  we2: { short: "Rule 2", name: "Two of three beyond 2σ, same side" },
  we3: { short: "Rule 3", name: "Four of five beyond 1σ, same side" },
  we4: { short: "Rule 4", name: "Eight in a row on one side of the centre line" },
};
export const RULES = ["we1", "we2", "we3", "we4"];

export const CHART_NAME = { imr: "I-MR (individuals and moving range)", xbar_r: "X-bar/R (subgroup mean and range)" };
export const DISPERSION_NAME = { imr: "Moving range", xbar_r: "Range" };
export const LOCATION_NAME = { imr: "Individual value", xbar_r: "Subgroup mean" };

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

export const describeWindow = (b) => `${b.points} ${b.chartType === "imr" ? "readings" : "subgroups"}`;
