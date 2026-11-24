import { AIAG_GRR_CUBE } from './reference/aiag-example';
import { analyseStudy, canonicalText, dataHash, frozenResult, parsePaste, type CellRow, type PartRow, type StudyHeader } from './msa-data';

const header = (over: Partial<StudyHeader> = {}): StudyHeader => ({
  studyType: 'grr_crossed', partCount: 10, appraiserCount: 3, trialCount: 3, nominal: '', lowerLimit: '', upperLimit: '', resolution: '', sigma: '6.00', alpha: '0.05', referenceValue: '', kPercent: '20.00', lMultiplier: '6.00', ...over,
});
const parts = (n: number): PartRow[] => Array.from({ length: n }, (_, i) => ({ position: i + 1, label: `Part ${i + 1}`, referenceDecision: null }));
const aiagCells = (): CellRow[] => {
  const cells: CellRow[] = [];
  AIAG_GRR_CUBE.forEach((byPart, a) => byPart.forEach((trials, p) => trials.forEach((v, t) => cells.push({ appraiser: a + 1, part: p + 1, trial: t + 1, value: String(v), decision: null }))));
  return cells;
};

describe('the canonical text the database hashes', () => {
  it('has one header line, one line per part and one per cell in appraiser, part, trial order', () => {
    const cells: CellRow[] = [
      { appraiser: 2, part: 1, trial: 1, value: '5.10', decision: null },
      { appraiser: 1, part: 2, trial: 1, value: '4.9', decision: null },
      { appraiser: 1, part: 1, trial: 1, value: '5.000', decision: null },
    ];
    const text = canonicalText(header({ partCount: 2, appraiserCount: 2, trialCount: 1, lowerLimit: '4.5' }), [{ position: 2, label: 'b', referenceDecision: false }, { position: 1, label: 'a', referenceDecision: true }], cells);
    expect(text).toBe(['v1|grr_crossed|2|2|1||4.5|||6.00|0.05||20.00|6.00', 'P|1|a', 'P|2|r', 'C|1|1|1|5.000', 'C|1|2|1|4.9', 'C|2|1|1|5.10'].join('\n'));
  });
  it('keeps numbers exactly as written, writes decisions as a / r and empty cells as nothing', () => {
    const text = canonicalText(header({ studyType: 'attribute' }), parts(1), [
      { appraiser: 1, part: 1, trial: 1, value: null, decision: true },
      { appraiser: 1, part: 1, trial: 2, value: null, decision: false },
      { appraiser: 1, part: 1, trial: 3, value: null, decision: null },
    ]);
    expect(text.split('\n').slice(-3)).toEqual(['C|1|1|1|a', 'C|1|1|2|r', 'C|1|1|3|']);
  });
  it('changes the hash when a reading, a limit or a reference decision changes, and not when the order of the rows does', () => {
    const base = dataHash(header(), parts(10), aiagCells());
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(dataHash(header(), parts(10), [...aiagCells()].reverse())).toBe(base);
    const edited = aiagCells();
    edited[0] = { ...edited[0], value: '0.65000001' };
    expect(dataHash(header(), parts(10), edited)).not.toBe(base);
    expect(dataHash(header({ upperLimit: '1' }), parts(10), aiagCells())).not.toBe(base);
    expect(dataHash(header({ sigma: '5.15' }), parts(10), aiagCells())).not.toBe(base);
    const decided = parts(10).map((p, i) => (i === 0 ? { ...p, referenceDecision: true } : p));
    expect(dataHash(header(), decided, aiagCells())).not.toBe(base);
  });
});

describe('analysing a stored study', () => {
  it('a complete crossed study gives the AIAG example result and a frozen shape the database accepts', () => {
    const out = analyseStudy(header(), parts(10), aiagCells());
    expect(out).toMatchObject({ complete: true, filled: 90, total: 90, problem: null });
    expect(out.analysis?.studyType).toBe('grr_crossed');
    const frozen = frozenResult(out.analysis!);
    expect(frozen).toMatchObject({ studyType: 'grr_crossed', algorithm: 'msa-1', criteria: 'aiag-msa-4' });
    expect((frozen.verdict as { band: string | null }).band).toBeDefined();
    // JSON survives a round trip unchanged: what is stored equals what is recomputed
    expect(JSON.parse(JSON.stringify(frozen))).toEqual(JSON.parse(JSON.stringify(frozenResult(analyseStudy(header(), parts(10), aiagCells()).analysis!))));
  });
  it('a crossed study with a missing reading is not analysed, and says how many are missing', () => {
    const cells = aiagCells();
    cells[3] = { ...cells[3], value: null };
    const out = analyseStudy(header(), parts(10), cells);
    expect(out).toMatchObject({ complete: false, filled: 89, analysis: null, problem: '1 of 90 readings are still missing.' });
  });
  it('a Type 1 study is analysed on the readings so far, and needs the reference value', () => {
    const h = header({ studyType: 'type1', partCount: 1, appraiserCount: 1, trialCount: 25, referenceValue: '10.000', lowerLimit: '9.9', upperLimit: '10.1' });
    const cells: CellRow[] = Array.from({ length: 25 }, (_, i) => ({ appraiser: 1, part: 1, trial: i + 1, value: i < 10 ? String(10 + (i % 3) * 0.001) : null, decision: null }));
    const out = analyseStudy(h, parts(1), cells);
    expect(out).toMatchObject({ complete: false, filled: 10, problem: null });
    expect(out.analysis?.studyType).toBe('type1');
    expect(analyseStudy({ ...h, referenceValue: '' }, parts(1), cells)).toMatchObject({ analysis: null, problem: 'A Type 1 study needs the reference value of the part.' });
    expect(analyseStudy(h, parts(1), cells.map((c) => ({ ...c, value: null })))).toMatchObject({ analysis: null, problem: 'A Type 1 study needs at least 2 readings.' });
  });
  it('an attribute study needs its reference decisions and every decision', () => {
    const h = header({ studyType: 'attribute', partCount: 4, appraiserCount: 2, trialCount: 2 });
    const ps: PartRow[] = [true, false, true, false].map((d, i) => ({ position: i + 1, label: `S${i + 1}`, referenceDecision: d }));
    const cells: CellRow[] = [];
    for (let a = 1; a <= 2; a += 1) for (let p = 1; p <= 4; p += 1) for (let t = 1; t <= 2; t += 1) cells.push({ appraiser: a, part: p, trial: t, value: null, decision: ps[p - 1].referenceDecision });
    const out = analyseStudy(h, ps, cells);
    expect(out.analysis?.studyType).toBe('attribute');
    expect(frozenResult(out.analysis!)).toMatchObject({ studyType: 'attribute', verdict: { band: 'acceptable' } });
    expect(analyseStudy(h, ps.map((p, i) => (i === 0 ? { ...p, referenceDecision: null } : p)), cells)).toMatchObject({ analysis: null, problem: 'Every sample needs its reference decision.' });
  });
});

