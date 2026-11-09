import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-30');
const Person = z.object({ id: z.string().uuid(), name: z.string() }).nullable();

export const ANSWER_TYPES = ['yes_no', 'rating', 'text'] as const;

// ---- templates -----------------------------------------------------------------------------------

/** One question. Yes/no and rating questions are scored (weight 1 to 10); a note question is not. `critical` means a failure fails the whole assessment. */
export const QuestionInput = z
  .object({
    key: z.string().regex(/^[a-z0-9_]{2,40}$/, 'Use 2 to 40 lower-case letters, digits or underscores'),
    section: z.string().trim().max(80).optional().default(''),
    text: z.string().trim().min(1).max(500),
    answerType: z.enum(ANSWER_TYPES),
    weight: z.number().int().min(1).max(10),
    critical: z.boolean(),
    evidenceRequired: z.boolean(),
    /** The lowest rating that passes, for a rating question (2 to 5). */
    passRating: z.number().int().min(2).max(5).optional(),
  })
  .strict();
export type QuestionInput = z.infer<typeof QuestionInput>;

const Questions = z.array(QuestionInput).min(1).max(60);
export const CreateTemplateBody = z
  .object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(500).optional().default(''), questions: Questions, passMark: z.number().int().min(1).max(100) })
  .strict();
export type CreateTemplateBody = z.infer<typeof CreateTemplateBody>;
export const UpdateTemplateBody = z
  .object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(500), active: z.boolean() })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type UpdateTemplateBody = z.infer<typeof UpdateTemplateBody>;
export const SaveTemplateVersionBody = z.object({ questions: Questions, passMark: z.number().int().min(1).max(100), reason: z.string().trim().min(3, 'Say why the template is changing').max(1000) }).strict();
export type SaveTemplateVersionBody = z.infer<typeof SaveTemplateVersionBody>;

export const Question = z.object({
  key: z.string(),
  section: z.string(),
  text: z.string(),
  answerType: z.enum(ANSWER_TYPES),
  weight: z.number().int(),
  critical: z.boolean(),
  evidenceRequired: z.boolean(),
  passRating: z.number().int().nullable(),
});
export const Template = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  active: z.boolean(),
  /** The current version (the one a new assessment starts from). */
  versionId: z.string().uuid(),
  version: z.number().int(),
  passMark: z.number().int(),
  questions: z.array(Question),
  versions: z.array(z.object({ version: z.number().int(), createdAt: Iso, createdBy: Person, reason: z.string(), passMark: z.number().int(), questions: z.number().int() })),
});
export type Template = z.infer<typeof Template>;

// ---- assessments ---------------------------------------------------------------------------------

export const StartAssessmentBody = z.object({ templateVersionId: z.string().uuid() }).strict();
export type StartAssessmentBody = z.infer<typeof StartAssessmentBody>;
/** One answer: `answer` yes / no / na for a yes/no question, `rating` 1 to 5 for a rating, a `note` for any. `documentId` is the evidence (a current document of the supplier). */
export const ResponseBody = z
  .object({
    questionKey: z.string().min(1).max(40),
    answer: z.enum(['yes', 'no', 'na']).nullable().optional(),
    rating: z.number().int().min(1).max(5).nullable().optional(),
    note: z.string().trim().max(2000).nullable().optional(),
    documentId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type ResponseBody = z.infer<typeof ResponseBody>;
export const CompleteAssessmentBody = z.object({ summary: z.string().trim().max(2000).optional() }).strict();
export type CompleteAssessmentBody = z.infer<typeof CompleteAssessmentBody>;
export const ReasonBody = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(1000) }).strict();
export type ReasonBody = z.infer<typeof ReasonBody>;

const Progress = z.object({
  scored: z.number().int(),
  answered: z.number().int(),
  problems: z.array(z.string()),
  score: z.number().nullable(),
  criticalFailures: z.number().int(),
  passMark: z.number().int(),
  result: z.enum(['pass', 'fail']).nullable(),
});
export const AssessmentSummary = z.object({
  id: z.string().uuid(),
  reference: z.string(),
  supplierId: z.string().uuid(),
  templateName: z.string(),
  templateVersion: z.number().int(),
  passMark: z.number().int(),
  status: z.enum(['in_progress', 'completed', 'abandoned']),
  startedAt: Iso,
  startedBy: Person,
  completedAt: Iso.nullable(),
  score: z.number().nullable(),
  result: z.enum(['pass', 'fail']).nullable(),
  criticalFailures: z.number().int().nullable(),
});
export type AssessmentSummary = z.infer<typeof AssessmentSummary>;
export const AssessmentDetail = AssessmentSummary.extend({
  supplier: z.object({ id: z.string().uuid(), code: z.string(), name: z.string() }),
  completedBy: Person,
  summary: z.string().nullable(),
  abandonReason: z.string().nullable(),
  questions: z.array(
    Question.extend({
      response: z
        .object({
          answer: z.enum(['yes', 'no', 'na']).nullable(),
          rating: z.number().int().nullable(),
          note: z.string().nullable(),
          document: z.object({ id: z.string().uuid(), title: z.string(), fileName: z.string() }).nullable(),
          result: z.enum(['pass', 'fail', 'na', 'unscored']),
          answeredAt: Iso,
        })
        .nullable(),
    }),
  ),
  progress: Progress,
});
export type AssessmentDetail = z.infer<typeof AssessmentDetail>;

// ---- approval decisions --------------------------------------------------------------------------

export const ProposeApprovalBody = z
  .object({
    target: z.enum(['approved', 'conditional']),
    rationale: z.string().trim().min(3, 'Give the rationale').max(1000),
    assessmentId: z.string().uuid().optional(),
    conditions: z.string().trim().max(2000).optional(),
    reviewOn: DateOnly.optional(),
    /** Without a passing assessment: why this approval is an exception (at least 10 characters). */
    exceptionReason: z.string().trim().max(1000).optional(),
  })
  .strict();
export type ProposeApprovalBody = z.infer<typeof ProposeApprovalBody>;
export const DecideApprovalBody = z.object({ approve: z.boolean(), note: z.string().trim().min(3, 'Give a note for the decision').max(1000) }).strict();
export type DecideApprovalBody = z.infer<typeof DecideApprovalBody>;

export const ApprovalDecision = z.object({
  id: z.string().uuid(),
  supplierId: z.string().uuid(),
  fromStatus: z.string(),
  target: z.enum(['approved', 'conditional']),
  rationale: z.string(),
  conditions: z.string().nullable(),
  reviewOn: DateOnly.nullable(),
  exceptionReason: z.string().nullable(),
  assessment: z.object({ id: z.string().uuid(), reference: z.string(), result: z.enum(['pass', 'fail']).nullable(), score: z.number().nullable() }).nullable(),
  status: z.enum(['proposed', 'approved', 'rejected', 'withdrawn']),
  proposedBy: Person,
  proposedAt: Iso,
  decidedBy: Person,
  decidedAt: Iso.nullable(),
  decisionNote: z.string().nullable(),
  /** Who could decide it: false for the person who proposed it. */
  canDecide: z.boolean(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;
