import { createHash } from 'node:crypto';
import { type Cube } from './anova';
import { analyseAttribute, type AttributeResult } from './attribute';
import { analyseCrossed, type GrrAnalysis } from './grr';
import { MsaInputError } from './errors';
import { analyseType1, type Type1Result } from './type1';

/**
 * The glue between the stored study and the pure statistics: what the database holds as text (so the hash matches what it works out), the
 * analysis of a study from its cells, and the reading of pasted sheets. Nothing here reads or writes anything.
 */
export type StudyType = 'grr_crossed' | 'type1' | 'attribute';

/** The design and options as the database holds them, every number as the text it stores (`numeric::text`), empty text for null. */
export interface StudyHeader {
  studyType: StudyType;
  partCount: number;
  appraiserCount: number;
  trialCount: number;
  nominal: string;
  lowerLimit: string;
  upperLimit: string;
  resolution: string;
  sigma: string;
  alpha: string;
  referenceValue: string;
  kPercent: string;
  lMultiplier: string;
}

export interface PartRow {
  position: number;
  label: string;
  /** Attribute studies: the known decision, true = accept. */
  referenceDecision: boolean | null;
}

/** One cell of the run sheet; positions start at 1. `value` is the number exactly as stored, as text. */
export interface CellRow {
  appraiser: number;
  part: number;
  trial: number;
  value: string | null;
  decision: boolean | null;
}

/**
 * The text a result is hashed from; app.msa_data_canonical (migration 20260428100000) is the definition and the database compares the hash of what it holds
 * with the one sent with the result. Lines: a header of the design and options, one line per part (P), one per cell (C) in appraiser, part, trial order.
 */
export function canonicalText(header: StudyHeader, parts: readonly PartRow[], cells: readonly CellRow[]): string {
  const head = [
    'v1', header.studyType, header.partCount, header.appraiserCount, header.trialCount, header.nominal, header.lowerLimit, header.upperLimit, header.resolution,
    header.sigma, header.alpha, header.referenceValue, header.kPercent, header.lMultiplier,
  ].join('|');
  const partLines = [...parts].sort((a, b) => a.position - b.position).map((p) => `P|${p.position}|${p.referenceDecision === true ? 'a' : p.referenceDecision === false ? 'r' : ''}`);
  const cellLines = [...cells]
    .sort((a, b) => a.appraiser - b.appraiser || a.part - b.part || a.trial - b.trial)
    .map((c) => `C|${c.appraiser}|${c.part}|${c.trial}|${c.decision !== null ? (c.decision ? 'a' : 'r') : (c.value ?? '')}`);
  return [head, ...(partLines.length ? [partLines.join('\n')] : []), ...(cellLines.length ? [cellLines.join('\n')] : [])].join('\n');
}

export const dataHash = (header: StudyHeader, parts: readonly PartRow[], cells: readonly CellRow[]): string =>
  createHash('sha256').update(canonicalText(header, parts, cells), 'utf8').digest('hex');

/** The numbers the statistics need, from the header's text. */
const num = (text: string): number | null => (text === '' ? null : Number(text));

export type StudyAnalysis =
  | { studyType: 'grr_crossed'; result: GrrAnalysis }
  | { studyType: 'type1'; result: Type1Result }
  | { studyType: 'attribute'; result: AttributeResult };

export interface AnalysisOutcome {
  /** Every cell has its reading. */
  complete: boolean;
  filled: number;
  total: number;
  /** The analysis, or null when it cannot be worked out yet (readings missing, or the data cannot be analysed: then `problem` says why). */
  analysis: StudyAnalysis | null;
  problem: string | null;
}

/**
 * The analysis of a study from its cells. A crossed or attribute study needs every cell; a Type 1 study is analysed on the readings so far (two or more).
 * Never throws for bad data: the reason comes back in `problem`.
 */
