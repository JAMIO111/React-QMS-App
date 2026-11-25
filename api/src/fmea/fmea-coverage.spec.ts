import { controlCoverage, CoverageCause, CoverageLink, criticalitySuggestion, groupPlanCover, linkState } from './fmea-coverage';

const cause = (id: string, over: Partial<CoverageCause> = {}): CoverageCause => ({
  id, text: `Cause ${id}`, failureMode: 'Bore oversize', itemName: 'Bracket', priority: 'high', severity: 8, rpn: 100, specialClass: null, ...over,
});
const link = (id: string, causeId: string, state: CoverageLink['state'], over: Partial<CoverageLink> = {}): CoverageLink => ({
  id, causeId, kind: 'prevention', state, planCode: 'CP-1', operationCode: 'OP-20', characteristicKey: 'OD', ...over,
});

describe('linkState', () => {
  it('cannot say anything without the right to read control plans', () => {
    expect(linkState(false, true, true)).toBe('unknown');
  });
  it('is in the plan when the plan in force has it', () => {
    expect(linkState(true, true, true)).toBe('in_plan');
  });
  it('is not in force when only a draft of the plan has it', () => {
    expect(linkState(true, false, true)).toBe('not_in_force');
  });
  it('is missing when no revision of the plan has it', () => {
    expect(linkState(true, false, false)).toBe('missing');
  });
});

describe('controlCoverage', () => {
  it('has nothing to say, and no percentage, when no cause needs attention', () => {
    const c = controlCoverage([], []);
    expect(c.rows).toEqual([]);
    expect(c.totals).toEqual({ needingAttention: 0, covered: 0, unverified: 0, linkProblems: 0, notCovered: 0, coveredPercent: null });
  });

  it('covers a cause when a carried control is in the plan in force', () => {
    const c = controlCoverage([cause('a')], [link('l1', 'a', 'in_plan')]);
    expect(c.rows[0]!.status).toBe('covered');
    expect(c.totals.coveredPercent).toBe(100);
  });

  it('does not cover a cause with no link', () => {
    const c = controlCoverage([cause('a')], []);
    expect(c.rows[0]!.status).toBe('not_covered');
    expect(c.rows[0]!.why).toMatch(/carry a control/);
  });

  it('one link in the plan is enough even when another is broken', () => {
    const c = controlCoverage([cause('a')], [link('l1', 'a', 'missing'), link('l2', 'a', 'in_plan', { kind: 'detection' })]);
    expect(c.rows[0]!.status).toBe('covered');
    expect(c.rows[0]!.links).toHaveLength(2);
  });

  it('says a link to a draft characteristic is on its way, not that it is wrong', () => {
    const c = controlCoverage([cause('a')], [link('l1', 'a', 'not_in_force')]);
    expect(c.rows[0]!.status).toBe('link_problem');
    expect(c.rows[0]!.why).toMatch(/only on a draft/);
  });

  it('says a link to a characteristic the plan no longer has is broken', () => {
    const c = controlCoverage([cause('a')], [link('l1', 'a', 'missing')]);
    expect(c.rows[0]!.status).toBe('link_problem');
    expect(c.rows[0]!.why).toMatch(/does not have that characteristic/);
  });

  it('is unverified, not wrong, when the caller cannot read control plans', () => {
    const c = controlCoverage([cause('a')], [link('l1', 'a', 'unknown')]);
    expect(c.rows[0]!.status).toBe('unverified');
    expect(c.totals.unverified).toBe(1);
    expect(c.totals.coveredPercent).toBe(0);
  });

  it('ignores links on other causes', () => {
    const c = controlCoverage([cause('a'), cause('b')], [link('l1', 'b', 'in_plan')]);
    expect(c.rows.find((r) => r.id === 'a')!.status).toBe('not_covered');
    expect(c.rows.find((r) => r.id === 'b')!.status).toBe('covered');
    expect(c.totals).toMatchObject({ needingAttention: 2, covered: 1, notCovered: 1, coveredPercent: 50 });
  });

  it('lists the worst first: not covered, broken links, unverified, then covered; high priority and RPN first within each', () => {
    const causes = [
      cause('covered', { rpn: 900 }),
      cause('low', { priority: 'low', rpn: 50 }),
      cause('high-small', { priority: 'high', rpn: 100 }),
      cause('high-big', { priority: 'high', rpn: 500 }),
      cause('broken', { priority: 'medium', rpn: 10 }),
      cause('unknown', { priority: 'high', rpn: 10 }),
      cause('severe', { priority: null, severity: 9, rpn: null }),
    ];
    const links = [link('l1', 'covered', 'in_plan'), link('l2', 'broken', 'missing'), link('l3', 'unknown', 'unknown')];
    const order = controlCoverage(causes, links).rows.map((r) => r.id);
    expect(order).toEqual(['high-big', 'high-small', 'low', 'severe', 'broken', 'unknown', 'covered']);
  });

  it('puts a cause with no priority (a severity-floor cause) after the rated ones of its group', () => {
    const order = controlCoverage([cause('x', { priority: null, rpn: null }), cause('y', { priority: 'low', rpn: 5 })], []).rows.map((r) => r.id);
    expect(order).toEqual(['y', 'x']);
  });
});

