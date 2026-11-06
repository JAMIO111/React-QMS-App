import type { InspectionDetail } from './inspection.schemas';
import { buildNcDraft, limitsText, stamp } from './ncr-draft';

const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const req = (over: Partial<InspectionDetail['requirements'][number]>) => ({
  id: U(1),
  sequence: 1,
  characteristicKey: 'OD',
  charNumber: null,
  name: 'Outer diameter',
  operationCode: 'OP-020',
  dataType: 'variable' as const,
  valueSource: 'plan' as const,
  specKey: null,
  applicable: true,
  applicability: 'All parts in scope',
  nominal: 25,
  lowerLimit: 24.95,
  upperLimit: 25.05,
  unitCode: 'mm',
  method: null,
  gaugeType: null,
  criticality: 'major' as const,
  spcEligible: false,
  chartType: null,
  subgroupSize: null,
  decimals: null,
  sampling: [],
  reactions: [{ triggerType: 'out_of_spec', action: 'hold', instruction: 'Quarantine since the last good check' }],
  ...over,
});
const reading = (id: number, sampleId: number, requirementId: number, value: string, result: 'pass' | 'fail', at: string, over = {}) => ({
  id: U(id),
  sampleId: U(sampleId),
  requirementId: U(requirementId),
  valueNumeric: value,
  valuePass: null,
  valueCount: null,
  unitCode: 'mm',
  result,
  gauge: { id: U(900), assetNumber: 'MIC-1', status: 'active', nextDueOn: '2026-12-01', valid: true },
  gaugeOverrideReason: null,
  measuredAt: `2026-11-05T${at}:00.000Z`,
  measuredBy: null,
  supersedesId: null,
  supersededById: null,
  correctionReason: null,
  retestOfId: null,
  notes: null,
  acknowledgement: null,
  ncrs: [],
  ...over,
});
const sample = (id: number, n: number, ref: string | null = null) => ({
  id: U(id), sampleNumber: n, sampledAt: '2026-11-05T08:00:00.000Z', unitReference: ref, triggerType: 'first_off' as const, isRetest: false, subgroupNumber: null, notes: null, takenBy: null,
});

const inspection = (over: Partial<InspectionDetail> = {}): InspectionDetail => ({
  id: U(500),
  reference: 'IPI-26-0001',
  lotSize: null,
  schedule: [],
  status: 'in_progress',
  result: null,
  part: { id: U(600), partNumber: 'HCR-100', name: 'Rod 100' },
  partRevision: 'A',
  plan: { id: U(700), planCode: 'CP-1', revisionCode: 'B' },
  operationCode: 'OP-020',
  site: { id: U(800), name: 'Plant A' },
  machine: { id: U(801), code: 'LATHE-01', name: 'CNC lathe 1' },
  workOrder: 'WO-9',
  lot: 'LOT-3',
  serial: null,
  triggerType: 'first_off',
  startedAt: '2026-11-05T08:00:00.000Z',
  startedBy: { id: U(1000), name: 'Ada Owner' },
  failures: 2,
  notes: null,
  completedAt: null,
  completedBy: null,
  abandonReason: null,
  requirements: [req({}), req({ id: U(2), characteristicKey: 'VISUAL', name: 'No chatter marks', dataType: 'attribute', lowerLimit: null, upperLimit: null, nominal: null, unitCode: null, criticality: 'critical', reactions: [] })],
  samples: [sample(11, 1, 'S/N 1'), sample(12, 2, 'S/N 2'), sample(13, 3)],
  measurements: [
    reading(21, 11, 1, '25.0', 'pass', '08:05'),
    reading(22, 12, 1, '25.07', 'fail', '08:35'),
    reading(23, 13, 1, '25.08', 'fail', '09:05'),
  ],
  ncrs: [],
  ...over,
});

describe('limitsText', () => {
  it('writes limits as on a drawing', () => {
    expect(limitsText(req({}))).toBe('24.95 to 25.05 mm');
    expect(limitsText(req({ lowerLimit: null, upperLimit: 1.6, unitCode: 'µm' }))).toBe('at most 1.6 µm');
    expect(limitsText(req({ lowerLimit: 3, upperLimit: null }))).toBe('at least 3 mm');
    expect(limitsText(req({ dataType: 'attribute' }))).toBe('Pass');
  });
  it('formats times in UTC', () => expect(stamp('2026-11-05T08:35:00.000Z')).toBe('2026-11-05 08:35 UTC'));
});

