import { z } from 'zod';

const dateTime = z.string().datetime({ offset: true });
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const Id = z.string().uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.union([z.string().trim().max(max), z.null()]).optional().transform((v) => (v === '' || v === undefined ? (v === '' ? null : undefined) : v));

export const AUDIT_TYPES = ['process', 'product', 'system', 'supplier', 'housekeeping', 'layered_process', 'other'] as const;
export const FREQUENCY_KINDS = ['daily', 'weekly', 'monthly', 'quarterly', 'six_monthly', 'yearly', 'every_n_days', 'on_demand'] as const;
export const ANSWER_TYPES = ['yes_no', 'compliant', 'pass_fail', 'yes_no_na', 'numeric', 'text', 'multiple_choice', 'measurement', 'evidence', 'rating'] as const;
/** Types that can always fail; numeric needs a limit and rating a lowest acceptable rating to be scored. */
const ALWAYS_SCORED = ['yes_no', 'compliant', 'pass_fail', 'yes_no_na', 'multiple_choice', 'measurement'];
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

const ChoiceOption = z.object({ label: text(100), passes: z.boolean().default(true) }).strict();

/**
 * One checklist question as written in the template. What is set depends on the type: yes/no and yes/no/N/A say which answer passes; numeric has an optional unit and limits;
 * a measurement needs a nominal value, limits and a unit; multiple choice 2–20 options each marked acceptable or not; a rating a scale (3–10, default 5) and an optional lowest acceptable rating.
 * Fields that do not belong to the type are ignored.
 */
export const QuestionInput = z
  .object({
    question: text(500),
    guidance: optionalText(2000),
    answerType: z.enum(ANSWER_TYPES),
    passAnswer: z.enum(['yes', 'no']).nullish(),
    unit: optionalText(20),
    lowerLimit: z.number().nullish(),
    upperLimit: z.number().nullish(),
    nominal: z.number().nullish(),
    options: z.array(ChoiceOption).max(20).nullish(),
    ratingMax: z.number().int().nullish(),
    passRating: z.number().int().nullish(),
    critical: z.boolean().default(false),
  })
  .strict()
  .superRefine((q, ctx) => {
    const bad = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    const t = q.answerType;
    if (t === 'numeric' && q.lowerLimit != null && q.upperLimit != null && q.lowerLimit > q.upperLimit) bad('upperLimit', 'The upper limit is below the lower limit');
    if (t === 'measurement') {
      if (q.nominal == null) bad('nominal', 'Give the nominal value');
      if (q.lowerLimit == null) bad('lowerLimit', 'Give the lower limit');
      if (q.upperLimit == null) bad('upperLimit', 'Give the upper limit');
      if (!q.unit) bad('unit', 'Give the unit');
      if (q.nominal != null && q.lowerLimit != null && q.upperLimit != null && !(q.lowerLimit <= q.nominal && q.nominal <= q.upperLimit)) bad('nominal', 'The nominal value must lie between the limits');
    }
    if (t === 'multiple_choice') {
      const options = q.options ?? [];
      if (options.length < 2) bad('options', 'Give at least two options');
      const labels = options.map((o) => o.label.toLowerCase());
      if (new Set(labels).size !== labels.length) bad('options', 'An option is listed twice');
      if (options.length && !options.some((o) => o.passes)) bad('options', 'At least one option must be acceptable');
    }
    if (t === 'rating') {
      const max = q.ratingMax ?? 5;
      if (max < 3 || max > 10) bad('ratingMax', 'A rating scale runs from 1 to between 3 and 10');
      if (q.passRating != null && (q.passRating < 1 || q.passRating > max)) bad('passRating', 'The lowest acceptable rating must be on the scale');
    }
    const scored = ALWAYS_SCORED.includes(t) || (t === 'numeric' && (q.lowerLimit != null || q.upperLimit != null)) || (t === 'rating' && q.passRating != null);
    if (q.critical && !scored) bad('critical', 'Only a question that can fail can be critical');
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

/** Why the audit is changing: needed whenever the content (title, type, purpose, procedure, pass mark, checklist, what it is relevant to) is different; it becomes the reason of the new version. */
const ChangeReason = z.string().trim().min(3, 'Say why the audit is changing').max(1000);

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
  .object({ ...Header, questions: z.array(QuestionInput).max(100), targets: z.array(TargetInput).max(200), changeReason: ChangeReason })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).filter((k) => k !== 'changeReason').length > 0, { message: 'Provide at least one field to update' });
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
  nominal: z.number().nullable(),
  options: z.array(z.object({ label: z.string(), passes: z.boolean() })).nullable(),
  ratingMax: z.number().nullable(),
  passRating: z.number().nullable(),
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
  /** The current version of the audit's content (see the version history); null for an audit not yet started or saved with versions. */
  version: z.number().nullable(),
  questionCount: z.number(),
  criticalCount: z.number(),
  /** The latest completed record of this audit. */
  lastRecord: z.object({ id: Id, reference: z.string(), performedOn: DateOnly, result: z.enum(['pass', 'fail']) }).nullable(),
  /** The next slot still to be done: due today or later, or past due but inside the grace period, with no audit started for it and not skipped. */
  nextDueOn: DateOnly.nullable(),
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

