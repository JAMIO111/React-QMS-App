import { z } from 'zod';
import { ANSWER_TYPES, AUDIT_TYPES, TargetInput } from './audits.schemas';

const dateTime = z.string().datetime({ offset: true });
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const Id = z.string().uuid();
const text = (max: number) => z.string().trim().min(1).max(max);

export const RECORD_STATUSES = ['in_progress', 'completed', 'abandoned'] as const;
export const RECORD_RESULTS = ['pass', 'fail'] as const;
export const RECORD_SORTABLE = ['reference', 'audit', 'performedOn', 'result', 'score', 'status', 'startedAt'] as const;

/** Start an audit: from a scheduled slot, or on its own. `targets` (what it is carried out on) may be chosen now or later. */
export const StartAuditBody = z.object({ auditId: Id, occurrenceId: Id.optional(), targets: z.array(TargetInput).max(200).default([]) }).strict();
export type StartAuditBody = z.infer<typeof StartAuditBody>;

export const SetTargetsBody = z.object({ targets: z.array(TargetInput).max(200) }).strict();
export type SetTargetsBody = z.infer<typeof SetTargetsBody>;

/**
 * One answer. Leave everything out to clear it. By the question's type: yes_no `yes|no`; yes_no_na `yes|no|na`; compliant `compliant|non_compliant`; pass_fail `pass|fail`; numeric and measurement `value`;
 * multiple_choice `choice` (one of the listed options); rating `value` (a whole number on the scale); text `note`; evidence takes files (see the attachments) and at most a `note`.
 */
export const ANSWERS = ['pass', 'fail', 'yes', 'no', 'na', 'compliant', 'non_compliant'] as const;
export const ResponseBody = z
  .object({
    questionId: Id,
    answer: z.enum(ANSWERS).nullish(),
    value: z.number().nullish(),
    note: z.string().trim().max(2000).nullish(),
    choice: z.string().trim().max(100).nullish(),
  })
  .strict();
export type ResponseBody = z.infer<typeof ResponseBody>;

export const UpdateRecordBody = z
  .object({ notes: z.union([z.string().trim().max(5000), z.null()]), performedOn: DateOnly })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
export type UpdateRecordBody = z.infer<typeof UpdateRecordBody>;

export const AbandonBody = z.object({ reason: text(1000) }).strict();

const csv = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : []))
    .pipe(z.array(item).max(10));

