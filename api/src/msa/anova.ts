import { fSurvival } from './distributions';
import { MsaInputError } from './errors';

/**
 * Two-way crossed ANOVA with interaction for a balanced gauge R&R study, and the variance components it gives
 * (AIAG MSA 4th edition, ANOVA method; the same model Minitab's "Gage R&R Study (Crossed)" fits).
 *
 *   cube[appraiser][part][trial]      p parts, k appraisers, r trials, every cell filled
 *
 *   SS_part = k·r·Σ(part mean − grand)²      SS_appr = p·r·Σ(appraiser mean − grand)²
 *   SS_cells = r·Σ(cell mean − grand)²       SS_inter = SS_cells − SS_part − SS_appr      SS_repeat = Σ(y − cell mean)²
 *
 *   Full model variance components            Pooled model (interaction not significant: folded into repeatability)
 *     σ²repeat = MS_repeat                      σ²repeat = (SS_inter + SS_repeat) / (df_inter + df_repeat)
 *     σ²inter  = max(0, (MS_inter − MS_repeat) / r)     σ²inter = 0
 *     σ²appr   = max(0, (MS_appr − MS_inter) / (p·r))   σ²appr  = max(0, (MS_appr − MS_pooled) / (p·r))
 *     σ²part   = max(0, (MS_part − MS_inter) / (k·r))   σ²part  = max(0, (MS_part − MS_pooled) / (k·r))
 *
 * A negative estimate is set to zero and reported (`clamped`). Part and appraiser are tested against the interaction mean square in
 * the full model and against the pooled one otherwise.
 */

export type Cube = number[][][];

export interface Design {
  parts: number;
  appraisers: number;
  trials: number;
}

export interface AnovaRow {
  source: 'part' | 'appraiser' | 'interaction' | 'repeatability' | 'total';
  df: number;
  ss: number;
  ms: number | null;
  f: number | null;
  p: number | null;
}

export type ComponentName = 'repeatability' | 'appraiser' | 'interaction' | 'part';

