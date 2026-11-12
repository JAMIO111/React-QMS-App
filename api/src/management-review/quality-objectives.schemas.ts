import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The fixed list of measures (RM12): typed in by hand, or worked out by the system from the module's own records. */
export const MEASURES = ['manual', 'ncr_count', 'supplier_ppm', 'capa_on_time', 'audit_pass_rate'] as const;
export type Measure = (typeof MEASURES)[number];
export const FREQUENCIES = ['monthly', 'quarterly', 'yearly'] as const;
export const DIRECTIONS = ['at_least', 'at_most'] as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
const target = z.number().finite().gt(-1e12).lt(1e12);

export const CreateObjectiveBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: optionalText(2000),
    ownerId: z.string().uuid().optional(),
    measure: z.enum(MEASURES).default('manual'),
    unit: optionalText(20),
    direction: z.enum(DIRECTIONS).optional(),
    target,
    frequency: z.enum(FREQUENCIES).default('monthly'),
    /** Any day: the period it falls in becomes the first one (default: the current period). */
    startsOn: isoDate.optional(),
  })
  .strict();
export type CreateObjectiveBody = z.infer<typeof CreateObjectiveBody>;

export const UpdateObjectiveBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: optionalText(2000),
    ownerId: z.string().uuid().optional(),
    unit: optionalText(20),
    direction: z.enum(DIRECTIONS).optional(),
    target: target.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type UpdateObjectiveBody = z.infer<typeof UpdateObjectiveBody>;

export const RecordValueBody = z
  .object({
    /** Any day in the period. */
    periodStart: isoDate,
    value: z.number().finite().gt(-1e12).lt(1e12),
    note: optionalText(1000),
  })
  .strict();
export type RecordValueBody = z.infer<typeof RecordValueBody>;

export const ObjectiveListQuery = z.object({ all: z.enum(['true', 'false']).optional() });
export const ObjectiveQuery = z.object({ periods: z.coerce.number().int().min(1).max(60).default(12) });
