import { CustomValuesInput } from '../custom-fields/custom-fields.schemas';
import { z } from 'zod';

const dateTime = z.string().datetime({ offset: true });
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const Id = z.string().uuid();
const Named = z.object({ id: Id, name: z.string() });
const text = (max: number) => z.string().trim().min(1).max(max);

export const FINDING_STATUSES = ['open', 'closed', 'withdrawn'] as const;
export const FINDING_KINDS = ['nonconformity', 'observation', 'opportunity'] as const;
export const SEVERITIES = ['critical', 'major', 'minor'] as const;
export const FINDING_SORTABLE = ['reference', 'title', 'classification', 'status', 'dueOn', 'owner', 'record', 'createdAt'] as const;
export const AUDIT_FILES_BUCKET = 'audit-files';

// ---- classifications ------------------------------------------------------------------------
export const Classification = z.object({
  id: Id,
  key: z.string(),
  label: z.string(),
  kind: z.enum(FINDING_KINDS),
  /** The severity a non-conformance raised from such a finding starts with (non-conformities only). */
  defaultSeverity: z.enum(SEVERITIES).nullable(),
  sequence: z.number(),
  active: z.boolean(),
  findingCount: z.number(),
});
export type Classification = z.infer<typeof Classification>;

/** The key and kind are fixed once created: findings rely on the kind. */
export const CreateClassificationBody = z
  .object({
    key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Use lower-case letters, digits and underscores, starting with a letter'),
    label: text(60),
    kind: z.enum(FINDING_KINDS),
    defaultSeverity: z.enum(SEVERITIES).nullish(),
    sequence: z.number().int().min(0).max(1000).optional(),
  })
  .strict();
export type CreateClassificationBody = z.infer<typeof CreateClassificationBody>;

export const UpdateClassificationBody = z
  .object({ label: text(60), defaultSeverity: z.enum(SEVERITIES).nullable(), sequence: z.number().int().min(0).max(1000), active: z.boolean() })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
export type UpdateClassificationBody = z.infer<typeof UpdateClassificationBody>;

export const ClassificationListQuery = z.object({ all: z.enum(['true', 'false']).optional() });

// ---- findings -------------------------------------------------------------------------------
export const Finding = z.object({
  id: Id,
  reference: z.string(),
  status: z.enum(FINDING_STATUSES),
  title: z.string(),
  description: z.string(),
  requirement: z.string().nullable(),
  classification: z.object({ id: Id, key: z.string(), label: z.string(), kind: z.enum(FINDING_KINDS) }),
  owner: Named.nullable(),
  dueOn: DateOnly.nullable(),
  /** Open and past its due date. */
  overdue: z.boolean(),
  record: z.object({
    id: Id,
    reference: z.string(),
    status: z.enum(['in_progress', 'completed', 'abandoned']),
    performedOn: DateOnly,
    audit: z.object({ id: Id, reference: z.string(), title: z.string() }),
  }),
  /** The answer it was raised from (none for a standalone finding). */
  answer: z.object({ id: Id, sequence: z.number(), question: z.string() }).nullable(),
  /** Its live non-conformance, when the caller may read it. */
  ncr: z.object({ id: Id, reference: z.string(), stage: z.string() }).nullable(),
  /** Live evidence files. */
  fileCount: z.number(),
  closedNote: z.string().nullable(),
  closedAt: dateTime.nullable(),
  closedBy: Named.nullable(),
  reopenReason: z.string().nullable(),
  withdrawReason: z.string().nullable(),
  withdrawnAt: dateTime.nullable(),
  createdAt: dateTime,
  createdBy: Named.nullable(),
});
export type Finding = z.infer<typeof Finding>;

const csv = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : []))
    .pipe(z.array(item).max(10));

export const FindingListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  recordId: Id.optional(),
  /** Only findings from audit records carried out on this supplier. */
  supplierId: Id.optional(),
  auditId: Id.optional(),
  classificationId: Id.optional(),
  kind: csv(z.enum(FINDING_KINDS)),
  status: csv(z.enum(FINDING_STATUSES)),
  /** An employee. */
  ownerId: Id.optional(),
  /** `true`: open and past due. */
  overdue: z.enum(['true', 'false']).optional(),
  /** The audit was carried out on or after / on or before. */
  from: DateOnly.optional(),
  to: DateOnly.optional(),
  sort: z.enum(FINDING_SORTABLE).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type FindingListQuery = z.infer<typeof FindingListQuery>;

