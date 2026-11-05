export type SamplingRule = { triggerType: string; intervalValue: number | null; sampleSize: number };
export type PlanRequirement = { id: string; name: string; charNumber: string | null; applicable: boolean; sampling: SamplingRule[] };
export type ScheduledSample = { number: number; position: number; trigger: string; requirementIds: string[] };
export type NextSample = { kind: 'planned' | 'timed'; number: number | null; trigger: string; requirementIds: string[] };

/** Samples taken when something happens; they are outside the planned sequence. */
export const EVENT_TRIGGERS = ['start_of_shift', 'after_setup', 'after_tool_change', 'manual'];
/** Triggers of the planned sequence (a timed extra uses every_n_minutes). */
export const PLANNED_TRIGGERS = ['first_off', 'last_off', 'every_n_parts'];
const MAX_SAMPLES = 2000;

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

/** The part positions (1 = first part of the lot) at which a check is measured, from its rules and the lot size. */
const positionsOf = (rules: SamplingRule[], lot: number | null): number[] => {
  if (!rules.length) return [1];
  const out = new Set<number>();
  const cap = lot ?? Number.MAX_SAFE_INTEGER;
  for (const r of rules) {
    const size = Math.max(1, r.sampleSize || 1);
    if (r.triggerType === 'every_n_minutes') out.add(1); // first reading now, later ones when due
    if (r.triggerType === 'first_off') range(1, Math.min(size, cap)).forEach((p) => out.add(p));
    if (r.triggerType === 'every_n_parts') {
      const step = Math.max(1, r.intervalValue ?? 1);
      if (!lot) range(1, size).forEach((p) => out.add(p));
      else for (let p = 1; p <= lot && out.size < MAX_SAMPLES; p += step) range(p, Math.min(p + size - 1, lot)).forEach((q) => out.add(q));
    }
    if (r.triggerType === 'last_off' && lot) range(Math.max(1, lot - size + 1), lot).forEach((p) => out.add(p));
  }
  return [...out];
};

/**
 * The planned samples, in the order they must be recorded: one per part position at which any check is
 * measured, listing the checks measured on it. Position 1 holds first-off, the first part of every
 * "every N parts" rule, the first reading of timed checks and checks without rules.
 */
export function buildSchedule(requirements: PlanRequirement[], lot: number | null): ScheduledSample[] {
  const byPosition = new Map<number, Set<string>>();
  for (const q of requirements.filter((r) => r.applicable)) {
    for (const p of positionsOf(q.sampling, lot)) {
      if (!byPosition.has(p)) byPosition.set(p, new Set());
      byPosition.get(p)!.add(q.id);
    }
  }
  const positions = [...byPosition.keys()].sort((a, b) => a - b).slice(0, MAX_SAMPLES);
  return positions.map((position, i) => {
    const ids = byPosition.get(position)!;
    const named = (t: string) => requirements.some((q) => ids.has(q.id) && q.sampling.some((s) => s.triggerType === t));
    const trigger = position === 1 ? 'first_off' : lot === position && named('last_off') ? 'last_off' : named('every_n_parts') ? 'every_n_parts' : 'first_off';
    return { number: i + 1, position, trigger, requirementIds: [...ids] };
  });
}

/** Timed checks (every N minutes) that were measured before and are due again. */
export function timedDue(requirements: PlanRequirement[], lastReadingMs: Map<string, number>, now: Date): string[] {
  return requirements
    .filter((q) => q.applicable)
    .filter((q) => {
      const rule = q.sampling.find((s) => s.triggerType === 'every_n_minutes');
      const last = lastReadingMs.get(q.id);
      return !!rule && last !== undefined && last + (rule.intervalValue ?? 0) * 60_000 <= now.getTime();
    })
    .map((q) => q.id);
}

/** What the next sample must contain: the next planned sample plus timed checks now due, or a timed extra. */
export function nextSample(schedule: ScheduledSample[], plannedTaken: number, timed: string[]): NextSample | null {
  const planned = schedule[plannedTaken];
  if (planned) return { kind: 'planned', number: planned.number, trigger: planned.trigger, requirementIds: [...new Set([...planned.requirementIds, ...timed])] };
  if (timed.length) return { kind: 'timed', number: null, trigger: 'every_n_minutes', requirementIds: timed };
  return null;
}

/** Messages when the readings sent are not exactly the checks the next sample needs (empty when fine). */
export function plannedViolations(next: NextSample | null, sent: string[], nameOf: (id: string) => string): string[] {
  if (!next) return ['All planned samples are recorded and no timed check is due; there is nothing more to sample'];
  const label = next.number ? `Sample ${next.number}` : 'The timed check';
  const missing = next.requirementIds.filter((id) => !sent.includes(id));
  const extra = sent.filter((id) => !next.requirementIds.includes(id));
  const out: string[] = [];
  if (missing.length) out.push(`${label} still needs: ${missing.map(nameOf).join(', ')}`);
  if (extra.length) out.push(`${extra.map(nameOf).join(', ')} not part of ${label.toLowerCase()}`);
  return out;
}

/** Messages when an event sample includes a check whose plan has no such rule. */
export function eventViolations(trigger: string, requirements: PlanRequirement[], sent: string[]): string[] {
  return sent
    .map((id) => requirements.find((q) => q.id === id))
    .filter((q): q is PlanRequirement => !!q && !q.sampling.some((s) => s.triggerType === trigger))
    .map((q) => `${q.name}: the control plan does not sample this on "${trigger.replace(/_/g, ' ')}"`);
}
