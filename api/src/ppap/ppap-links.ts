/**
 * PPAP evidence links (PP2): which records can be evidence for which of the 18 elements, and the two judgements that are statistics rather than status and so are worked out here,
 * not in the database: whether a process capability study meets the agreed minimum (Ppk and the number of readings) and whether a gauge R&R is small enough. Pure functions, no
 * database, so every rule has a unit test. The element and kind lists mirror `app.ppap_link_kinds` and the evidence table's check; ppap.e2e-spec.ts fails when they differ.
 */

export const LINK_KINDS = [
  'part_revision', 'control_plan_revision', 'fmea_revision', 'change_request', 'inspection', 'msa_study', 'material_certificate', 'calibration', 'document_revision', 'gauge', 'plan_characteristic',
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** Plain wording for each kind of record (the screen's "Link a …"). */
export const LINK_KIND_LABEL: Record<LinkKind, string> = {
  part_revision: 'part revision',
  control_plan_revision: 'control plan revision',
  fmea_revision: 'FMEA revision',
  change_request: 'change',
  inspection: 'inspection',
  msa_study: 'gauge R&R study',
  material_certificate: 'material certificate',
  calibration: 'calibration',
  document_revision: 'document',
  gauge: 'gauge',
  plan_characteristic: 'control plan characteristic',
};

/** Which records are evidence for which element (the same table as app.ppap_link_kinds). The warrant is made, not linked. */
export const ELEMENT_LINK_KINDS: Record<string, readonly LinkKind[]> = {
  design_records: ['part_revision', 'document_revision'],
  engineering_change_documents: ['change_request', 'document_revision'],
  customer_engineering_approval: ['change_request'],
  dfmea: ['fmea_revision'],
  process_flow_diagram: ['control_plan_revision', 'document_revision'],
  pfmea: ['fmea_revision'],
  control_plan: ['control_plan_revision'],
  msa_studies: ['msa_study'],
  dimensional_results: ['inspection'],
  material_performance_tests: ['material_certificate', 'document_revision'],
  initial_process_studies: ['plan_characteristic'],
  laboratory_documentation: ['calibration', 'document_revision'],
  appearance_approval_report: ['document_revision'],
  sample_production_parts: ['document_revision'],
  master_sample: ['document_revision'],
  checking_aids: ['gauge', 'document_revision'],
  customer_specific_requirements: ['document_revision'],
  part_submission_warrant: [],
};

export interface Minimums {
  minCpkInitial: number;
  minCpkOngoing: number;
  minReadings: number;
  maxGrrPercent: number;
}

interface RuleLike {
  min_cpk_initial?: unknown;
  min_cpk_ongoing?: unknown;
  min_readings?: unknown;
  max_grr_percent?: unknown;
}

const orElse = (own: unknown, fallback: number) => (own == null || own === '' || Number.isNaN(Number(own)) ? fallback : Number(own));

/** The agreed minimums for a submission: the customer's own where they set one, else the organisation's requirement set. */
export function minimumsFor(config: { minCpkInitial: number; minCpkOngoing: number; minReadings: number; maxGrrPercent: number }, rules?: RuleLike | null): Minimums {
  return {
    minCpkInitial: orElse(rules?.min_cpk_initial, config.minCpkInitial),
    minCpkOngoing: orElse(rules?.min_cpk_ongoing, config.minCpkOngoing),
    minReadings: orElse(rules?.min_readings, config.minReadings),
    maxGrrPercent: orElse(rules?.max_grr_percent, config.maxGrrPercent),
  };
}

export interface StudyJudgement {
  /** True when nothing is wrong (including "this does not apply"). */
  ok: boolean;
  /** What was checked and what it found, in words. */
  text: string;
  /** Why it is not in good standing, or null. */
  problem: string | null;
}

const two = (n: number) => n.toFixed(2);

export interface CapabilityInput {
  /** A measured (variable) characteristic; a pass / fail or count one has no capability index. */
  measured: boolean;
  /** How many readings the study holds. */
  readings: number;
  /** The overall (Ppk) and within (Cpk) indices from the control chart, or null when they could not be worked out. */
  ppk: number | null;
  cpk: number | null;
}

/**
 * An initial process study: the readings are enough and the overall index (Ppk, the long-run figure an initial study is judged on) reaches the agreed minimum. A pass / fail check
 * has no index and is not judged. The Cpk is reported beside it.
 */
export function judgeCapability(i: CapabilityInput, m: Minimums): StudyJudgement {
  if (!i.measured) return { ok: true, text: 'A pass / fail check has no capability index, so none is judged', problem: null };
  if (i.readings < m.minReadings) {
    return { ok: false, text: `${i.readings} readings; the agreed minimum is ${m.minReadings}`, problem: `has ${i.readings} readings, and the agreed minimum is ${m.minReadings}` };
  }
  if (i.ppk === null) {
    return { ok: false, text: 'No capability index could be worked out', problem: 'has no capability index (it needs a limit and readings that vary)' };
  }
  const cpk = i.cpk === null ? '' : ` (Cpk ${two(i.cpk)})`;
  if (i.ppk < m.minCpkInitial) {
    return { ok: false, text: `Ppk ${two(i.ppk)}${cpk} over ${i.readings} readings; the agreed minimum is ${two(m.minCpkInitial)}`, problem: `Ppk ${two(i.ppk)} is below the agreed ${two(m.minCpkInitial)}` };
  }
  return { ok: true, text: `Ppk ${two(i.ppk)}${cpk} over ${i.readings} readings; the agreed minimum is ${two(m.minCpkInitial)}`, problem: null };
}

/**
 * A gauge R&R study: the share of the study variation the gauge takes up (the crossed study's %GRR) is no more than the agreed largest. A study of another kind (a type 1
 * study, an attribute study) has no such figure and is not judged here: its own verdict is judged by the database.
 */
export function judgeGrr(pctStudyVar: number | null, m: Minimums): StudyJudgement {
  if (pctStudyVar === null || !Number.isFinite(pctStudyVar)) return { ok: true, text: 'This study has no %GRR figure, so none is judged', problem: null };
  const pct = `${pctStudyVar.toFixed(1)} %`;
  if (pctStudyVar > m.maxGrrPercent) return { ok: false, text: `%GRR ${pct}; the agreed largest is ${m.maxGrrPercent} %`, problem: `%GRR ${pct} is above the agreed ${m.maxGrrPercent} %` };
  return { ok: true, text: `%GRR ${pct}; the agreed largest is ${m.maxGrrPercent} %`, problem: null };
}

/** The %GRR (percent of study variation) from a stored crossed-study result, or null when the result has no such row. */
export function grrPercentOf(result: unknown): number | null {
  const rows = (result as { variation?: { name?: string; pctStudyVar?: number | null }[] } | null)?.variation;
  const row = Array.isArray(rows) ? rows.find((r) => r?.name === 'grr') : undefined;
  return typeof row?.pctStudyVar === 'number' ? row.pctStudyVar : null;
}
