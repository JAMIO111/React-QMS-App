import { z } from 'zod';
import { DATA_SECTIONS } from './review-inputs';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const DECISION_CATEGORIES = ['improvement', 'resources', 'qms_change', 'other'] as const;
export const REVIEW_STATUSES = ['planned', 'in_progress', 'completed', 'cancelled'] as const;

export const PlanReviewBody = z
  .object({ title: z.string().trim().min(1).max(200), periodFrom: isoDate, periodTo: isoDate, plannedOn: isoDate.nullable().optional(), chairId: z.string().uuid().optional() })
  .strict();
export type PlanReviewBody = z.infer<typeof PlanReviewBody>;

export const UpdateReviewBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    periodFrom: isoDate.optional(),
    periodTo: isoDate.optional(),
    plannedOn: isoDate.nullable().optional(),
    heldOn: isoDate.optional(),
    chairId: z.string().uuid().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type UpdateReviewBody = z.infer<typeof UpdateReviewBody>;

export const ReviewListQuery = z.object({ status: z.string().optional() });
export const GatherBody = z.object({ sections: z.array(z.enum(DATA_SECTIONS)).min(1).max(DATA_SECTIONS.length).optional() }).strict();
export const InputBody = z.object({ commentary: optionalText(8000), reviewed: z.boolean() }).strict();
export const AttendeesBody = z
  .object({
    attendees: z
      .array(
        z
          .object({ userId: z.string().uuid().optional(), name: z.string().trim().min(1).max(120).optional(), role: optionalText(100), attendance: z.enum(['invited', 'present', 'apologies']).default('invited') })
          .strict()
          .refine((a) => !!a.userId !== !!a.name, { message: 'An attendee is a member or a name' }),
      )
      .max(100),
  })
  .strict();
export const MinutesBody = z.object({ minutes: z.object({ type: z.literal('doc') }).passthrough().nullable() }).strict();
export const DecisionBody = z.object({ description: z.string().trim().min(1).max(2000), category: z.enum(DECISION_CATEGORIES) }).strict();
export const ActionBody = z
  .object({ description: z.string().trim().min(1).max(2000), ownerId: z.string().uuid().optional(), dueDate: isoDate.nullable().optional(), decisionId: z.string().uuid().nullable().optional() })
  .strict();
export const UpdateActionBody = z
  .object({ description: z.string().trim().min(1).max(2000).optional(), ownerId: z.string().uuid().optional(), dueDate: isoDate.nullable().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export const CompleteBody = z.object({ noDecisionNote: optionalText(1000) }).strict();
export const NoteBody = z.object({ note: z.string().trim().min(1).max(2000) }).strict();
export const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
