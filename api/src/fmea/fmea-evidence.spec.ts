import { EXAMPLES_PER_GROUP, EvidenceMode, LOW_OCCURRENCE, modeEvidence, NcCount, NcExample, notForeseen, SEEN_AT_LEAST } from './fmea-evidence';

const mode = (id: string, over: Partial<EvidenceMode> = {}): EvidenceMode => ({ id, text: `Mode ${id}`, itemName: 'Bracket', ncFailureModeId: null, occurrences: [], ...over });
const count = (id: string, total: number, inScope: number, over: Partial<NcCount> = {}): NcCount => ({ ncFailureModeId: id, name: `NC ${id}`, total, inScope, latestOn: '2026-11-01', ...over });
const example = (id: string, mode: string, on: string): NcExample => ({ id, reference: `NC-${id}`, title: `Title ${id}`, detectedOn: on, ncFailureModeId: mode });

describe('modeEvidence', () => {
  it('says nothing about a failure mode that is tied to nothing', () => {
    const [e] = modeEvidence([mode('a', { occurrences: [4] })], [count('x', 9, 9)], true);
    expect(e).toMatchObject({ tied: false, flag: 'untied', count: null, total: null, ncFailureModeName: null, maxOccurrence: 4 });
  });

  it('counts the ones in scope when the FMEA has a scope, and keeps the total beside it', () => {
    const [e] = modeEvidence([mode('a', { ncFailureModeId: 'x', occurrences: [6] })], [count('x', 20, 4)], true);
    expect(e).toMatchObject({ tied: true, count: 4, inScope: 4, total: 20, flag: 'seen', ncFailureModeName: 'NC x', latestOn: '2026-11-01' });
  });

  it('counts all of them, and has no in-scope figure, when the FMEA has no scope', () => {
    const [e] = modeEvidence([mode('a', { ncFailureModeId: 'x', occurrences: [6] })], [count('x', 20, 20)], false);
    expect(e).toMatchObject({ count: 20, total: 20, inScope: null });
  });

  it('is none seen, not unknown, when the failure mode is tied but nothing was raised', () => {
    const [e] = modeEvidence([mode('a', { ncFailureModeId: 'x', occurrences: [2] })], [], true);
    expect(e).toMatchObject({ tied: true, count: 0, total: 0, flag: 'none_seen', ncFailureModeName: null });
  });

  it('is none seen when only others in the register happened in scope', () => {
    const [e] = modeEvidence([mode('a', { ncFailureModeId: 'x' })], [count('x', 7, 0)], true);
    expect(e.flag).toBe('none_seen');
    expect(e.total).toBe(7);
  });

  it('flags a low occurrence rating against enough non-conformances, with the highest rating of its causes', () => {
    const [low] = modeEvidence([mode('a', { ncFailureModeId: 'x', occurrences: [1, LOW_OCCURRENCE] })], [count('x', SEEN_AT_LEAST, SEEN_AT_LEAST)], true);
    expect(low.flag).toBe('seen_but_rated_low');
    const [high] = modeEvidence([mode('a', { ncFailureModeId: 'x', occurrences: [1, LOW_OCCURRENCE + 1] })], [count('x', 50, 50)], true);
    expect(high.flag).toBe('seen');
    expect(high.maxOccurrence).toBe(LOW_OCCURRENCE + 1);
  });

  it('does not flag too few non-conformances, or a cause that has no rating yet', () => {
    expect(modeEvidence([mode('a', { ncFailureModeId: 'x', occurrences: [1] })], [count('x', SEEN_AT_LEAST - 1, SEEN_AT_LEAST - 1)], true)[0].flag).toBe('seen');
    const [unrated] = modeEvidence([mode('a', { ncFailureModeId: 'x', occurrences: [] })], [count('x', 30, 30)], true);
    expect(unrated).toMatchObject({ flag: 'seen', maxOccurrence: null });
  });

  it('keeps the order of the failure modes it is given', () => {
    expect(modeEvidence([mode('b'), mode('a')], [], true).map((e) => e.id)).toEqual(['b', 'a']);
  });
});

describe('notForeseen', () => {
  it('lists what happened in scope and is tied to nothing in the analysis, most frequent first', () => {
    const counts = [count('tied', 5, 5), count('rare', 9, 1), count('common', 9, 6), count('elsewhere', 12, 0)];
    const out = notForeseen(counts, new Set(['tied']), []);
    expect(out.map((g) => g.ncFailureModeId)).toEqual(['common', 'rare']);
    expect(out[0]).toMatchObject({ count: 6, name: 'NC common' });
  });

  it('breaks a tie by the newest, then the name', () => {
    const out = notForeseen([count('b', 1, 2, { latestOn: '2026-10-01' }), count('a', 1, 2, { latestOn: '2026-11-01' }), count('c', 1, 2, { latestOn: '2026-11-01' })], new Set(), []);
    expect(out.map((g) => g.ncFailureModeId)).toEqual(['a', 'c', 'b']);
  });

  it('gives the newest few examples of each, never another failure mode\'s', () => {
    const many = Array.from({ length: EXAMPLES_PER_GROUP + 3 }, (_, i) => example(`n${i}`, 'x', `2026-0${(i % 9) + 1}-15`));
    const out = notForeseen([count('x', 20, 20), count('y', 2, 2)], new Set(), [...many, example('other', 'y', '2026-08-01')]);
    const x = out.find((g) => g.ncFailureModeId === 'x')!;
    expect(x.examples).toHaveLength(EXAMPLES_PER_GROUP);
    expect(x.examples.every((e) => e.ncFailureModeId === 'x')).toBe(true);
    expect([...x.examples].map((e) => e.detectedOn)).toEqual([...x.examples.map((e) => e.detectedOn)].sort().reverse());
    expect(out.find((g) => g.ncFailureModeId === 'y')!.examples.map((e) => e.id)).toEqual(['other']);
  });

  it('is empty when everything that happened is foreseen', () => {
    expect(notForeseen([count('x', 4, 4)], new Set(['x']), [])).toEqual([]);
  });
});
