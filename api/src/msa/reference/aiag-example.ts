/**
 * The worked gauge R&R example from the AIAG Measurement Systems Analysis manual (4th edition): 10 parts, 3 appraisers, 3 trials
 * (also shipped as Minitab's GAGEAIAG sample). Indexed [appraiser][part][trial].
 *
 * The values were transcribed into this repository, and the transcription is itself verified: grr.spec.ts requires the published
 * results of the manual (EV, AV, GRR, PV, TV, %GRR and ndc by the average-and-range method; the ANOVA table and the 27.86% ANOVA
 * study-variation figure) to come out of it, which a mistyped reading would not allow.
 */
const byTrial: Record<'A' | 'B' | 'C', number[][]> = {
  A: [
    [0.29, -0.56, 1.34, 0.47, -0.8, 0.02, 0.59, -0.31, 2.26, -1.36],
    [0.41, -0.68, 1.17, 0.5, -0.92, -0.11, 0.75, -0.2, 1.99, -1.25],
    [0.64, -0.58, 1.27, 0.64, -0.84, -0.21, 0.66, -0.17, 2.01, -1.31],
  ],
  B: [
    [0.08, -0.47, 1.19, 0.01, -0.56, -0.2, 0.47, -0.63, 1.8, -1.68],
    [0.25, -1.22, 0.94, 1.03, -1.2, 0.22, 0.55, 0.08, 2.12, -1.62],
    [0.07, -0.68, 1.34, 0.2, -1.28, 0.06, 0.83, -0.34, 2.19, -1.5],
  ],
  C: [
    [0.04, -1.38, 0.88, 0.14, -1.46, -0.29, 0.02, -0.46, 1.77, -1.49],
    [-0.11, -1.13, 1.09, 0.2, -1.07, -0.67, 0.01, -0.56, 1.45, -1.77],
    [-0.15, -0.96, 0.67, 0.11, -1.45, -0.49, 0.21, -0.49, 1.87, -2.16],
  ],
};

/** [appraiser][part][trial] */
export const AIAG_GRR_CUBE: number[][][] = (['A', 'B', 'C'] as const).map((a) => byTrial[a][0].map((_, part) => byTrial[a].map((trial) => trial[part])));