export function analyseStudy(header: StudyHeader, parts: readonly PartRow[], cells: readonly CellRow[]): AnalysisOutcome {
  const total = header.partCount * header.appraiserCount * header.trialCount;
  const filledCells = cells.filter((c) => c.value !== null || c.decision !== null);
  const filled = filledCells.length;
  const complete = filled === total && cells.length === total;
  const outcome = (analysis: StudyAnalysis | null, problem: string | null): AnalysisOutcome => ({ complete, filled, total, analysis, problem });
  try {
    if (header.studyType === 'type1') {
      const values = filledCells.sort((a, b) => a.trial - b.trial).map((c) => Number(c.value));
      if (values.length < 2) return outcome(null, 'A Type 1 study needs at least 2 readings.');
      const reference = num(header.referenceValue);
      if (reference === null) return outcome(null, 'A Type 1 study needs the reference value of the part.');
      const result = analyseType1({ values, reference, lower: num(header.lowerLimit), upper: num(header.upperLimit), k: num(header.kPercent) ?? 20, l: num(header.lMultiplier) ?? 6, resolution: num(header.resolution) });
      return outcome({ studyType: 'type1', result }, null);
    }
    if (!complete) return outcome(null, `${total - filled} of ${total} readings are still missing.`);
    if (header.studyType === 'grr_crossed') {
      const cube: Cube = Array.from({ length: header.appraiserCount }, () => Array.from({ length: header.partCount }, () => Array<number>(header.trialCount).fill(NaN)));
      for (const c of cells) cube[c.appraiser - 1][c.part - 1][c.trial - 1] = Number(c.value);
      const sigma = Number(header.sigma);
      const result = analyseCrossed(cube, { sigma: sigma === 5.15 ? 5.15 : 6, alpha: Number(header.alpha), lower: num(header.lowerLimit), upper: num(header.upperLimit), resolution: num(header.resolution) });
      return outcome({ studyType: 'grr_crossed', result }, null);
    }
    const sorted = [...parts].sort((a, b) => a.position - b.position);
    if (sorted.some((p) => p.referenceDecision === null)) return outcome(null, 'Every sample needs its reference decision.');
    const ratings: boolean[][][] = Array.from({ length: header.appraiserCount }, () => Array.from({ length: header.partCount }, () => Array<boolean>(header.trialCount).fill(false)));
    for (const c of cells) ratings[c.appraiser - 1][c.part - 1][c.trial - 1] = c.decision === true;
    const result = analyseAttribute({ standard: sorted.map((p) => p.referenceDecision === true), ratings });
    return outcome({ studyType: 'attribute', result }, null);
  } catch (error) {
    if (error instanceof MsaInputError) return outcome(null, error.message);
    throw error;
  }
}

/** What is stored when a study is completed: the analysis with its own `algorithm`, `criteria` and `verdict`, tagged with the study type. */
export const frozenResult = (analysis: StudyAnalysis): Record<string, unknown> => ({ studyType: analysis.studyType, ...analysis.result });

// ---------------------------------------------------------------------------
// Pasted sheets
// ---------------------------------------------------------------------------
export interface PasteContext {
  studyType: StudyType;
  appraisers: readonly { position: number; name: string }[];
  parts: readonly { position: number; label: string }[];
  trialCount: number;
}

export interface PastedCell {
  appraiser: number;
  part: number;
  trial: number;
  value?: string;
  decision?: boolean;
  appraiserName: string;
  partLabel: string;
  line: number;
}

export interface PasteResult {
  ok: boolean;
  cells: PastedCell[];
  problems: { line: number; message: string }[];
  rows: number;
}

const DECISIONS: Record<string, boolean> = { accept: true, a: true, good: true, pass: true, ok: true, yes: true, y: true, true: true, '1': true, reject: false, r: false, bad: false, fail: false, nok: false, no: false, n: false, false: false, '0': false };
const NUMBER = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

const splitLine = (line: string, delimiter: string) => line.split(delimiter).map((x) => x.trim().replace(/^"(.*)"$/, '$1').trim());
const detectDelimiter = (text: string): string => (text.includes('\t') ? '\t' : text.includes(';') ? ';' : ',');
const key = (s: string) => s.trim().toLowerCase();

/**
 * Turns pasted text into cells without saving anything. Two shapes are read:
 *  - with a header row naming columns: `appraiser` (name or number; optional when the study has one), `part` (label or number; optional when it has one), `trial`
 *    (optional: counted in order for each appraiser and part) and `value` (variable studies) or `decision` (attribute studies);
 *  - without a header, a single column of readings for a study with one appraiser and one part (a Type 1 study): trials 1, 2, 3 …
 * A decimal comma is read as a point unless the sheet separates with commas. Every row that cannot be placed is listed with its line number.
 */
