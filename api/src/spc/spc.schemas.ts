import { z } from 'zod';
import { RULES } from './spc';

const Iso = z.string().datetime({ offset: true });
const Rule = z.enum(RULES);
const optionalText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();
const Num = z.number().nullable();

export const CharacteristicsQuery = z.object({ partId: z.string().uuid() });

export const ChartQuery = z.object({
  partId: z.string().uuid(),
  characteristicKey: z.string().trim().min(1).max(60),
  /** Required when the characteristic is used in more than one operation. */
  operationCode: z.string().trim().min(1).max(40).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  machineId: z.string().uuid().optional(),
  lot: z.string().trim().min(1).max(60).optional(),
  /** Comma-separated Western Electric rules to apply (absent: all; empty: none). */
  rules: z.string().optional(),
  /** P charts only: what one point is — one inspection (default), one day or one lot. */
  subgroup: z.enum(['inspection', 'day', 'lot']).optional(),
  /** Pass/fail characteristics: show the P chart (default) or the NP chart (counts of failures in subgroups of one size). */
  display: z.enum(['p', 'np']).optional(),
  /** NP chart subgroup size: a number of checks, or 'auto' (default) for the most common size. */
  size: z.string().regex(/^(auto|[1-9]\d{0,3})$/).optional(),
});

export const BaselineQuery = z.object({
  partId: z.string().uuid(),
  characteristicKey: z.string().trim().min(1).max(60),
  operationCode: z.string().trim().min(1).max(40).optional(),
});

export const CreateBaselineBody = z
  .object({
    partId: z.string().uuid(),
    characteristicKey: z.string().trim().min(1).max(60),
    operationCode: z.string().trim().min(1).max(40),
    /** Window of data the limits are calculated from: a time range, or the first N points. Neither: all data. */
    from: Iso.optional(),
    to: Iso.optional(),
    firstN: z.number().int().min(5).max(5000).optional(),
    rules: z.array(Rule).default([...RULES]),
    /** P charts only: what one point is. */
    subgroup: z.enum(['inspection', 'day', 'lot']).default('inspection'),
    /** Pass/fail characteristics: limits from subgroups of this size only (what an NP chart shows); absent: every subgroup (P chart). */
    size: z.union([z.literal('auto'), z.number().int().min(1).max(9999)]).optional(),
    notes: optionalText(2000),
  })
  .strict()
  .refine((b) => !(b.firstN !== undefined && (b.from || b.to)), { message: 'Choose either a time window or the first N points' });

export const LimitsOut = z.object({
  centre: z.number(),
  ucl: z.number(),
  lcl: z.number(),
  /** Moving range / range limits; null for a P chart. */
  dispersionCentre: z.number().nullable(),
  dispersionUcl: z.number().nullable(),
  dispersionLcl: z.number().nullable(),
  sigma: z.number(),
});
export const Baseline = z.object({
  id: z.string().uuid(),
  partId: z.string().uuid(),
  characteristicKey: z.string(),
  operationCode: z.string().nullable(),
  chartType: z.enum(['imr', 'xbar_r', 'p', 'defects']),
  /** Null for a P chart (the size of each subgroup is whatever was checked). */
  subgroupSize: z.number().int().nullable(),
  subgroupBasis: z.enum(['inspection', 'day', 'lot']).nullable(),
  meanSubgroupSize: z.number().nullable(),
  unitCode: z.string().nullable(),
  windowFrom: Iso,
  windowTo: Iso,
  points: z.number().int(),
  provisional: z.boolean(),
  spec: z.object({ nominal: Num, lower: Num, upper: Num }),
  limits: LimitsOut,
  rules: z.array(Rule),
  notes: z.string().nullable(),
  createdAt: Iso,
  createdBy: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
  supersededAt: Iso.nullable(),
  supersededBy: z.string().uuid().nullable(),
});
export type Baseline = z.infer<typeof Baseline>;

export const CharacteristicOption = z.object({
  key: z.string(),
  name: z.string(),
  operationCode: z.string(),
  chartType: z.enum(['imr', 'xbar_r', 'p', 'defects']).nullable(),
  subgroupSize: z.number().int().nullable(),
  unitCode: z.string().nullable(),
  readings: z.number().int(),
  lastMeasuredAt: Iso.nullable(),
  hasBaseline: z.boolean(),
});

