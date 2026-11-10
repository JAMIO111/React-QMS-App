import { z } from 'zod';
import { ALL_UNITS, IF_TESTS, STEP_KINDS } from './core/steps';

const text = (max: number) => z.string().max(max);
/** One step of a field row (core/steps.ts). Unknown keys are refused; the settings each kind needs are checked by stepProblems before saving. */
export const StepBody = z
  .object({
    kind: z.enum(STEP_KINDS),
    find: text(200).optional(),
    with: text(200).optional(),
    ignoreCase: z.boolean().optional(),
    characters: text(100).optional(),
    count: z.number().int().min(1).max(1000).optional(),
    separator: text(20).optional(),
    part: z.number().int().min(-50).max(50).optional(),
    text: text(500).optional(),
    decimal: z.enum(['.', ',']).optional(),
    thousands: z.enum(['', ',', '.', ' ', "'"]).optional(),
    places: z.number().int().min(0).max(10).optional(),
    by: z.number().finite().optional(),
    from: z.enum(ALL_UNITS as [string, ...string[]]).optional(),
    to: z.enum(ALL_UNITS as [string, ...string[]]).optional(),
    format: text(40).optional(),
    days: z.number().int().min(-36500).max(36500).optional(),
    values: z.record(text(200), text(200)).refine((v) => Object.keys(v).length <= 500, 'At most 500 values').optional(),
    unmatched: z.enum(['keep', 'empty', 'error']).optional(),
    test: z.enum(IF_TESTS).optional(),
    value: text(500).optional(),
    list: z.array(text(200)).max(100).optional(),
    then: text(500).optional(),
    else: text(500).nullable().optional(),
    columns: z.array(text(200)).max(20).optional(),
    parts: z
      .array(z.union([z.object({ column: text(200) }).strict(), z.object({ text: text(200) }).strict(), z.object({ current: z.literal(true) }).strict()]))
      .max(20)
      .optional(),
  })
  .strict();
export const StepsBody = z.array(StepBody).max(30);
