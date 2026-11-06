import type { InspectionDetail, NcDraft } from './inspection.schemas';

type Reading = InspectionDetail['measurements'][number];
type Requirement = InspectionDetail['requirements'][number];

const RANK = { critical: 3, major: 2, minor: 1 } as const;

/** "2026-11-05 08:35 UTC" — fixed, so the text stored with an NC does not depend on a server time zone. */
export const stamp = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** The requirement as written on a drawing: "24.95 to 25.05 mm", "at most 1.6 µm", "Pass". */
export const limitsText = (q: Requirement): string => {
  if (q.dataType === 'attribute') return 'Pass';
  if (q.dataType === 'count') return q.upperLimit !== null ? `at most ${q.upperLimit} defects per unit` : 'defects counted';
  const unit = q.unitCode ? ` ${q.unitCode}` : '';
  if (q.lowerLimit !== null && q.upperLimit !== null) return `${q.lowerLimit} to ${q.upperLimit}${unit}`;
  if (q.upperLimit !== null) return `at most ${q.upperLimit}${unit}`;
  if (q.lowerLimit !== null) return `at least ${q.lowerLimit}${unit}`;
  return unit.trim();
};

export const valueText = (m: Reading, q: Requirement): string =>
  q.dataType === 'attribute' ? (m.valuePass ? 'Pass' : 'Fail') : q.dataType === 'count' ? `${m.valueCount} ${m.valueCount === 1 ? 'defect' : 'defects'}` : `${m.valueNumeric}${m.unitCode ? ` ${m.unitCode}` : ''}`;

/** A reading that has not been replaced by a correction. */
export const isCurrent = (m: Reading) => !m.supersededById;

/**
 * The suggestion shown when raising an NC from an inspection: title, severity (the highest
 * criticality among the failed checks), quantity (failed samples), the requirement and actual result
 * as text, and a description with the production context, the failed readings and the containment
 * window — the last good reading before the first failure, because production since then may be
 * affected. Everything is editable by the user; the database takes part, revision, site, work
 * order, lot and serial from the inspection itself.
 */