describe('buildNcDraft', () => {
  it('suggests title, severity, quantity, requirement and actual result for a batch of failures', () => {
    const d = buildNcDraft(inspection(), [U(22), U(23)]);
    expect(d.title).toBe('Outer diameter out of limits: HCR-100 (IPI-26-0001)');
    expect(d.severity).toBe('major');
    expect(d.quantityAffected).toBe(2);
    expect(d.requirement).toBe('Outer diameter: 24.95 to 25.05 mm');
    expect(d.actualResult).toBe('Outer diameter, sample 2 (S/N 2): 25.07 mm\nOuter diameter, sample 3: 25.08 mm');
    expect(d.readings.map((r) => [r.sampleNumber, r.value])).toEqual([[2, '25.07 mm'], [3, '25.08 mm']]);
  });

  it('describes the production context and the containment window', () => {
    const d = buildNcDraft(inspection(), [U(22), U(23)]);
    expect(d.containment).toEqual([
      {
        name: 'Outer diameter',
        lastGood: { sampleNumber: 1, measuredAt: '2026-11-05T08:05:00.000Z', value: '25.0 mm' },
        firstFailure: { sampleNumber: 2, measuredAt: '2026-11-05T08:35:00.000Z', value: '25.07 mm' },
      },
    ]);
    expect(d.description).toContain('Raised from in-process inspection IPI-26-0001.');
    expect(d.description).toContain('Part HCR-100 · Rod 100, revision A. Control plan CP-1 revision B, operation OP-020. Site Plant A, machine LATHE-01 · CNC lathe 1. Work order WO-9, lot LOT-3.');
    expect(d.description).toContain('Operator Ada Owner; inspection started 2026-11-05 08:00 UTC.');
    expect(d.description).toContain('- Outer diameter, sample 2 (S/N 2), 2026-11-05 08:35 UTC: 25.07 mm (requirement 24.95 to 25.05 mm); gauge MIC-1 (active, calibration due 2026-12-01)');
    expect(d.description).toContain('last good reading was sample 1 at 2026-11-05 08:05 UTC (25.0 mm); first failure sample 2 at 2026-11-05 08:35 UTC. Production since the last good check may be affected.');
    expect(d.description).toContain('Reaction plan:\n- hold: Quarantine since the last good check');
  });

  it('says so when there is no earlier good reading', () => {
    const d = buildNcDraft(inspection({ measurements: [reading(22, 12, 1, '25.07', 'fail', '08:35')] }), [U(22)]);
    expect(d.containment[0].lastGood).toBeNull();
    expect(d.description).toContain('no earlier good reading in this inspection; everything since it started (2026-11-05 08:00 UTC) may be affected.');
  });

  it('ignores a good reading that was later superseded or only good after the failure', () => {
    const d = buildNcDraft(
      inspection({
        measurements: [
          reading(21, 11, 1, '25.0', 'pass', '08:05', { supersededById: U(99) }),
          reading(22, 12, 1, '25.07', 'fail', '08:35'),
          reading(24, 13, 1, '25.0', 'pass', '09:00'),
        ],
      }),
      [U(22)],
    );
    expect(d.containment[0].lastGood).toBeNull();
  });

  it('takes the highest criticality and describes several failed checks', () => {
    const insp = inspection({
      samples: [sample(11, 1), sample(12, 2)],
      measurements: [
        reading(22, 12, 1, '25.07', 'fail', '08:35'),
        reading(25, 12, 2, '', 'fail', '08:36', { valueNumeric: null, valuePass: false, unitCode: null, gauge: null }),
      ],
    });
    const d = buildNcDraft(insp, [U(22), U(25)]);
    expect(d.severity).toBe('critical');
    expect(d.title).toBe('2 checks failed on HCR-100 (IPI-26-0001)');
    expect(d.quantityAffected).toBe(1); // both failed on the same sample (one unit)
    expect(d.actualResult).toContain('No chatter marks, sample 2: Fail');
  });

  it('suggests a manual NC when no reading is chosen', () => {
    const d = buildNcDraft(inspection(), []);
    expect(d).toMatchObject({ title: 'Defect found during inspection IPI-26-0001: HCR-100', severity: null, quantityAffected: null, requirement: '', actualResult: '', readings: [], containment: [] });
    expect(d.description).toContain('No measurement covers this defect.');
  });

  it('reports NCs a reading is already linked to', () => {
    const linked = { id: U(77), reference: 'NCR-26-001', stage: 'open', title: 'x' };
    const d = buildNcDraft(inspection({ measurements: [reading(22, 12, 1, '25.07', 'fail', '08:35', { ncrs: [linked] })] }), [U(22)]);
    expect(d.readings[0].alreadyLinked).toEqual([linked]);
  });
});
