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

/** Readings of a requirement that count towards its sampling rules (not corrections, not retests). */
const countedReadings = (inspection, requirementId) => {
  const retestSamples = new Set(inspection.samples.filter((s) => s.isRetest).map((s) => s.id));
  const triggerBySample = new Map(inspection.samples.map((s) => [s.id, s.triggerType]));
  return inspection.measurements
    .filter((m) => m.requirementId === requirementId && !m.supersedesId && !retestSamples.has(m.sampleId))
    .map((m) => ({ triggerType: triggerBySample.get(m.sampleId), measuredAt: new Date(m.measuredAt).getTime() }));
};

/**
 * Why a check cannot be sampled on this trigger now (null when it can). Same rules as the API, which
 * enforces them: the trigger must be in the plan; first-off once; every N minutes only once N minutes
 * have passed since the last reading; every N parts at most ceil(lot size / N) times; events as planned.
 * Checks without sampling rules are not restricted.
 */
export const samplingBlock = (inspection, q, trigger, now = new Date()) => {
  if (!q.sampling.length) return null;
  const rule = q.sampling.find((s) => s.triggerType === trigger);
  if (!rule) return `Not sampled on ${TRIGGER_LABEL[trigger]?.toLowerCase() ?? trigger} in the control plan`;
  const readings = countedReadings(inspection, q.id);
  if (trigger === "first_off" && readings.length) return "First-off already measured";
  if (trigger === "every_n_minutes" && rule.intervalValue && readings.length) {
    const dueAt = Math.max(...readings.map((r) => r.measuredAt)) + rule.intervalValue * 60_000;
    if (dueAt > now.getTime()) return `Not due yet — next in ${Math.ceil((dueAt - now.getTime()) / 60_000)} min`;
  }
  if (trigger === "every_n_parts" && rule.intervalValue) {
    if (!inspection.lotSize) return "Set the lot size to sample by part count";
    const allowed = Math.ceil(inspection.lotSize / rule.intervalValue);
    const taken = readings.filter((r) => r.triggerType === "every_n_parts").length;
    if (taken >= allowed) return `All ${allowed} samples for a lot of ${inspection.lotSize} taken`;
  }
  return null;
};

/** The triggers the plan defines for this inspection, each with whether any check can use it now. */
export const triggerChoices = (inspection, now = new Date()) => {
  const applicable = inspection.requirements.filter((q) => q.applicable);
  const planned = [...new Set(applicable.flatMap((q) => q.sampling.map((s) => s.triggerType)))];
  const triggers = planned.length ? planned : ["manual"];
  return triggers.map((trigger) => {
    const blocks = applicable.map((q) => samplingBlock(inspection, q, trigger, now));
    const open = blocks.some((b) => b === null);
    return { trigger, label: TRIGGER_LABEL[trigger] ?? trigger, available: open, reason: open ? null : blocks.find(Boolean) };
  });
};

/** The trigger recorded on the inspection itself when it starts: the plan's first-off, else its first rule. */
export const startTrigger = (requirements) => {
  const planned = requirements.filter((q) => q.applicable !== false).flatMap((q) => (q.sampling ?? []).map((s) => s.triggerType));
  return planned.includes("first_off") ? "first_off" : (planned[0] ?? "manual");
};

/** Whether any check is sampled by part count, so the lot size is needed. */
export const needsLotSize = (requirements) => requirements.some((q) => q.applicable !== false && (q.sampling ?? []).some((s) => s.triggerType === "every_n_parts"));
