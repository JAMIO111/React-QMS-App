import { ELEMENT_LINK_KINDS, grrPercentOf, judgeCapability, judgeGrr, LINK_KINDS, minimumsFor } from './ppap-links';
import { ELEMENT_TYPES } from './ppap.schemas';

const config = { minCpkInitial: 1.67, minCpkOngoing: 1.33, minReadings: 100, maxGrrPercent: 30 };
const m = minimumsFor(config);

describe('which records are evidence for which element', () => {
  it('has a row for each of the 18 elements, and the warrant takes none', () => {
    expect(Object.keys(ELEMENT_LINK_KINDS).sort()).toEqual(ELEMENT_TYPES.map((e) => e.key).sort());
    expect(ELEMENT_LINK_KINDS.part_submission_warrant).toEqual([]);
  });
  it('uses only known kinds, and every other element can take at least one', () => {
    for (const [key, kinds] of Object.entries(ELEMENT_LINK_KINDS)) {
      for (const k of kinds) expect(LINK_KINDS).toContain(k);
      if (key !== 'part_submission_warrant') expect(kinds.length).toBeGreaterThan(0);
    }
  });
  it('asks for an FMEA revision for both FMEA elements and a plan characteristic for initial studies', () => {
    expect(ELEMENT_LINK_KINDS.dfmea).toEqual(['fmea_revision']);
    expect(ELEMENT_LINK_KINDS.pfmea).toEqual(['fmea_revision']);
    expect(ELEMENT_LINK_KINDS.initial_process_studies).toEqual(['plan_characteristic']);
  });
});

describe('the agreed minimums', () => {
  it('are the organisation\'s unless the customer set their own', () => {
    expect(m).toEqual(config);
    expect(minimumsFor(config, { min_cpk_initial: '2', min_readings: 50 })).toEqual({ ...config, minCpkInitial: 2, minReadings: 50 });
  });
  it('ignore an empty or unreadable customer setting', () => {
    expect(minimumsFor(config, { min_cpk_initial: null, min_readings: '', max_grr_percent: 'abc' })).toEqual(config);
  });
});

describe('judging an initial process study', () => {
  it('passes when there are enough readings and Ppk reaches the minimum', () => {
    const j = judgeCapability({ measured: true, readings: 120, ppk: 1.85, cpk: 1.92 }, m);
    expect(j.ok).toBe(true);
    expect(j.problem).toBeNull();
    expect(j.text).toContain('Ppk 1.85 (Cpk 1.92) over 120 readings');
  });
  it('passes at exactly the minimum', () => {
    expect(judgeCapability({ measured: true, readings: 100, ppk: 1.67, cpk: null }, m).ok).toBe(true);
  });
  it('fails with a Ppk below the minimum, and says by how it was judged', () => {
    const j = judgeCapability({ measured: true, readings: 150, ppk: 1.21, cpk: 1.4 }, m);
    expect(j.ok).toBe(false);
    expect(j.problem).toBe('Ppk 1.21 is below the agreed 1.67');
  });
  it('fails with too few readings, before it looks at the index', () => {
    const j = judgeCapability({ measured: true, readings: 30, ppk: 9, cpk: 9 }, m);
    expect(j.ok).toBe(false);
    expect(j.problem).toBe('has 30 readings, and the agreed minimum is 100');
  });
  it('fails when no index could be worked out', () => {
    const j = judgeCapability({ measured: true, readings: 500, ppk: null, cpk: null }, m);
    expect(j.ok).toBe(false);
    expect(j.problem).toContain('no capability index');
  });
  it('does not judge a pass / fail check', () => {
    expect(judgeCapability({ measured: false, readings: 0, ppk: null, cpk: null }, m)).toMatchObject({ ok: true, problem: null });
  });
  it('uses the customer\'s own minimum', () => {
    const strict = minimumsFor(config, { min_cpk_initial: 2 });
    expect(judgeCapability({ measured: true, readings: 120, ppk: 1.85, cpk: 1.9 }, strict).ok).toBe(false);
  });
});

describe('judging a gauge R&R study', () => {
  it('passes at or below the agreed largest and fails above it', () => {
    expect(judgeGrr(12.4, m)).toMatchObject({ ok: true, problem: null });
    expect(judgeGrr(30, m).ok).toBe(true);
    const j = judgeGrr(34.2, m);
    expect(j.ok).toBe(false);
    expect(j.problem).toBe('%GRR 34.2 % is above the agreed 30 %');
  });
  it('does not judge a study with no %GRR figure', () => {
    expect(judgeGrr(null, m)).toMatchObject({ ok: true });
  });
  it('reads the %GRR from a stored crossed result', () => {
    expect(grrPercentOf({ variation: [{ name: 'repeatability', pctStudyVar: 9 }, { name: 'grr', pctStudyVar: 14.8 }] })).toBe(14.8);
    expect(grrPercentOf({ variation: [{ name: 'grr', pctStudyVar: null }] })).toBeNull();
    expect(grrPercentOf({ other: 1 })).toBeNull();
    expect(grrPercentOf(null)).toBeNull();
  });
});
