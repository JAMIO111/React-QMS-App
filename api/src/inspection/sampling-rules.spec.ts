import { buildSchedule, eventViolations, nextSample, PlanRequirement, plannedViolations, timedDue } from './sampling-rules';

const req = (id: string, sampling: PlanRequirement['sampling'], applicable = true): PlanRequirement => ({ id, name: id, charNumber: null, applicable, sampling });
const first = { triggerType: 'first_off', intervalValue: null, sampleSize: 1 };
const parts = (n: number, size = 1) => ({ triggerType: 'every_n_parts', intervalValue: n, sampleSize: size });
const minutes = (n: number) => ({ triggerType: 'every_n_minutes', intervalValue: n, sampleSize: 1 });

describe('buildSchedule', () => {
  it('puts first-off, "every 1 in 1" and unruled checks on sample 1; every-1 checks continue each part', () => {
    const s = buildSchedule([req('od', [first]), req('len', [parts(1)]), req('vis', [])], 3);
    expect(s.map((x) => [x.number, x.position, x.trigger])).toEqual([[1, 1, 'first_off'], [2, 2, 'every_n_parts'], [3, 3, 'every_n_parts']]);
    expect([...s[0].requirementIds].sort()).toEqual(['len', 'od', 'vis']);
    expect(s[1].requirementIds).toEqual(['len']);
  });
  it('schedules every N parts at 1, N+1, 2N+1 within the lot', () => {
    expect(buildSchedule([req('a', [parts(50)])], 120).map((x) => x.position)).toEqual([1, 51, 101]);
  });
  it('takes sample size consecutive parts at each position and last off at the end of the lot', () => {
    expect(buildSchedule([req('a', [first, { ...parts(10), sampleSize: 2 }, { triggerType: 'last_off', intervalValue: null, sampleSize: 1 }])], 25).map((x) => [x.position, x.trigger])).toEqual([
      [1, 'first_off'], [2, 'every_n_parts'], [11, 'every_n_parts'], [12, 'every_n_parts'], [21, 'every_n_parts'], [22, 'every_n_parts'], [25, 'last_off'],
    ]);
  });
  it('ignores not applicable checks and measures timed checks first on sample 1', () => {
    const s = buildSchedule([req('t', [minutes(30)]), req('x', [first], false)], null);
    expect(s).toHaveLength(1);
    expect(s[0].requirementIds).toEqual(['t']);
  });
});

describe('next sample', () => {
  const reqs = [req('od', [first, minutes(30)]), req('len', [parts(1)])];
  const schedule = buildSchedule(reqs, 2);
  const now = new Date('2025-01-01T12:00:00Z');
  const last = (m: number) => new Map([['od', now.getTime() - m * 60_000]]);

  it('adds timed checks that are due to the next planned sample', () => {
    expect(timedDue(reqs, last(10), now)).toEqual([]);
    expect(timedDue(reqs, last(30), now)).toEqual(['od']);
    expect(nextSample(schedule, 1, timedDue(reqs, last(30), now))).toMatchObject({ kind: 'planned', number: 2, requirementIds: ['len', 'od'] });
  });
  it('offers a timed extra after the plan is finished, only when something is due', () => {
    expect(nextSample(schedule, 2, [])).toBeNull();
    expect(nextSample(schedule, 2, ['od'])).toMatchObject({ kind: 'timed', trigger: 'every_n_minutes', requirementIds: ['od'] });
  });
  it('reports missing and extra checks', () => {
    const next = nextSample(schedule, 0, [])!;
    expect(plannedViolations(next, ['od', 'len'], (id) => id)).toEqual([]);
    expect(plannedViolations(next, ['od'], (id) => id)).toEqual(['Sample 1 still needs: len']);
    expect(plannedViolations(next, ['od', 'len', 'zz'], (id) => id)).toEqual(['zz not part of sample 1']);
    expect(plannedViolations(null, ['od'], (id) => id)[0]).toMatch(/nothing more to sample/);
  });
  it('checks event samples against the plan', () => {
    const r = [req('a', [{ triggerType: 'after_tool_change', intervalValue: null, sampleSize: 1 }]), req('b', [first])];
    expect(eventViolations('after_tool_change', r, ['a'])).toEqual([]);
    expect(eventViolations('after_tool_change', r, ['a', 'b'])).toEqual(['b: the control plan does not sample this on "after tool change"']);
  });
});
