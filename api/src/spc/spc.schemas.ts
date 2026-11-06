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
    notes: optionalText(2000),
  })
  .strict()
  .refine((b) => !(b.firstN !== undefined && (b.from || b.to)), { message: 'Choose either a time window or the first N points' });

export const LimitsOut = z.object({
  centre: z.number(),
  ucl: z.number(),
  lcl: z.number(),
  dispersionCentre: z.number(),
  dispersionUcl: z.number(),
  dispersionLcl: z.number(),
  sigma: z.number(),
});
export const Baseline = z.object({
  id: z.string().uuid(),
  partId: z.string().uuid(),
  characteristicKey: z.string(),
  operationCode: z.string().nullable(),
  chartType: z.enum(['imr', 'xbar_r']),
  subgroupSize: z.number().int(),
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
  chartType: z.enum(['imr', 'xbar_r']).nullable(),
  subgroupSize: z.number().int().nullable(),
  unitCode: z.string().nullable(),
  readings: z.number().int(),
  lastMeasuredAt: Iso.nullable(),
  hasBaseline: z.boolean(),
});

export const Chart = z.object({
  part: z.object({ id: z.string().uuid(), partNumber: z.string(), name: z.string() }),
  characteristic: z.object({
    key: z.string(),
    name: z.string().nullable(),
    operationCode: z.string(),
    chartType: z.enum(['imr', 'xbar_r']).nullable(),
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
  /** The plan's instructions for an SPC signal: shown, never acted on automatically. */
  reactions: z.array(z.object({ action: z.string(), instruction: z.string() })),
});
export type Chart = z.infer<typeof Chart>;