describe('reading a pasted sheet', () => {
  const ctx = {
    studyType: 'grr_crossed' as const,
    appraisers: [{ position: 1, name: 'Ada' }, { position: 2, name: 'Visitor' }],
    parts: [{ position: 1, label: 'P1' }, { position: 2, label: 'P2' }],
    trialCount: 2,
  };
  it('reads a long sheet with a header, by name or by number, counting trials in order when there is no trial column', () => {
    const r = parsePaste('appraiser\tpart\tvalue\nAda\tP1\t10.01\nAda\tP1\t10.02\n2\t2\t9.5\n', ctx);
    expect(r.ok).toBe(true);
    expect(r.cells.map((c) => [c.appraiser, c.part, c.trial, c.value])).toEqual([[1, 1, 1, '10.01'], [1, 1, 2, '10.02'], [2, 2, 1, '9.5']]);
    expect(r.cells[2]).toMatchObject({ appraiserName: 'Visitor', partLabel: 'P2', line: 4 });
  });
  it('reads semicolons and decimal commas, and commas as separators', () => {
    expect(parsePaste('appraiser;part;trial;value\nAda;P1;1;10,25', ctx).cells[0].value).toBe('10.25');
    expect(parsePaste('appraiser,part,trial,value\nAda,P1,2,10.25', ctx).cells[0]).toMatchObject({ trial: 2, value: '10.25' });
  });
  it('lists every row it cannot place, with its line, and places the rest', () => {
    const r = parsePaste('appraiser,part,trial,value\nNobody,P1,1,1\nAda,P9,1,1\nAda,P1,3,1\nAda,P1,1,abc\nAda,P1,1,10\nAda,P1,1,11\nAda,P2,0,5', ctx);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.line)).toEqual([2, 3, 4, 5, 7, 8]);
    expect(r.problems[0].message).toBe('Appraiser "Nobody" is not in this study.');
    expect(r.problems[1].message).toBe('Part "P9" is not in this study.');
    expect(r.problems[2].message).toBe('Trial 3 is more than the 2 this study takes.');
    expect(r.problems[3].message).toBe('"abc" is not a number.');
    expect(r.problems[4].message).toBe('Ada, P1, trial 1 appears twice.');
    expect(r.cells).toHaveLength(1);
  });
  it('needs the columns the study cannot do without', () => {
    expect(parsePaste('part,value\nP1,1', ctx).problems[0].message).toMatch(/needs an "appraiser" column/);
    expect(parsePaste('appraiser,value\nAda,1', ctx).problems[0].message).toMatch(/needs a "part" column/);
    expect(parsePaste('appraiser,part\nAda,P1', ctx).problems[0].message).toMatch(/needs a "value" column/);
    expect(parsePaste('', ctx).problems[0].message).toBe('Nothing was pasted.');
    expect(parsePaste('10\n11', ctx).problems[0].message).toMatch(/Without a header row only a single column/);
  });
  it('reads a bare column of readings for a one-appraiser, one-part study (Type 1)', () => {
    const one = { studyType: 'type1' as const, appraisers: [{ position: 1, name: 'Appraiser 1' }], parts: [{ position: 1, label: 'Reference part' }], trialCount: 25 };
    const r = parsePaste('10.001\n10.002\n9.999\n', one);
    expect(r.ok).toBe(true);
    expect(r.cells.map((c) => [c.trial, c.value])).toEqual([[1, '10.001'], [2, '10.002'], [3, '9.999']]);
    expect(parsePaste(Array.from({ length: 26 }, () => '1').join('\n'), one).problems[0].message).toBe('Trial 26 is more than the 25 this study takes.');
  });
  it('reads decisions for an attribute study in several spellings', () => {
    const attr = { studyType: 'attribute' as const, appraisers: [{ position: 1, name: 'Ada' }], parts: [{ position: 1, label: 'S1' }, { position: 2, label: 'S2' }], trialCount: 2 };
    const r = parsePaste('part,trial,decision\nS1,1,Accept\nS1,2,reject\nS2,1,pass\nS2,2,NOK\nS2,3,maybe', attr);
    expect(r.cells.map((c) => c.decision)).toEqual([true, false, true, false]);
    expect(r.problems.map((p) => p.message)).toEqual(['Trial 3 is more than the 2 this study takes.']);
    expect(parsePaste('part,trial,decision\nS1,1,maybe', attr).problems[0].message).toBe('"maybe" is not a decision: use accept or reject.');
  });
});