describe('groupPlanCover', () => {
  const cover = (cause: string, priority: 'high' | 'medium' | 'low' | null = 'high') => ({
    causeId: cause, cause, failureMode: 'FM', priority, needsAttention: priority === 'high', kind: 'prevention' as const, fmeaId: 'f', fmeaNumber: 'FMEA-001', fmeaTitle: 'T', revisionLetter: 'A',
  });

  it('groups by operation (ignoring case) and key', () => {
    const g = groupPlanCover([
      { operationCode: 'OP-20', characteristicKey: 'OD', cover: cover('a') },
      { operationCode: 'op-20', characteristicKey: 'OD', cover: cover('b') },
      { operationCode: 'OP-20', characteristicKey: 'ID', cover: cover('c') },
    ]);
    expect(g).toHaveLength(2);
    expect(g.find((x) => x.characteristicKey === 'OD')!.covers.map((c) => c.causeId)).toEqual(['a', 'b']);
  });

  it('puts the most pressing cause first and sorts the groups', () => {
    const g = groupPlanCover([
      { operationCode: 'OP-30', characteristicKey: 'A', cover: cover('z', 'low') },
      { operationCode: 'OP-20', characteristicKey: 'B', cover: cover('m', 'low') },
      { operationCode: 'OP-20', characteristicKey: 'B', cover: cover('h', 'high') },
    ]);
    expect(g.map((x) => `${x.operationCode}/${x.characteristicKey}`)).toEqual(['OP-20/B', 'OP-30/A']);
    expect(g[0]!.covers.map((c) => c.causeId)).toEqual(['h', 'm']);
  });
});

describe('criticalitySuggestion', () => {
  it('suggests nothing without a special class or a criticality', () => {
    expect(criticalitySuggestion(null, 'minor')).toBeNull();
    expect(criticalitySuggestion('critical', null)).toBeNull();
  });
  it('suggests raising a plan characteristic below the failure mode special class', () => {
    expect(criticalitySuggestion('critical', 'major')).toMatch(/marked critical.*major/);
    expect(criticalitySuggestion('critical', 'minor')).toMatch(/raising it to critical/);
    expect(criticalitySuggestion('significant', 'minor')).toMatch(/raising it to major/);
  });
  it('is quiet when the plan already agrees or is stricter', () => {
    expect(criticalitySuggestion('critical', 'critical')).toBeNull();
    expect(criticalitySuggestion('significant', 'major')).toBeNull();
    expect(criticalitySuggestion('significant', 'critical')).toBeNull();
  });
});
