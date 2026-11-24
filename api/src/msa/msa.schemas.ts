import { z } from 'zod';

export const STUDY_TYPES = ['grr_crossed', 'type1', 'attribute'] as const;
export const STATUSES = ['draft', 'collecting', 'completed', 'cancelled'] as const;
export const CONCLUSIONS = ['accepted', 'accepted_with_conditions', 'not_accepted'] as const;
export const VERDICTS = ['acceptable', 'marginal', 'unacceptable', 'not_judged'] as const;
export const VALIDITIES = ['valid', 'expiring', 'expired'] as const;
export const STUDY_SORTS = ['reference', 'type', 'gauge', 'characteristic', 'status', 'verdict', 'validUntil', 'createdAt', 'completedAt'] as const;

const csv = (allowed: readonly string[]) => z.string().refine((v) => v.split(',').every((x) => allowed.includes(x)), 'Use a comma-separated list of known values');
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const NUMBER_TEXT = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

/** A number as a JSON number, or as text when the digits must be kept exactly as typed ("10.250"). */
export const NumberLike = z.union([z.number().finite().gt(-1e12).lt(1e12), z.string().trim().regex(NUMBER_TEXT, 'Give a number')]);
const optionalNumber = NumberLike.nullable().optional();
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const Appraiser = z.object({ employeeId: z.string().uuid().optional(), name: z.string().trim().max(100).optional() }).strict();
export const PartInput = z.object({ label: z.string().trim().max(60).optional(), referenceDecision: z.boolean().nullable().optional() }).strict();

const design = {
  partId: z.string().uuid().nullable().optional(),
  characteristicKey: optionalText(100),
  operationCode: optionalText(40),
  characteristicName: z.string().trim().min(1).max(200).optional(),
  unitCode: optionalText(20),
  nominal: optionalNumber,
  lowerLimit: optionalNumber,
  upperLimit: optionalNumber,
  partCount: z.number().int().min(1).max(200).optional(),
  appraiserCount: z.number().int().min(1).max(10).optional(),
  trialCount: z.number().int().min(1).max(500).optional(),
  sigmaMultiplier: z.union([z.literal(6), z.literal(5.15)]).optional(),
  interactionAlpha: z.union([z.literal(0.05), z.literal(0.25)]).optional(),
  referenceValue: optionalNumber,
  kPercent: z.number().gt(0).max(100).optional(),
  lMultiplier: z.number().gt(0).max(10).optional(),
  appraisers: z.array(Appraiser).min(1).max(10).optional(),
  parts: z.array(PartInput).min(1).max(200).optional(),
};

/**
 * A new study. With a part and a characteristic key and no name, limits or unit, those come from the part's released revision. Anything not given gets the
 * usual design for the type (10 parts x 3 appraisers x 3 trials; 30 samples; one part measured 25 times).
 */
export const CreateStudyBody = z.object({ studyType: z.enum(STUDY_TYPES), gaugeId: z.string().uuid(), ...design }).strict();
export type CreateStudyBody = z.infer<typeof CreateStudyBody>;

/** The design of a draft study: any of the design keys; absent keys keep what is there, null clears an optional one. */
export const DesignBody = z.object(design).strict();
export type DesignBody = z.infer<typeof DesignBody>;

export const ReadingCell = z
  .object({
    appraiser: z.number().int().min(1).max(10),
    part: z.number().int().min(1).max(200),
    trial: z.number().int().min(1).max(500),
    value: NumberLike.optional(),
    decision: z.boolean().optional(),
  })
  .strict();
export const RecordBody = z.object({ cells: z.array(ReadingCell).min(1).max(5000), source: z.enum(['grid', 'paste']).default('grid') }).strict();
export type RecordBody = z.infer<typeof RecordBody>;

export const ParseBody = z.object({ text: z.string().min(1).max(2_000_000) }).strict();
export type ParseBody = z.infer<typeof ParseBody>;

export const CompleteBody = z
  .object({ conclusion: z.enum(CONCLUSIONS), note: z.string().trim().min(3).max(2000), validUntil: DateOnly.optional() })
  .strict();
export type CompleteBody = z.infer<typeof CompleteBody>;

export const CancelBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export type CancelBody = z.infer<typeof CancelBody>;

export const ListQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  /** Comma-separated statuses, `open` (draft and collecting) or `all` (the default: everything but cancelled studies). */
  status: csv(['open', 'all', ...STATUSES]).default('all'),
  type: csv(STUDY_TYPES).optional(),
  gaugeId: z.string().uuid().optional(),
  partId: z.string().uuid().optional(),
  verdict: csv(VERDICTS).optional(),
  valid: csv(VALIDITIES).optional(),
  sort: z.enum(STUDY_SORTS).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListQuery = z.infer<typeof ListQuery>;