export function buildNcDraft(inspection: InspectionDetail, selectedIds: string[]): NcDraft {
  const reqById = new Map(inspection.requirements.map((q) => [q.id, q]));
  const chosen = inspection.measurements.filter((m) => selectedIds.includes(m.id));
  const sampleNo = new Map(inspection.samples.map((s) => [s.id, s.sampleNumber]));
  const sampleRef = new Map(inspection.samples.map((s) => [s.id, s.unitReference]));
  const byTime = (a: Reading, b: Reading) => a.measuredAt.localeCompare(b.measuredAt) || a.id.localeCompare(b.id);

  const readings: NcDraft['readings'] = chosen.sort(byTime).map((m) => {
    const q = reqById.get(m.requirementId)!;
    return {
      id: m.id,
      requirementName: q.name,
      sampleNumber: sampleNo.get(m.sampleId) ?? 0,
      value: valueText(m, q),
      limits: limitsText(q),
      measuredAt: m.measuredAt,
      alreadyLinked: m.ncrs,
    };
  });

  // Per check: first failure among the chosen readings, and the last good current reading before it.
  const containment: NcDraft['containment'] = [];
  const checkIds = [...new Set(chosen.map((m) => m.requirementId))];
  for (const requirementId of checkIds) {
    const q = reqById.get(requirementId)!;
    const first = chosen.filter((m) => m.requirementId === requirementId).sort(byTime)[0];
    const good = inspection.measurements
      .filter((m) => m.requirementId === requirementId && isCurrent(m) && m.result === 'pass' && m.measuredAt < first.measuredAt)
      .sort(byTime)
      .at(-1);
    containment.push({
      name: q.name,
      lastGood: good ? { sampleNumber: sampleNo.get(good.sampleId) ?? 0, measuredAt: good.measuredAt, value: valueText(good, q) } : null,
      firstFailure: { sampleNumber: sampleNo.get(first.sampleId) ?? 0, measuredAt: first.measuredAt, value: valueText(first, q) },
    });
  }

  const failedChecks = checkIds.map((id) => reqById.get(id)!);
  const severity = failedChecks.length ? failedChecks.reduce((best, q) => (RANK[q.criticality] > RANK[best] ? q.criticality : best), 'minor' as keyof typeof RANK) : null;
  const quantityAffected = chosen.length ? new Set(chosen.map((m) => m.sampleId)).size : null;
  const part = `${inspection.part.partNumber}`;

  const title = !failedChecks.length
    ? `Defect found during inspection ${inspection.reference}: ${part}`
    : failedChecks.length === 1
      ? `${failedChecks[0].name} ${failedChecks[0].dataType === 'attribute' ? 'failed' : 'out of limits'}: ${part} (${inspection.reference})`
      : `${failedChecks.length} checks failed on ${part} (${inspection.reference})`;

  const reactionLines = [
    ...new Set(
      failedChecks.flatMap((q) =>
        q.reactions.filter((r) => r.triggerType === 'out_of_spec').map((r) => `- ${r.action.replace('_', ' ')}: ${r.instruction}`),
      ),
    ),
  ];
  const sampleLabel = (sampleId: string) => {
    const ref = sampleRef.get(sampleId);
    return `sample ${sampleNo.get(sampleId)}${ref ? ` (${ref})` : ''}`;
  };
  const description = [
    `Raised from in-process inspection ${inspection.reference}.`,
    [
      `Part ${part} · ${inspection.part.name}, revision ${inspection.partRevision}.`,
      `Control plan ${inspection.plan.planCode} revision ${inspection.plan.revisionCode}${inspection.operationCode ? `, operation ${inspection.operationCode}` : ''}.`,
      `Site ${inspection.site.name}${inspection.machine ? `, machine ${inspection.machine.code} · ${inspection.machine.name}` : ''}.`,
      [inspection.workOrder && `Work order ${inspection.workOrder}`, inspection.lot && `lot ${inspection.lot}`, inspection.serial && `serial ${inspection.serial}`]
        .filter(Boolean)
        .join(', ')
        .replace(/^./, (c) => c.toUpperCase()) + (inspection.workOrder || inspection.lot || inspection.serial ? '.' : ''),
      `Operator ${inspection.startedBy?.name ?? 'unknown'}; inspection started ${stamp(inspection.startedAt)}.`,
    ]
      .filter((l) => l && l !== '.')
      .join(' '),
    chosen.length
      ? `Failed readings:\n${chosen
          .map((m) => {
            const q = reqById.get(m.requirementId)!;
            const gauge = m.gauge
              ? `; gauge ${m.gauge.assetNumber} (${m.gauge.status.replace('_', ' ')}${m.gauge.nextDueOn ? `, calibration due ${m.gauge.nextDueOn}` : ''}${m.gauge.valid ? '' : '; used with an override'})`
              : '';
            return `- ${q.name}, ${sampleLabel(m.sampleId)}, ${stamp(m.measuredAt)}: ${valueText(m, q)} (requirement ${limitsText(q)})${gauge}`;
          })
          .join('\n')}`
      : 'No measurement covers this defect. Describe what was found, where and how many:',
    containment.length
      ? `Containment window:\n${containment
          .map((c) =>
            c.lastGood
              ? `- ${c.name}: last good reading was sample ${c.lastGood.sampleNumber} at ${stamp(c.lastGood.measuredAt)} (${c.lastGood.value}); first failure sample ${c.firstFailure.sampleNumber} at ${stamp(c.firstFailure.measuredAt)}. Production since the last good check may be affected.`
              : `- ${c.name}: no earlier good reading in this inspection; everything since it started (${stamp(inspection.startedAt)}) may be affected.`,
          )
          .join('\n')}`
      : '',
    reactionLines.length ? `Reaction plan:\n${reactionLines.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    title: title.slice(0, 200),
    description,
    severity,
    quantityAffected,
    requirement: failedChecks.map((q) => `${q.name}: ${limitsText(q)}`).join('\n'),
    actualResult: chosen
      .map((m) => `${reqById.get(m.requirementId)!.name}, ${sampleLabel(m.sampleId)}: ${valueText(m, reqById.get(m.requirementId)!)}`)
      .join('\n'),
    readings,
    containment,
  };
}