const IndicesOut = z.object({ ratio: z.number().nullable(), upper: z.number().nullable(), lower: z.number().nullable(), k: z.number().nullable() });
export const CapabilityOut = z.object({
  n: z.number().int(),
  mean: z.number(),
  sigmaWithin: z.number(),
  sigmaOverall: z.number(),
  /** Cp, Cpu, Cpl, Cpk: from the control chart's within-subgroup σ. */
  within: IndicesOut,
  /** Pp, Ppu, Ppl, Ppk: from the overall standard deviation of the readings. */
  overall: IndicesOut,
  observedPpm: z.number(),
  expectedPpm: z.number().nullable(),
  /** Readings in bins over a range that includes the specification, and the normal curve (overall σ) in the same counts. */
  histogram: z
    .object({ binWidth: z.number(), bins: z.array(z.object({ from: z.number(), to: z.number(), count: z.number().int() })), curve: z.array(z.object({ x: z.number(), y: z.number() })) })
    .nullable(),
  verdict: z.enum(['excellent', 'capable', 'marginal', 'not_capable']).nullable(),
  warnings: z.array(z.string()),
});

export const Chart = z.object({
  part: z.object({ id: z.string().uuid(), partNumber: z.string(), name: z.string() }),
  characteristic: z.object({
    key: z.string(),
    name: z.string().nullable(),
    operationCode: z.string(),
    chartType: z.enum(['imr', 'xbar_r', 'p', 'defects']).nullable(),
    subgroupSize: z.number().int().nullable(),
    unitCode: z.string().nullable(),
  }),
  /** The specification (tolerance), shown apart from the control limits. */
  spec: z.object({ nominal: Num, lower: Num, upper: Num }),
  points: z.array(
    z.object({
      index: z.number().int(),
      at: Iso,
      value: z.number(),
      dispersion: z.number().nullable(),
      readings: z.array(z.object({ id: z.string().uuid(), value: z.string(), sampleNumber: z.number().int() })),
      inspections: z.array(z.object({ id: z.string().uuid(), reference: z.string() })),
      lot: z.string().nullable(),
      machineId: z.string().uuid().nullable(),
      gaugeOverride: z.boolean(),
      /** P, NP, C and U chart points: checks (units), failures (defects for C and U), and this subgroup's own limits (null when none can be shown yet). */
      n: z.number().int().optional(),
      failed: z.number().int().optional(),
      ucl: z.number().nullable().optional(),
      lcl: z.number().nullable().optional(),
      z: z.number().nullable().optional(),
    }),
  ),
  limitsSource: z.enum(['baseline', 'trial', 'none']),
  limits: LimitsOut.nullable(),
  provisional: z.boolean(),
  rules: z.array(Rule),
  signals: z.array(z.object({ rule: Rule, text: z.string(), index: z.number().int(), involved: z.array(z.number().int()), side: z.enum(['above', 'below']) })),
  dispersionSignals: z.array(z.number().int()),
  noVariation: z.boolean(),
  warnings: z.array(z.string()),
  excluded: z.array(z.object({ reason: z.string(), text: z.string(), count: z.number().int() })),
  baseline: Baseline.nullable(),
  /** Set when a saved baseline exists but cannot be used for this chart (and why). */
  baselineIssue: z.string().nullable(),
  /** P charts: how subgroups were formed and whether the limits can be trusted. */
  subgroup: z
    .object({
      basis: z.enum(['inspection', 'day', 'lot']),
      meanSize: z.number(),
      /** Expected failures (P, NP) or defects (C, U) per subgroup. */
      expectedFailures: z.number(),
      reliable: z.boolean(),
      /** NP and C charts: the one subgroup size every point has. */
      size: z.number().int().nullable().optional(),
    })
    .nullable()
    .optional(),
  /** What is drawn: set for pass/fail and count characteristics (p, np, c, u). */
  variant: z.enum(['imr', 'xbar_r', 'p', 'np', 'c', 'u']).optional(),
  /** Cp/Cpk/Pp/Ppk of the readings shown against the specification; null for pass/fail and count charts, without a limit or with fewer than 10 readings. */
  capability: CapabilityOut.nullable().optional(),
  /** The plan's instructions for an SPC signal: shown, never acted on automatically. */
  reactions: z.array(z.object({ action: z.string(), instruction: z.string() })),
});
export type Chart = z.infer<typeof Chart>;