export interface AnovaResult {
  design: Design;
  rows: AnovaRow[];
  /** Significance level the interaction was tested at. */
  alpha: number;
  interactionP: number | null;
  /** True when the interaction was significant and so kept in the model. */
  interactionKept: boolean;
  variance: Record<ComponentName, number>;
  /** Components whose estimate was negative and set to zero. */
  clamped: ComponentName[];
  cellMeans: number[][];
  appraiserMeans: number[];
  partMeans: number[];
  grandMean: number;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** Checks the shape (rectangular, at least 2 of everything) and that every reading is a finite number. */
export function readDesign(cube: Cube): Design {
  const appraisers = cube.length;
  const parts = cube[0]?.length ?? 0;
  const trials = cube[0]?.[0]?.length ?? 0;
  if (appraisers < 2 || parts < 2 || trials < 2) throw new MsaInputError('A crossed study needs at least 2 appraisers, 2 parts and 2 trials.');
  for (let a = 0; a < appraisers; a += 1) {
    if (cube[a].length !== parts) throw new MsaInputError('Every appraiser must measure the same number of parts.');
    for (let p = 0; p < parts; p += 1) {
      if (cube[a][p].length !== trials) throw new MsaInputError('Every appraiser must measure every part the same number of times.');
      for (let t = 0; t < trials; t += 1) {
        if (typeof cube[a][p][t] !== 'number' || !Number.isFinite(cube[a][p][t])) throw new MsaInputError('Every reading must be a number; a cell is empty or not numeric.');
      }
    }
  }
  return { parts, appraisers, trials };
}

export function crossedAnova(cube: Cube, alpha = 0.05): AnovaResult {
  const design = readDesign(cube);
  const { parts: p, appraisers: k, trials: r } = design;
  const n = p * k * r;

  const all = cube.flatMap((byPart) => byPart.flatMap((trials) => trials));
  // Identical readings have no spread at all; dividing their sum would leave a rounding residue that reads as variation.
  const identical = all.every((v) => v === all[0]);
  const cellMeans = cube.map((byPart) => byPart.map((trials) => (identical ? all[0] : sum(trials) / r)));
  const grandMean = identical ? all[0] : sum(all) / n;
  const appraiserMeans = cellMeans.map((row) => sum(row) / p);
  const partMeans = Array.from({ length: p }, (_, j) => sum(cellMeans.map((row) => row[j])) / k);

  const ssPart = k * r * sum(partMeans.map((m) => (m - grandMean) ** 2));
  const ssAppraiser = p * r * sum(appraiserMeans.map((m) => (m - grandMean) ** 2));
  const ssCells = r * sum(cellMeans.flatMap((row) => row.map((m) => (m - grandMean) ** 2)));
  const ssInteraction = Math.max(0, ssCells - ssPart - ssAppraiser);
  let ssRepeat = 0;
  let ssTotal = 0;
  for (let a = 0; a < k; a += 1) {
    for (let j = 0; j < p; j += 1) {
      for (let t = 0; t < r; t += 1) {
        const y = cube[a][j][t];
        ssRepeat += (y - cellMeans[a][j]) ** 2;
        ssTotal += (y - grandMean) ** 2;
      }
    }
  }

  const dfPart = p - 1;
  const dfAppraiser = k - 1;
  const dfInteraction = (p - 1) * (k - 1);
  const dfRepeat = p * k * (r - 1);
  const msPart = ssPart / dfPart;
  const msAppraiser = ssAppraiser / dfAppraiser;
  const msInteraction = ssInteraction / dfInteraction;
  const msRepeat = ssRepeat / dfRepeat;

  // F ratios: zero over zero has no ratio; anything over zero is infinitely significant.
  const ratio = (top: number, bottom: number) => (bottom > 0 ? top / bottom : top > 0 ? Infinity : null);
  const prob = (f: number | null, d1: number, d2: number) => (f === null ? null : fSurvival(f, d1, d2));

  const fInteraction = ratio(msInteraction, msRepeat);
  const pInteraction = prob(fInteraction, dfInteraction, dfRepeat);
  // Not significant (or no ratio at all) means the interaction is pooled into repeatability.
  const interactionKept = pInteraction !== null && pInteraction < alpha;

  const msPooled = (ssInteraction + ssRepeat) / (dfInteraction + dfRepeat);
  const errorMs = interactionKept ? msInteraction : msPooled;
  const errorDf = interactionKept ? dfInteraction : dfInteraction + dfRepeat;
  const fPart = ratio(msPart, errorMs);
  const fAppraiser = ratio(msAppraiser, errorMs);

  const raw = interactionKept
    ? {
        repeatability: msRepeat,
        interaction: (msInteraction - msRepeat) / r,
        appraiser: (msAppraiser - msInteraction) / (p * r),
        part: (msPart - msInteraction) / (k * r),
      }
    : {
        repeatability: msPooled,
        interaction: 0,
        appraiser: (msAppraiser - msPooled) / (p * r),
        part: (msPart - msPooled) / (k * r),
      };
  const clamped: ComponentName[] = [];
  const variance = {} as Record<ComponentName, number>;
  (Object.keys(raw) as ComponentName[]).forEach((name) => {
    if (raw[name] < 0) {
      clamped.push(name);
      variance[name] = 0;
    } else variance[name] = raw[name];
  });

  const rows: AnovaRow[] = [
    { source: 'part', df: dfPart, ss: ssPart, ms: msPart, f: fPart, p: prob(fPart, dfPart, errorDf) },
    { source: 'appraiser', df: dfAppraiser, ss: ssAppraiser, ms: msAppraiser, f: fAppraiser, p: prob(fAppraiser, dfAppraiser, errorDf) },
    { source: 'interaction', df: dfInteraction, ss: ssInteraction, ms: msInteraction, f: fInteraction, p: pInteraction },
    { source: 'repeatability', df: dfRepeat, ss: ssRepeat, ms: msRepeat, f: null, p: null },
    { source: 'total', df: n - 1, ss: ssTotal, ms: null, f: null, p: null },
  ];

  return { design, rows, alpha, interactionP: pInteraction, interactionKept, variance, clamped, cellMeans, appraiserMeans, partMeans, grandMean };
}