export function parsePaste(text: string, ctx: PasteContext): PasteResult {
  const problems: { line: number; message: string }[] = [];
  const cells: PastedCell[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l, i) => ({ text: l, line: i + 1 })).filter((l) => l.text.trim() !== '');
  if (lines.length === 0) return { ok: false, cells, problems: [{ line: 1, message: 'Nothing was pasted.' }], rows: 0 };
  if (lines.length > 5000) return { ok: false, cells, problems: [{ line: 1, message: 'Paste up to 5,000 rows at a time.' }], rows: lines.length };

  const delimiter = detectDelimiter(lines[0].text);
  const attribute = ctx.studyType === 'attribute';
  const valueWord = attribute ? 'decision' : 'value';
  const first = splitLine(lines[0].text, delimiter).map(key);
  const hasHeader = first.includes('part') || first.includes('appraiser') || first.includes(valueWord) || first.includes('value') || first.includes('decision') || first.includes('trial');
  const single = ctx.appraisers.length === 1 && ctx.parts.length === 1;

  const col = (name: string) => first.indexOf(name);
  const iAppraiser = hasHeader ? col('appraiser') : -1;
  const iPart = hasHeader ? col('part') : -1;
  const iTrial = hasHeader ? col('trial') : -1;
  const iValue = hasHeader ? (col(valueWord) >= 0 ? col(valueWord) : col(attribute ? 'value' : 'decision')) : 0;
  if (hasHeader) {
    if (col(valueWord) < 0) problems.push({ line: lines[0].line, message: `The sheet needs a "${valueWord}" column.` });
    if (iAppraiser < 0 && ctx.appraisers.length > 1) problems.push({ line: lines[0].line, message: 'The sheet needs an "appraiser" column: this study has more than one appraiser.' });
    if (iPart < 0 && ctx.parts.length > 1) problems.push({ line: lines[0].line, message: `The sheet needs a "part" column: this study has ${ctx.parts.length} parts.` });
  } else if (!single) {
    problems.push({ line: lines[0].line, message: 'Without a header row only a single column of readings can be read (one appraiser and one part). Add a header with appraiser, part, trial and ' + valueWord + '.' });
  } else if (first.length > 1) {
    problems.push({ line: lines[0].line, message: 'Without a header row the sheet must be a single column of readings.' });
  }
  if (problems.length) return { ok: false, cells, problems, rows: lines.length };

  const appraiserBy = new Map<string, { position: number; name: string }>();
  for (const a of ctx.appraisers) {
    appraiserBy.set(key(a.name), a);
    appraiserBy.set(String(a.position), a);
  }
  const partBy = new Map<string, { position: number; label: string }>();
  for (const p of ctx.parts) {
    partBy.set(key(p.label), p);
    partBy.set(String(p.position), p);
  }
  const counted = new Map<string, number>();
  const seen = new Set<string>();
  const body = hasHeader ? lines.slice(1) : lines;
  for (const { text: raw, line } of body) {
    const f = splitLine(raw, delimiter);
    const appraiser = iAppraiser >= 0 ? appraiserBy.get(key(f[iAppraiser] ?? '')) : ctx.appraisers[0];
    if (!appraiser) {
      problems.push({ line, message: `Appraiser "${f[iAppraiser] ?? ''}" is not in this study.` });
      continue;
    }
    const part = iPart >= 0 ? partBy.get(key(f[iPart] ?? '')) : ctx.parts[0];
    if (!part) {
      problems.push({ line, message: `Part "${f[iPart] ?? ''}" is not in this study.` });
      continue;
    }
    const groupKey = `${appraiser.position}/${part.position}`;
    let trial: number;
    if (iTrial >= 0 && (f[iTrial] ?? '') !== '') {
      trial = Number(f[iTrial]);
      if (!Number.isInteger(trial) || trial < 1) {
        problems.push({ line, message: `Trial "${f[iTrial]}" is not a whole number from 1.` });
        continue;
      }
    } else {
      trial = (counted.get(groupKey) ?? 0) + 1;
    }
    counted.set(groupKey, Math.max(counted.get(groupKey) ?? 0, trial));
    if (trial > ctx.trialCount) {
      problems.push({ line, message: `Trial ${trial} is more than the ${ctx.trialCount} this study takes.` });
      continue;
    }
    const cellKey = `${groupKey}/${trial}`;
    if (seen.has(cellKey)) {
      problems.push({ line, message: `${appraiser.name}, ${part.label}, trial ${trial} appears twice.` });
      continue;
    }
    const raw1 = f[iValue] ?? '';
    const cell: PastedCell = { appraiser: appraiser.position, part: part.position, trial, appraiserName: appraiser.name, partLabel: part.label, line };
    if (attribute) {
      const d = DECISIONS[key(raw1)];
      if (d === undefined) {
        problems.push({ line, message: `"${raw1}" is not a decision: use accept or reject.` });
        continue;
      }
      cell.decision = d;
    } else {
      const v = delimiter === ',' ? raw1 : raw1.replace(',', '.');
      if (!NUMBER.test(v) || Math.abs(Number(v)) >= 1e12) {
        problems.push({ line, message: `"${raw1}" is not a number.` });
        continue;
      }
      cell.value = v;
    }
    seen.add(cellKey);
    cells.push(cell);
  }
  return { ok: problems.length === 0 && cells.length > 0, cells, problems, rows: body.length };
}
