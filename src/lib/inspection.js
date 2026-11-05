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

/** Readings of a requirement that count towards its sampling rules (not corrections, not retests). */
const countedReadings = (inspection, requirementId) => {
  const retestSamples = new Set(inspection.samples.filter((s) => s.isRetest).map((s) => s.id));
  const triggerBySample = new Map(inspection.samples.map((s) => [s.id, s.triggerType]));
  return inspection.measurements
    .filter((m) => m.requirementId === requirementId && !m.supersedesId && !retestSamples.has(m.sampleId))
    .map((m) => ({ triggerType: triggerBySample.get(m.sampleId), measuredAt: new Date(m.measuredAt).getTime() }));
};

const EVENT_TRIGGERS = ["start_of_shift", "after_setup", "after_tool_change", "manual"];
const PLANNED_TRIGGERS = ["first_off", "last_off", "every_n_parts"];

/** Event triggers (shift start, set-up, tool change, manual) the plan has rules for: samples outside the planned sequence. */
export const eventTriggers = (inspection) => [
  ...new Set(inspection.requirements.filter((q) => q.applicable).flatMap((q) => q.sampling.map((s) => s.triggerType)).filter((t) => EVENT_TRIGGERS.includes(t))),
];

/**
 * What the next sample must contain (the API enforces the same): the next planned sample of
 * `inspection.schedule` plus timed checks (every N minutes) that are due again, or a timed extra once the
 * planned samples are all recorded. Null when nothing is left to sample.
 */
export const nextSample = (inspection, now = new Date()) => {
  const plannedTaken = inspection.samples.filter((s) => !s.isRetest && PLANNED_TRIGGERS.includes(s.triggerType)).length;
  const last = new Map();
  for (const q of inspection.requirements) for (const r of countedReadings(inspection, q.id)) last.set(q.id, Math.max(last.get(q.id) ?? 0, r.measuredAt));
  const timed = inspection.requirements
    .filter((q) => q.applicable)
    .filter((q) => {
      const rule = q.sampling.find((s) => s.triggerType === "every_n_minutes");
      return rule && last.has(q.id) && last.get(q.id) + (rule.intervalValue ?? 0) * 60_000 <= now.getTime();
    })
    .map((q) => q.id);
  const planned = inspection.schedule[plannedTaken];
  const base = { plannedTaken, timed };
  if (planned) return { ...base, kind: "planned", number: planned.number, position: planned.position, trigger: planned.trigger, requirementIds: [...new Set([...planned.requirementIds, ...timed])] };
  if (timed.length) return { ...base, kind: "timed", number: null, position: null, trigger: "every_n_minutes", requirementIds: timed };
  return null;
};

/** The trigger recorded on the inspection itself when it starts: the plan's first-off, else its first rule. */
export const startTrigger = (requirements) => {
  const planned = requirements.filter((q) => q.applicable !== false).flatMap((q) => (q.sampling ?? []).map((s) => s.triggerType));
  return planned.includes("first_off") ? "first_off" : (planned[0] ?? "manual");
};

/** Whether any check is sampled by part count, so the lot size is needed. */
export const needsLotSize = (requirements) => requirements.some((q) => q.applicable !== false && (q.sampling ?? []).some((s) => s.triggerType === "every_n_parts"));
