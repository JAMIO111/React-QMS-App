import { SAMPLING_TRIGGERS } from "./processControl";

export const STATUS = {
  in_progress: { label: "In progress", className: "bg-brand-primary/15 text-primary-text" },
  completed: { label: "Completed", className: "bg-border-color text-primary-text" },
  abandoned: { label: "Abandoned", className: "bg-border-color text-secondary-text line-through" },
};

export const TRIGGER_LABEL = Object.fromEntries(Object.entries(SAMPLING_TRIGGERS).map(([k, v]) => [k, v.label]));

/** Decimal input as typed: digits, optional sign and point. */
export const isDecimal = (text) => /^-?\d{1,12}(\.\d{1,12})?$/.test(String(text).trim());

/**
 * Live feedback while typing, using the same rule as the database (limits inclusive, value unrounded).
 * The database still decides the recorded result. Compares as decimal strings scaled to integers so
 * 25.05 against 25.05 is exact.
 */
export const previewResult = (requirement, text) => {
  if (!isDecimal(text)) return null;
  const v = String(text).trim();
  const cmp = (a, b) => {
    const [ai, af = ""] = String(a).replace("-", "").split(".");
    const [bi, bf = ""] = String(b).replace("-", "").split(".");
    const sa = String(a).startsWith("-") ? -1 : 1;
    const sb = String(b).startsWith("-") ? -1 : 1;
    const scale = Math.max(af.length, bf.length);
    const x = BigInt(sa) * BigInt(ai + af.padEnd(scale, "0"));
    const y = BigInt(sb) * BigInt(bi + bf.padEnd(scale, "0"));
    return x === y ? 0 : x < y ? -1 : 1;
  };
  if (requirement.lowerLimit !== null && cmp(v, requirement.lowerLimit) < 0) return "fail";
  if (requirement.upperLimit !== null && cmp(v, requirement.upperLimit) > 0) return "fail";
  return "pass";
};

/** Limits as shown next to the input: LSL / nominal / USL with the unit. */
export const describeLimits = (q) => {
  if (q.dataType === "attribute") return "Pass / fail";
  const parts = [q.lowerLimit !== null ? `LSL ${q.lowerLimit}` : null, q.nominal !== null ? `Nom ${q.nominal}` : null, q.upperLimit !== null ? `USL ${q.upperLimit}` : null];
  return `${parts.filter(Boolean).join(" · ")}${q.unitCode ? ` ${q.unitCode}` : ""}`;
};

/**
 * Which checks are due now, from each requirement's sampling rules and the samples taken so far:
 * first-off when nothing is measured yet; "every N minutes" when the last reading is older than N.
 * Part-count and event triggers (tool change, set-up, shift) cannot be known here and are listed as
 * "when it happens".
 */
export const dueChecks = (inspection, now = new Date()) => {
  const last = new Map();
  for (const m of inspection.measurements) {
    const t = new Date(m.measuredAt).getTime();
    if (!last.has(m.requirementId) || last.get(m.requirementId) < t) last.set(m.requirementId, t);
  }
  return inspection.requirements
    .filter((q) => q.applicable)
    .map((q) => {
      const measured = last.get(q.id);
      const reasons = [];
      for (const s of q.sampling) {
        if (s.triggerType === "first_off" && !measured) reasons.push({ kind: "due", text: `First-off × ${s.sampleSize}` });
        if (s.triggerType === "every_n_minutes") {
          const dueAt = measured ? measured + s.intervalValue * 60_000 : now.getTime();
          if (dueAt <= now.getTime()) reasons.push({ kind: measured ? "overdue" : "due", text: `Every ${s.intervalValue} min × ${s.sampleSize}` });
          else reasons.push({ kind: "later", text: `Next in ${Math.ceil((dueAt - now.getTime()) / 60_000)} min`, dueAt });
        }
      }
      if (!q.sampling.length && !measured) reasons.push({ kind: "due", text: "Not measured yet" });
      return { requirement: q, measured: !!measured, reasons };
    });
};
