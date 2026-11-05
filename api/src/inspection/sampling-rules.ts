export type SamplingRule = { triggerType: string; intervalValue: number | null; sampleSize: number };
export type RequirementHistory = {
  /** Non-retest, non-corrected readings of the requirement. */
  readings: { triggerType: string; measuredAt: Date }[];
};

/**
 * Checks one non-retest reading against the requirement's control plan sampling rules.
 * Returns a message when it is not allowed, otherwise null. Requirements without rules are not restricted.
 * - the trigger must be one of the plan's rules;
 * - first off: only before the first reading;
 * - every N minutes: only once N minutes have passed since the last reading;
 * - every N parts: at most ceil(lot size / N) readings, which needs the lot size;
 * - event triggers (shift start, set-up, tool change, last off, manual) are allowed when the plan has them.
 */
export function samplingViolation(
  name: string,
  rules: SamplingRule[],
  trigger: string,
  history: RequirementHistory,
  lotSize: number | null,
  now: Date,
): string | null {
  if (!rules.length) return null;
  const rule = rules.find((r) => r.triggerType === trigger);
  if (!rule) return `${name}: the control plan does not sample this characteristic on "${trigger.replace(/_/g, ' ')}"`;
  if (trigger === 'first_off' && history.readings.length > 0) return `${name}: first-off has already been measured`;
  if (trigger === 'every_n_minutes' && rule.intervalValue && history.readings.length) {
    const last = Math.max(...history.readings.map((r) => r.measuredAt.getTime()));
    const dueAt = last + rule.intervalValue * 60_000;
    if (now.getTime() < dueAt) {
      const minutes = Math.ceil((dueAt - now.getTime()) / 60_000);
      return `${name}: not due yet — the plan asks for a check every ${rule.intervalValue} min, next in ${minutes} min`;
    }
  }
  if (trigger === 'every_n_parts' && rule.intervalValue) {
    if (!lotSize) return `${name}: set the lot size on the inspection to take every-${rule.intervalValue}-parts samples`;
    const allowed = Math.ceil(lotSize / rule.intervalValue);
    const taken = history.readings.filter((r) => r.triggerType === 'every_n_parts').length;
    if (taken >= allowed) return `${name}: all ${allowed} every-${rule.intervalValue}-parts samples for a lot of ${lotSize} have been taken`;
  }
  return null;
}