export const RecordListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  auditId: Id.optional(),
  status: csv(z.enum(RECORD_STATUSES)),
  result: csv(z.enum(RECORD_RESULTS)),
  type: csv(z.enum(AUDIT_TYPES)),
  machineId: Id.optional(),
  operationCode: z.string().trim().max(40).optional(),
  departmentId: Id.optional(),
  performedBy: Id.optional(),
  /** Only records done against this version of their audit. */
  version: z.coerce.number().int().min(1).optional(),
  from: DateOnly.optional(),
  to: DateOnly.optional(),
  /** `true`: only records started by the caller. */
  mine: z.enum(['true', 'false']).optional(),
  sort: z.enum(RECORD_SORTABLE).default('performedOn'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type RecordListQuery = z.infer<typeof RecordListQuery>;

const Named = z.object({ id: Id, name: z.string() });

export const RecordSummary = z.object({
  id: Id,
  reference: z.string(),
  status: z.enum(RECORD_STATUSES),
  result: z.enum(RECORD_RESULTS).nullable(),
  score: z.number().nullable(),
  passMark: z.number(),
  passedCount: z.number().nullable(),
  failedCount: z.number().nullable(),
  criticalFailedCount: z.number().nullable(),
  audit: z.object({ id: Id, reference: z.string(), title: z.string(), auditType: z.enum(AUDIT_TYPES) }),
  /** The version of the audit this record was started against, and the version in force now; null for a record made before versions were kept. */
  version: z.number().nullable(),
  currentVersion: z.number().nullable(),
  carriedOutOn: z.array(z.string()),
  scheduledFor: DateOnly.nullable(),
  performedOn: DateOnly,
  /** Whoever completed it, else whoever started it. */
  auditor: Named.nullable(),
  completedAt: dateTime.nullable(),
  startedAt: dateTime,
});
export type RecordSummary = z.infer<typeof RecordSummary>;

export const RecordPage = z.object({ data: z.array(RecordSummary), page: z.number(), pageSize: z.number(), total: z.number() });

export const RecordQuestion = z.object({
  id: Id,
  sequence: z.number(),
  question: z.string(),
  guidance: z.string().nullable(),
  answerType: z.enum(ANSWER_TYPES),
  passAnswer: z.enum(['yes', 'no']).nullable(),
  unit: z.string().nullable(),
  lowerLimit: z.number().nullable(),
  upperLimit: z.number().nullable(),
  nominal: z.number().nullable(),
  options: z.array(z.object({ label: z.string(), passes: z.boolean() })).nullable(),
  ratingMax: z.number().nullable(),
  passRating: z.number().nullable(),
  critical: z.boolean(),
  /** Live evidence files on this question. */
  fileCount: z.number(),
  response: z
    .object({
      id: Id,
      answer: z.enum(ANSWERS).nullable(),
      value: z.number().nullable(),
      choice: z.string().nullable(),
      note: z.string().nullable(),
      result: z.enum(['pass', 'fail', 'na']).nullable(),
      /** Non-conformances raised from this answer that are still live. */
      ncrs: z.array(z.object({ id: Id, reference: z.string(), stage: z.string() })),
      /** The live finding raised from this answer, if any. */
      finding: z.object({ id: Id, reference: z.string(), status: z.enum(['open', 'closed']), kind: z.enum(['nonconformity', 'observation', 'opportunity']), classification: z.string() }).nullable(),
    })
    .nullable(),
});

export const RecordTarget = z.object({ kind: z.enum(['machine', 'operation', 'department']), id: z.string(), label: z.string() });

export const AuditRecord = RecordSummary.extend({
  procedure: z.string().nullable(),
  notes: z.string().nullable(),
  abandonReason: z.string().nullable(),
  naCount: z.number().nullable(),
  completedBy: Named.nullable(),
  /** The audit now: what a person may choose to carry it out on (its machines, operations and departments as they are today). */
  availableTargets: z.array(RecordTarget),
  /** The audit is relevant to something, so a record must say which. */
  targetsRequired: z.boolean(),
  /** What is still needed before it can be completed (empty once done). */
  problems: z.array(z.string()),
  targets: z.array(RecordTarget),
  questions: z.array(RecordQuestion),
});
export type AuditRecord = z.infer<typeof AuditRecord>;

export type AbandonBody = z.infer<typeof AbandonBody>;

export const AUDIT_FILES_BUCKET = 'audit-files';
export const AuditAttachment = z.object({
  id: Id,
  questionId: Id,
  fileName: z.string(),
  contentType: z.string().nullable(),
  sizeBytes: z.number(),
  storagePath: z.string(),
  createdAt: dateTime,
  createdBy: Named.nullable(),
  deletedAt: dateTime.nullable(),
  deleteReason: z.string().nullable(),
});
export type AuditAttachment = z.infer<typeof AuditAttachment>;

/** Records a file already uploaded to the record's folder (`<org>/audit/<record id>/…` in the audit-files bucket) against an evidence question. */
export const CreateAuditAttachmentBody = z
  .object({
    questionId: Id,
    storagePath: z.string().trim().min(1).max(500),
    fileName: z.string().trim().min(1).max(255),
    contentType: z.string().trim().max(200).nullish(),
    sizeBytes: z.number().int().min(0).max(26214400),
  })
  .strict();
export type CreateAuditAttachmentBody = z.infer<typeof CreateAuditAttachmentBody>;

export const AttachmentListQuery = z.object({ questionId: Id.optional(), deleted: z.enum(['exclude', 'include', 'only']).default('exclude') });
export type AttachmentListQuery = z.infer<typeof AttachmentListQuery>;
export const RemoveAttachmentBody = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();
