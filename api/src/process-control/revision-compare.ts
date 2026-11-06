import type { PlanCharacteristic, PlanOperation, RevisionComparison, RevisionDetail } from './process-control.schemas';

type Field = RevisionComparison['characteristics'][number]['fields'][number];

const TRIGGERS: Record<string, string> = {
  first_off: 'First-off',
  last_off: 'Last-off',
  every_n_minutes: 'Every {n} min',
  every_n_parts: 'Every {n} parts',
  start_of_shift: 'Start of shift',
  after_tool_change: 'After tool change',
  after_setup: 'After set-up',
  manual: 'On demand',
};
const REACTION_TRIGGERS: Record<string, string> = {
  out_of_spec: 'Out of specification',
  spc_signal: 'SPC signal',
  gauge_invalid: 'Gauge invalid',
  missed_check: 'Missed check',
};
const ACTIONS: Record<string, string> = { warn: 'warn', hold: 'hold', stop: 'stop', notify: 'notify', raise_ncr: 'raise NC' };

export const describeSampling = (s: { triggerType: string; intervalValue: number | null; sampleSize: number }) =>
  `${(TRIGGERS[s.triggerType] ?? s.triggerType).replace('{n}', String(s.intervalValue ?? ''))} × ${s.sampleSize}`;
export const describeReaction = (r: { triggerType: string; action: string; instruction: string }) =>
  `${REACTION_TRIGGERS[r.triggerType] ?? r.triggerType} → ${ACTIONS[r.action] ?? r.action}: ${r.instruction}`;

const num = (v: number | null) => (v === null ? null : String(v));
const join = (items: string[]) => (items.length ? [...items].sort().join('; ') : null);

/** Values compared for a characteristic, as display strings (null = not set). */
const characteristicValues = (c: PlanCharacteristic, operationCode: string): Record<string, [string, string | null]> => ({
  operation: ['Operation', operationCode],
  name: ['Name', c.name],
  charNumber: ['Characteristic number', c.charNumber],
  dataType: ['Type', c.dataType === 'attribute' ? 'Pass / fail' : 'Measured'],
  valueSource: ['Values from', c.dataType === 'attribute' ? null : c.valueSource === 'part_spec' ? `Part specification (${c.specKey})` : 'This plan'],
  appliesTo: ['Applies to', c.appliesTo === 'selected' ? `Selected parts: ${c.parts.map((p) => p.partNumber).sort().join(', ')}` : 'All parts in scope'],
  nominal: ['Nominal', num(c.nominal)],
  lowerLimit: ['Lower limit', num(c.lowerLimit)],
  upperLimit: ['Upper limit', num(c.upperLimit)],
  unitCode: ['Unit', c.unitCode],
  method: ['Method', c.method],
  gaugeType: ['Gauge type', c.gaugeType?.name ?? null],
  criticality: ['Criticality', c.criticality],
  spc: ['SPC', c.spcEligible ? (c.chartType === 'p' ? 'P chart (proportion failed)' : `${c.chartType === 'xbar_r' ? 'X-bar/R' : 'I-MR'}, subgroup ${c.subgroupSize}`) : null],
  sampling: ['Sampling', join(c.sampling.map(describeSampling))],
  reactions: ['Reactions', join(c.reactions.map(describeReaction))],
});

const operationValues = (o: PlanOperation): Record<string, [string, string | null]> => ({
  name: ['Name', o.name],
  sequence: ['Sequence', String(o.sequence)],
  machine: ['Machine', o.machine ? `${o.machine.code} · ${o.machine.name}` : null],
  workCentre: ['Work centre', o.workCentre],
});

const diff = (before: Record<string, [string, string | null]>, after: Record<string, [string, string | null]>): Field[] =>
  Object.keys(after)
    .filter((k) => before[k][1] !== after[k][1])
    .map((k) => ({ field: k, label: after[k][0], from: before[k][1], to: after[k][1] }));

/**
 * Tighter when the allowed band only shrank, looser when it only grew; shifted otherwise. An open
 * limit (null) counts as unbounded on that side.
 */