export const FindingPage = z.object({ data: z.array(Finding), page: z.number(), pageSize: z.number(), total: z.number() });

/** `responseId` ties it to a failed (or any) answer of this record; leave it out for a standalone finding. */
export const CreateFindingBody = z
  .object({
    responseId: Id.optional(),
    classificationId: Id,
    title: text(200),
    description: text(4000),
    requirement: z.string().trim().max(2000).nullish(),
    ownerId: Id.nullish(),
    dueOn: DateOnly.nullish(),
  })
  .strict();
export type CreateFindingBody = z.infer<typeof CreateFindingBody>;

export const UpdateFindingBody = z
  .object({
    classificationId: Id,
    title: text(200),
    description: text(4000),
    requirement: z.union([z.string().trim().max(2000), z.null()]),
    ownerId: z.union([Id, z.null()]),
    dueOn: z.union([DateOnly, z.null()]),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
export type UpdateFindingBody = z.infer<typeof UpdateFindingBody>;

const words = z.string().trim().min(3).max(2000);
export const WithdrawFindingBody = z.object({ reason: words }).strict();
export const CloseFindingBody = z.object({ note: words }).strict();
export const ReopenFindingBody = z.object({ reason: words }).strict();

/** Promote a finding to a draft internal non-conformance. Everything is optional: the finding's own words are used. */
export const CreateNcrBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5000).optional(),
    severity: z.enum(SEVERITIES).optional(),
    customValues: CustomValuesInput.optional(),
  })
  .strict();
export type CreateNcrBody = z.infer<typeof CreateNcrBody>;

/** `created: false` means the finding already had a live non-conformance and that one is returned. */
export const CreatedNcr = z.object({ nonconformanceId: Id, created: z.boolean(), finding: Finding });

// ---- evidence -------------------------------------------------------------------------------
export const FindingAttachment = z.object({
  id: Id,
  findingId: Id,
  fileName: z.string(),
  contentType: z.string().nullable(),
  sizeBytes: z.number(),
  storagePath: z.string(),
  createdAt: dateTime,
  createdBy: Named.nullable(),
  deletedAt: dateTime.nullable(),
  deleteReason: z.string().nullable(),
});
export type FindingAttachment = z.infer<typeof FindingAttachment>;

/** Records a file already uploaded to `<org>/audit/<record id>/findings/<finding id>/…` in the audit-files bucket. */
export const CreateFindingAttachmentBody = z
  .object({
    storagePath: z.string().trim().min(1).max(500),
    fileName: z.string().trim().min(1).max(255),
    contentType: z.string().trim().max(200).nullish(),
    sizeBytes: z.number().int().min(0).max(26214400),
  })
  .strict();
export type CreateFindingAttachmentBody = z.infer<typeof CreateFindingAttachmentBody>;
export const FindingAttachmentListQuery = z.object({ deleted: z.enum(['exclude', 'include', 'only']).default('exclude') });
export type FindingAttachmentListQuery = z.infer<typeof FindingAttachmentListQuery>;
export const RemoveFindingAttachmentBody = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();

// ---- the audit behind a non-conformance ------------------------------------------------------
export const NcrAuditSource = z.object({
  /** False when the caller may not read audits: nothing is shown rather than an empty list. */
  available: z.boolean(),
  items: z.array(
    z.object({
      record: z.object({
        id: Id,
        reference: z.string(),
        status: z.enum(['in_progress', 'completed', 'abandoned']),
        performedOn: DateOnly,
        audit: z.object({ id: Id, reference: z.string(), title: z.string() }),
      }),
      /** Null for a non-conformance raised straight from answers before findings existed. */
      finding: z.object({ id: Id, reference: z.string(), title: z.string(), status: z.enum(FINDING_STATUSES), classification: z.object({ label: z.string(), kind: z.enum(FINDING_KINDS) }) }).nullable(),
      answers: z.array(z.object({ sequence: z.number(), question: z.string(), result: z.string().nullable(), note: z.string().nullable() })),
      files: z.array(z.object({ id: Id, fileName: z.string(), contentType: z.string().nullable(), sizeBytes: z.number(), storagePath: z.string() })),
    }),
  ),
});
export type NcrAuditSource = z.infer<typeof NcrAuditSource>;
