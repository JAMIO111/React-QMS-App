import { samplingViolation, SamplingRule } from './sampling-rules';

const now = new Date('2025-01-01T12:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const rules: SamplingRule[] = [
  { triggerType: 'first_off', intervalValue: null, sampleSize: 1 },
  { triggerType: 'every_n_minutes', intervalValue: 60, sampleSize: 1 },
  { triggerType: 'every_n_parts', intervalValue: 50, sampleSize: 1 },
  { triggerType: 'after_setup', intervalValue: null, sampleSize: 1 },
];
const check = (trigger: string, readings: { triggerType: string; measuredAt: Date }[] = [], lot: number | null = null) =>
  samplingViolation('OD', rules, trigger, { readings }, lot, now);

describe('samplingViolation', () => {
  it('does not restrict requirements without rules', () => {
    expect(samplingViolation('OD', [], 'manual', { readings: [] }, null, now)).toBeNull();
  });
  it('only accepts triggers in the plan', () => {
    expect(check('last_off')).toMatch(/does not sample/);
    expect(check('after_setup')).toBeNull();
  });
  it('allows first off once', () => {
    expect(check('first_off')).toBeNull();
    expect(check('first_off', [{ triggerType: 'first_off', measuredAt: minutesAgo(1) }])).toMatch(/already/);
  });
  it('enforces the time interval', () => {
    const last = [{ triggerType: 'first_off', measuredAt: minutesAgo(45) }];
    expect(check('every_n_minutes', last)).toMatch(/next in 15 min/);
    expect(check('every_n_minutes', [{ triggerType: 'first_off', measuredAt: minutesAgo(60) }])).toBeNull();
    expect(check('every_n_minutes')).toBeNull();
  });
  it('enforces ceil(lot size / N) parts samples and needs a lot size', () => {
    expect(check('every_n_parts')).toMatch(/set the lot size/);
    const taken = (n: number) => Array.from({ length: n }, () => ({ triggerType: 'every_n_parts', measuredAt: minutesAgo(5) }));
    expect(check('every_n_parts', taken(2), 120)).toBeNull();
    expect(check('every_n_parts', taken(3), 120)).toMatch(/all 3 every-50-parts samples/);
  });
});