export const toleranceChange = (
  before: { lowerLimit: number | null; upperLimit: number | null },
  after: { lowerLimit: number | null; upperLimit: number | null },
): 'tightened' | 'loosened' | 'shifted' | null => {
  const lo = (v: number | null) => (v === null ? -Infinity : v);
  const hi = (v: number | null) => (v === null ? Infinity : v);
  const [l0, u0, l1, u1] = [lo(before.lowerLimit), hi(before.upperLimit), lo(after.lowerLimit), hi(after.upperLimit)];
  if (l0 === l1 && u0 === u1) return null;
  if (l1 >= l0 && u1 <= u0) return 'tightened';
  if (l1 <= l0 && u1 >= u0) return 'loosened';
  return 'shifted';
};

const flatten = (rev: RevisionDetail) =>
  new Map(rev.operations.flatMap((o) => o.characteristics.map((c) => [c.characteristicKey, { c, op: o.operationCode }] as const)));

/** What changed from `base` (the revision being replaced) to `target`. Removed items are listed explicitly. */
export function compareRevisions(base: RevisionDetail | null, target: RevisionDetail): RevisionComparison {
  const before = base ? flatten(base) : new Map<string, { c: PlanCharacteristic; op: string }>();
  const after = flatten(target);
  const characteristics: RevisionComparison['characteristics'] = [];
  for (const [key, { c, op }] of after) {
    const prev = before.get(key);
    if (!prev) {
      characteristics.push({ characteristicKey: key, name: c.name, change: 'added', tolerance: null, fields: [] });
      continue;
    }
    const fields = diff(characteristicValues(prev.c, prev.op), characteristicValues(c, op));
    if (!fields.length) continue;
    const measuredOnPlan = c.dataType === 'variable' && c.valueSource === 'plan' && prev.c.dataType === 'variable' && prev.c.valueSource === 'plan';
    characteristics.push({
      characteristicKey: key,
      name: c.name,
      change: 'changed',
      tolerance: measuredOnPlan ? toleranceChange(prev.c, c) : null,
      fields,
    });
  }
  for (const [key, { c }] of before) {
    if (!after.has(key)) characteristics.push({ characteristicKey: key, name: c.name, change: 'removed', tolerance: null, fields: [] });
  }
  const order = { removed: 0, changed: 1, added: 2 } as const;
  characteristics.sort((a, b) => order[a.change] - order[b.change] || a.characteristicKey.localeCompare(b.characteristicKey));

  const opsBefore = new Map((base?.operations ?? []).map((o) => [o.operationCode, o]));
  const operations: RevisionComparison['operations'] = [];
  for (const o of target.operations) {
    const prev = opsBefore.get(o.operationCode);
    if (!prev) operations.push({ operationCode: o.operationCode, change: 'added', fields: [] });
    else {
      const fields = diff(operationValues(prev), operationValues(o));
      if (fields.length) operations.push({ operationCode: o.operationCode, change: 'changed', fields });
    }
  }
  for (const o of base?.operations ?? []) {
    if (!target.operations.some((t) => t.operationCode === o.operationCode)) operations.push({ operationCode: o.operationCode, change: 'removed', fields: [] });
  }

  const rBefore = new Set((base?.reactions ?? []).map(describeReaction));
  const rAfter = new Set(target.reactions.map(describeReaction));
  const reactions: RevisionComparison['reactions'] = [
    ...[...rBefore].filter((d) => !rAfter.has(d)).map((description) => ({ change: 'removed' as const, description })),
    ...[...rAfter].filter((d) => !rBefore.has(d)).map((description) => ({ change: 'added' as const, description })),
  ];

  return {
    base: base ? { id: base.id, revisionCode: base.revisionCode } : null,
    target: { id: target.id, revisionCode: target.revisionCode },
    operations,
    characteristics,
    reactions,
    summary: {
      added: characteristics.filter((c) => c.change === 'added').length,
      removed: characteristics.filter((c) => c.change === 'removed').length,
      changed: characteristics.filter((c) => c.change === 'changed').length,
    },
  };
}
