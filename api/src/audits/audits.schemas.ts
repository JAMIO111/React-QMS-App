import { z } from 'zod';

const dateTime = z.string().datetime({ offset: true });
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const Id = z.string().uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.union([z.string().trim().max(max), z.null()]).optional().transform((v) => (v === '' || v === undefined ? (v === '' ? null : undefined) : v));

export const AUDIT_TYPES = ['process', 'product', 'system', 'supplier', 'housekeeping', 'layered_process', 'other'] as const;
export const FREQUENCY_KINDS = ['daily', 'weekly', 'monthly', 'quarterly', 'six_monthly', 'yearly', 'every_n_days', 'on_demand'] as const;
export const ANSWER_TYPES = ['pass_fail', 'yes_no', 'number', 'text'] as const;
export const AUDITOR_KINDS = ['none', 'person', 'role', 'department'] as const;
export const AUDIT_SORTABLE = ['reference', 'title', 'type', 'frequency', 'status', 'createdAt'] as const;

/** How often the audit is due. `on_demand` has no schedule; `every_n_days` needs the number of days. */
export const Frequency = z
  .object({ kind: z.enum(FREQUENCY_KINDS), interval: z.number().int().min(1).max(366).nullish(), firstDueOn: DateOnly.nullish() })
  .strict()
  .superRefine((f, ctx) => {
    if (f.kind === 'on_demand') {
      if (f.firstDueOn) ctx.addIssue({ code: 'custom', path: ['firstDueOn'], message: 'An audit done on demand has no first due date' });
      if (f.interval) ctx.addIssue({ code: 'custom', path: ['interval'], message: 'An audit done on demand has no interval' });
      return;
    }
    if (!f.firstDueOn) ctx.addIssue({ code: 'custom', path: ['firstDueOn'], message: 'Give the first due date' });
    if (f.kind === 'every_n_days' && !f.interval) ctx.addIssue({ code: 'custom', path: ['interval'], message: 'Say how many days apart' });
    if (f.kind !== 'every_n_days' && f.interval) ctx.addIssue({ code: 'custom', path: ['interval'], message: 'Only "every N days" has an interval' });
  });

/** Who is expected to carry the audit out (shown, not enforced: anyone with audits.perform may do it). */
export const AuditorInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('person'), userId: Id }).strict(),
  z.object({ kind: z.literal('role'), roleId: Id }).strict(),
  z.object({ kind: z.literal('department'), departmentId: Id }).strict(),
]);

export const QuestionInput = z
  .object({
    question: text(500),
    guidance: optionalText(2000),
    answerType: z.enum(ANSWER_TYPES),
    passAnswer: z.enum(['yes', 'no']).nullish(),
    unit: optionalText(20),
    lowerLimit: z.number().nullish(),
    upperLimit: z.number().nullish(),
    critical: z.boolean().default(false),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (q.answerType === 'number' && q.lowerLimit == null && q.upperLimit == null) ctx.addIssue({ code: 'custom', path: ['lowerLimit'], message: 'Give a lower or an upper limit' });
    if (q.lowerLimit != null && q.upperLimit != null && q.lowerLimit > q.upperLimit) ctx.addIssue({ code: 'custom', path: ['upperLimit'], message: 'The upper limit is below the lower limit' });
    if (q.answerType === 'text' && q.critical) ctx.addIssue({ code: 'custom', path: ['critical'], message: 'A note is not scored, so it cannot be critical' });
  });

export const TargetInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('machine'), machineId: Id }).strict(),
  z.object({ kind: z.literal('operation'), operationCode: text(40) }).strict(),
  z.object({ kind: z.literal('department'), departmentId: Id }).strict(),
]);

const Header = {
  title: text(200),
  auditType: z.enum(AUDIT_TYPES),
  purpose: optionalText(2000),
  procedure: optionalText(20000),
  frequency: Frequency,
  graceDays: z.number().int().min(0).max(60),
  weekdaysOnly: z.boolean(),
  auditor: AuditorInput,
  passMark: z.number().int().min(0).max(100),
};

export const CreateAuditBody = z
  .object({
    ...Header,
    graceDays: Header.graceDays.default(0),
    weekdaysOnly: Header.weekdaysOnly.default(false),
    auditor: Header.auditor.default({ kind: 'none' }),
    passMark: Header.passMark.default(100),
    questions: z.array(QuestionInput).max(100).default([]),
    targets: z.array(TargetInput).max(200).default([]),
  })
  .strict();
export type CreateAuditBody = z.infer<typeof CreateAuditBody>;

/** Any of the fields; `frequency` and `auditor` replace the whole group, `questions` and `targets` replace the whole list. */
export const UpdateAuditBody = z
  .object({ ...Header, questions: z.array(QuestionInput).max(100), targets: z.array(TargetInput).max(200) })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
export type UpdateAuditBody = z.infer<typeof UpdateAuditBody>;

export const ReasonBody = z.object({ reason: text(1000) }).strict();

const csv = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : []))
    .pipe(z.array(item).max(10));

export const AuditListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: csv(z.enum(['active', 'retired'])),
  type: csv(z.enum(AUDIT_TYPES)),
  machineId: Id.optional(),
  operationCode: z.string().trim().max(40).optional(),
  departmentId: Id.optional(),
  sort: z.enum(AUDIT_SORTABLE).default('reference'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type AuditListQuery = z.infer<typeof AuditListQuery>;

const Named = z.object({ id: Id, name: z.string() });
export const AuditTarget = z.object({
  kind: z.enum(['machine', 'operation', 'department']),
  /** machine or department id; the operation code for an operation. */
  id: z.string(),
  label: z.string(),
});
export const AuditQuestion = z.object({
  id: Id,
  sequence: z.number(),
  question: z.string(),
  guidance: z.string().nullable(),
  answerType: z.enum(ANSWER_TYPES),
  passAnswer: z.enum(['yes', 'no']).nullable(),
  unit: z.string().nullable(),
  lowerLimit: z.number().nullable(),
  upperLimit: z.number().nullable(),
  critical: z.boolean(),
});

const Auditor = z.object({ kind: z.enum(AUDITOR_KINDS), id: Id.nullable(), name: z.string().nullable() });

export const AuditSummary = z.object({
  id: Id,
  reference: z.string(),
  title: z.string(),
  auditType: z.enum(AUDIT_TYPES),
  frequency: z.object({ kind: z.enum(FREQUENCY_KINDS), interval: z.number().nullable(), firstDueOn: DateOnly.nullable() }),
  auditor: Auditor,
  passMark: z.number(),
  status: z.enum(['active', 'retired']),
  questionCount: z.number(),
  criticalCount: z.number(),
  targets: z.object({ machines: z.number(), operations: z.number(), departments: z.number(), preview: z.array(z.string()) }),
  createdAt: dateTime,
});
export type AuditSummary = z.infer<typeof AuditSummary>;

export const AuditPage = z.object({ data: z.array(AuditSummary), page: z.number(), pageSize: z.number(), total: z.number() });

export const Audit = AuditSummary.omit({ targets: true }).extend({
  purpose: z.string().nullable(),
  procedure: z.string().nullable(),
  graceDays: z.number(),
  weekdaysOnly: z.boolean(),
  retired: z.object({ at: dateTime, by: Named.nullable(), reason: z.string() }).nullable(),
  questions: z.array(AuditQuestion),
  targets: z.array(AuditTarget),
  createdBy: Named.nullable(),
  updatedAt: dateTime,
});
export type Audit = z.infer<typeof Audit>;
