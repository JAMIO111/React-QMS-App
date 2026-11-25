import { coverageState, NEEDS_ATTENTION, worstState } from './msa-coverage';

const today = '2026-11-24';
const study = (over: Partial<{ validUntil: string | null; conclusion: string | null; verdict: string | null }> = {}) => ({ validUntil: '2027-11-24', conclusion: 'accepted', verdict: 'acceptable', ...over });

describe('the coverage state of a gauge and characteristic', () => {
  it('says no readings when no gauge recorded any, and no study when there is none', () => {
    expect(coverageState(false, null, today)).toBe('no_readings');
    expect(coverageState(false, study(), today)).toBe('no_readings');
    expect(coverageState(true, null, today)).toBe('no_study');
  });
  it('follows the verdict of a study that is still valid', () => {
    expect(coverageState(true, study(), today)).toBe('acceptable');
    expect(coverageState(true, study({ verdict: 'marginal' }), today)).toBe('marginal');
    expect(coverageState(true, study({ verdict: 'unacceptable', conclusion: 'accepted_with_conditions' }), today)).toBe('not_accepted');
    expect(coverageState(true, study({ verdict: 'not_judged' }), today)).toBe('not_judged');
  });
  it('treats a conclusion of not accepted as not accepted even when the numbers were acceptable', () => {
    expect(coverageState(true, study({ conclusion: 'not_accepted' }), today)).toBe('not_accepted');
  });
  it('lets an expired study stop counting whatever it said, valid through its last day', () => {
    expect(coverageState(true, study({ validUntil: '2026-11-23' }), today)).toBe('expired');
    expect(coverageState(true, study({ validUntil: '2026-11-24' }), today)).toBe('acceptable');
    expect(coverageState(true, study({ validUntil: '2026-01-01', verdict: 'unacceptable' }), today)).toBe('expired');
  });
  it('a study with no valid-until date never expires', () => {
    expect(coverageState(true, study({ validUntil: null }), today)).toBe('acceptable');
  });
});

describe('what needs attention and the worst of several', () => {
  it('names the states that want a look', () => {
    expect(NEEDS_ATTENTION).toEqual(expect.arrayContaining(['no_study', 'expired', 'not_accepted', 'marginal']));
    expect(NEEDS_ATTENTION).not.toContain('acceptable');
    expect(NEEDS_ATTENTION).not.toContain('no_readings');
  });
  it('picks the worst state, and nothing for no states', () => {
    expect(worstState(['acceptable', 'marginal', 'no_study'])).toBe('no_study');
    expect(worstState(['acceptable', 'not_accepted', 'expired'])).toBe('not_accepted');
    expect(worstState(['acceptable'])).toBe('acceptable');
    expect(worstState(['no_readings', 'acceptable'])).toBe('no_readings');
    expect(worstState([])).toBeNull();
  });
});