/** Operation codes to choose from for "relevant to": those of the control plans plus any already on an audit. */
export const OperationCodes = z.object({ data: z.array(z.object({ code: z.string(), name: z.string().nullable() })) });

const Who = z.object({ id: Id, name: z.string() }).nullable();
const VersionQuestion = z.object({
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
});

/** One entry of the history of an audit: what it was changed to, why, by whom, and how many records were done against it. */
export const VersionSummary = z.object({
  version: z.number(),
  reason: z.string(),
  createdAt: dateTime,
  createdBy: Who,
  /** The version in force now: new records are done against it. */
  current: z.boolean(),
  title: z.string(),
  passMark: z.number(),
  questionCount: z.number(),
  criticalCount: z.number(),
  targetCount: z.number(),
  /** Records started against this version. */
  recordCount: z.number(),
  /** What changed from the version before, in a few sentences (empty for the first version). */
  summary: z.array(z.string()),
});
export type VersionSummary = z.infer<typeof VersionSummary>;
export const VersionList = z.object({ data: z.array(VersionSummary) });

export const AuditVersion = VersionSummary.extend({
  auditType: z.enum(AUDIT_TYPES),
  purpose: z.string().nullable(),
  procedure: z.string().nullable(),
  questions: z.array(VersionQuestion),
  targets: z.array(z.object({ kind: z.enum(['machine', 'operation', 'department']), label: z.string() })),
  /** The first records started against it (at most 25), newest first. */
  records: z.array(z.object({ id: Id, reference: z.string(), status: z.enum(['in_progress', 'completed', 'abandoned']), result: z.enum(['pass', 'fail']).nullable(), performedOn: DateOnly })),
  /** What this version changed from the one before; null for the first. */
  changes: z
    .object({
      header: z.array(z.object({ field: z.enum(['title', 'auditType', 'purpose', 'procedure', 'passMark']), before: z.union([z.string(), z.number()]).nullable(), after: z.union([z.string(), z.number()]).nullable() })),
      questions: z.object({
        added: z.array(VersionQuestion),
        removed: z.array(VersionQuestion),
        changed: z.array(z.object({ before: VersionQuestion, after: VersionQuestion, fields: z.array(z.string()) })),
        moved: z.array(z.object({ question: z.string(), from: z.number(), to: z.number() })),
      }),
      targets: z.object({ added: z.array(z.object({ kind: z.enum(['machine', 'operation', 'department']), label: z.string() })), removed: z.array(z.object({ kind: z.enum(['machine', 'operation', 'department']), label: z.string() })) }),
    })
    .nullable(),
});
export type AuditVersion = z.infer<typeof AuditVersion>;
