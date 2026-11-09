import { recommendInspection, RecommendationInput } from './inspection-recommendation';

const good: RecommendationInput = { approvalStatus: 'approved', riskRating: 'low', band: 'good', deliveredLines: 12, minLines: 5, rejectedLines: 0, criticalNcs: 0, majorNcs: 0, overdueScars: 0, expiredCerts: 0 };
const level = (over: Partial<RecommendationInput>) => recommendInspection({ ...good, ...over });

describe('inspection recommendation', () => {
  it('reduces only when everything is in order', () => {
    const r = level({});
    expect(r).toMatchObject({ level: 'reduced', canReduce: true });
    expect(r.reasons[0].kind).toBe('supports');
  });

  it.each([
    ['high risk', { riskRating: 'high' as const }, 'risk'],
    ['critical risk', { riskRating: 'critical' as const }, 'risk'],
    ['a conditional supplier', { approvalStatus: 'conditional' }, 'approval'],
    ['a suspended supplier', { approvalStatus: 'suspended' }, 'approval'],
    ['a poor band', { band: 'poor' as const }, 'band'],
    ['a critical non-conformance', { criticalNcs: 1 }, 'critical_nc'],
    ['an overdue corrective action request', { overdueScars: 2 }, 'scar_overdue'],
    ['ten percent of lines rejected', { rejectedLines: 2, deliveredLines: 20 }, 'rejections'],
  ])('increases for %s and says why', (_n, over, code) => {
    const r = level(over);
    expect(r.level).toBe('increased');
    expect(r.canReduce).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain(code);
    expect(r.reasons.every((x) => x.kind === 'raises')).toBe(true);
  });

  it('does not increase for under ten percent rejected', () => {
    expect(level({ rejectedLines: 1, deliveredLines: 20 }).level).not.toBe('increased');
  });

  it.each([
    ['not approved', { approvalStatus: 'pending_approval' }, 'not_approved'],
    ['no risk assessment', { riskRating: null }, 'unassessed'],
    ['medium risk', { riskRating: 'medium' as const }, 'risk_not_low'],
    ['a watch band', { band: 'watch' as const }, 'band_not_good'],
    ['too little data', { band: 'insufficient' as const }, 'insufficient'],
    ['too few deliveries', { deliveredLines: 3 }, 'few_deliveries'],
    ['a major non-conformance', { majorNcs: 1 }, 'major_nc'],
    ['an expired certification', { expiredCerts: 1 }, 'cert_expired'],
  ])('stays normal, and lists what blocks a reduction, for %s', (_n, over, code) => {
    const r = level(over);
    expect(r.level).toBe('normal');
    expect(r.canReduce).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain(code);
    expect(r.reasons.every((x) => x.kind === 'blocks_reduction')).toBe(true);
  });

  it('lists every condition that blocks, not only the first', () => {
    const r = level({ approvalStatus: 'pending_approval', riskRating: null, deliveredLines: 0, band: 'insufficient' });
    expect(r.reasons.map((x) => x.code)).toEqual(['not_approved', 'unassessed', 'insufficient', 'few_deliveries']);
  });

  it('puts increase before any chance of reduction', () => {
    expect(level({ riskRating: 'high', band: 'good' }).level).toBe('increased');
  });
});
