import type { PlanCharacteristic, RevisionDetail } from './process-control.schemas';
import { compareRevisions, describeSampling, toleranceChange } from './revision-compare';

const ch = (over: Partial<PlanCharacteristic>): PlanCharacteristic => ({
  id: '00000000-0000-0000-0000-000000000001',
  operationId: '00000000-0000-0000-0000-0000000000a1',
  characteristicKey: 'OD',
  sequence: 10,
  charNumber: null,
  name: 'Outer diameter',
  dataType: 'variable',
  valueSource: 'plan',
  appliesTo: 'all',
  nominal: 25,
  lowerLimit: 24.95,
  upperLimit: 25.05,
  unitCode: 'mm',
  specKey: null,
  method: null,
  gaugeType: null,
  criticality: 'major',
  spcEligible: false,
  chartType: null,
  subgroupSize: null,
  decimals: null,
  notes: null,
  parts: [],
  sampling: [],
  reactions: [],
  ...over,
});

const rev = (code: string, chars: PlanCharacteristic[], reactions: RevisionDetail['reactions'] = []): RevisionDetail => ({
  id: `00000000-0000-0000-0000-00000000000${code === 'A' ? 'a' : 'b'}`,
  controlPlanId: '00000000-0000-0000-0000-0000000000c1',
  revisionCode: code,
  status: 'draft',
  changeReason: null,
  effectiveFrom: null,
  effectiveUntil: null,
  supersedesRevision: null,
  createdAt: '2026-11-04T10:00:00.000Z',
  createdBy: null,
  submittedAt: null,
  submittedBy: null,
  approvedAt: null,
  approvedBy: null,
  reviewComment: null,
  obsoleteReason: null,
  plan: { id: '00000000-0000-0000-0000-0000000000c1', planCode: 'CP-1', title: 'Rods', active: true },
  operations: [{ id: '00000000-0000-0000-0000-0000000000a1', operationCode: 'OP-020', sequence: 20, name: 'Turning', machine: null, workCentre: null, notes: null, characteristics: chars }],
  reactions,
  scopeParts: [],
});

describe('toleranceChange', () => {
  it('classifies band changes', () => {
    expect(toleranceChange({ lowerLimit: 1, upperLimit: 2 }, { lowerLimit: 1, upperLimit: 2 })).toBeNull();
    expect(toleranceChange({ lowerLimit: 1, upperLimit: 2 }, { lowerLimit: 1.1, upperLimit: 2 })).toBe('tightened');
    expect(toleranceChange({ lowerLimit: 1, upperLimit: 2 }, { lowerLimit: 0.9, upperLimit: 2.1 })).toBe('loosened');
    expect(toleranceChange({ lowerLimit: 1, upperLimit: 2 }, { lowerLimit: 1.1, upperLimit: 2.1 })).toBe('shifted');
    // An open limit is unbounded: adding one tightens, removing one loosens.
    expect(toleranceChange({ lowerLimit: null, upperLimit: 1.6 }, { lowerLimit: 0.2, upperLimit: 1.6 })).toBe('tightened');
    expect(toleranceChange({ lowerLimit: 0.2, upperLimit: 1.6 }, { lowerLimit: null, upperLimit: 1.6 })).toBe('loosened');
  });
});

describe('compareRevisions', () => {
  it('lists added, removed and changed characteristics with field changes', () => {
    const a = rev('A', [ch({}), ch({ characteristicKey: 'RA', name: 'Roughness', lowerLimit: null, upperLimit: 1.6, nominal: null, unitCode: 'µm' })]);
    const b = rev(
      'B',
      [
        ch({ lowerLimit: 24.98, upperLimit: 25.02, sampling: [{ id: '00000000-0000-0000-0000-000000000005', triggerType: 'every_n_minutes', intervalValue: 30, sampleSize: 5 }] }),
        ch({ characteristicKey: 'LENGTH', name: 'Length', valueSource: 'part_spec', specKey: 'LENGTH', nominal: null, lowerLimit: null, upperLimit: null }),
      ],
      [{ id: '00000000-0000-0000-0000-000000000006', triggerType: 'gauge_invalid', action: 'stop', instruction: 'Use a calibrated gauge' }],
    );
    const result = compareRevisions(a, b);
    expect(result.summary).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(result.characteristics.map((c) => `${c.change}:${c.characteristicKey}`)).toEqual(['removed:RA', 'changed:OD', 'added:LENGTH']);
    const od = result.characteristics[1];
    expect(od.tolerance).toBe('tightened');
    expect(od.fields).toEqual([
      { field: 'lowerLimit', label: 'Lower limit', from: '24.95', to: '24.98' },
      { field: 'upperLimit', label: 'Upper limit', from: '25.05', to: '25.02' },
      { field: 'sampling', label: 'Sampling', from: null, to: 'Every 30 min × 5' },
    ]);
    expect(result.reactions).toEqual([{ change: 'added', description: 'Gauge invalid → stop: Use a calibrated gauge' }]);
    expect(result.operations).toEqual([]);
  });

  it('treats everything as added without a base revision', () => {
    const result = compareRevisions(null, rev('A', [ch({})]));
    expect(result.base).toBeNull();
    expect(result.summary).toEqual({ added: 1, removed: 0, changed: 0 });
  });

  it('describes sampling rules', () => {
    expect(describeSampling({ triggerType: 'first_off', intervalValue: null, sampleSize: 1 })).toBe('First-off × 1');
    expect(describeSampling({ triggerType: 'every_n_parts', intervalValue: 50, sampleSize: 3 })).toBe('Every 50 parts × 3');
  });
});
