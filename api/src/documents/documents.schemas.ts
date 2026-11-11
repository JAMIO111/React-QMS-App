import { z } from 'zod';

/** Optional text that is trimmed; empty means "clear it". */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
const nothingToChange = (b: object) => Object.keys(b).length > 0;

export const CONTENT_KINDS = ['file', 'text'] as const;
export const DOCUMENT_STATUSES = ['draft', 'active', 'withdrawn', 'discarded'] as const;
export const REVISION_STATUSES = ['draft', 'in_review', 'awaiting_approval', 'approved', 'effective', 'superseded', 'withdrawn', 'discarded'] as const;

// ---- types ---------------------------------------------------------------------------------------
const Prefix = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{0,9}$/, 'The prefix is 1 to 10 capital letters, digits or hyphens');

export const CreateTypeBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    prefix: Prefix,
    description: text(500),
    reviewMonths: z.number().int().min(1).max(120).optional(),
    contentHint: z.enum(CONTENT_KINDS).optional(),
    sequence: z.number().int().min(0).max(10000).optional(),
  })
  .strict();
export type CreateTypeBody = z.infer<typeof CreateTypeBody>;

export const UpdateTypeBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    prefix: Prefix.optional(),
    description: text(500),
    reviewMonths: z.number().int().min(1).max(120).optional(),
    contentHint: z.enum(CONTENT_KINDS).optional(),
    sequence: z.number().int().min(0).max(10000).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine(nothingToChange, 'Nothing to change');
export type UpdateTypeBody = z.infer<typeof UpdateTypeBody>;

export const TypeListQuery = z.object({ all: z.enum(['true', 'false']).default('false') });
export type TypeListQuery = z.infer<typeof TypeListQuery>;

export const DocumentType = z.object({
  id: z.string().uuid(),
  name: z.string(),
  prefix: z.string(),
  description: z.string().nullable(),
  reviewMonths: z.number().int(),
  contentHint: z.enum(CONTENT_KINDS),
  sequence: z.number().int(),
  active: z.boolean(),
  /** Documents of this type (any status); once there is one the prefix is fixed. */
  documents: z.number().int(),
});

// ---- documents -----------------------------------------------------------------------------------
export const CreateDocumentBody = z
  .object({
    typeId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    contentKind: z.enum(CONTENT_KINDS),
    description: text(1000),
    ownerId: z.string().uuid().optional(),
    /** Bringing an existing document across: its number and current revision letter, both or neither. */
    number: z.string().trim().min(1).max(40).optional(),
    startLetter: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{1,3}$/, 'A letter, A to ZZZ')
      .optional(),
  })
  .strict()
  .refine((b) => (b.number === undefined) === (b.startLetter === undefined), 'Give both the number and the current revision letter, or neither');
export type CreateDocumentBody = z.infer<typeof CreateDocumentBody>;

export const UpdateDocumentBody = z
  .object({ title: z.string().trim().min(1).max(200).optional(), description: text(1000), ownerId: z.string().uuid().optional() })
  .strict()
  .refine(nothingToChange, 'Nothing to change');
export type UpdateDocumentBody = z.infer<typeof UpdateDocumentBody>;

const csv = (values: readonly string[]) =>
  z
    .string()
    .optional()
    .refine((v) => !v || v.split(',').every((x) => values.includes(x)), `One or more of ${values.join(', ')}`);

export const DocumentListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  type: z
    .string()
    .optional()
    .refine((v) => !v || v.split(',').every((x) => z.string().uuid().safeParse(x).success), 'Type ids separated by commas'),
  status: csv(DOCUMENT_STATUSES),
  kind: z.enum(CONTENT_KINDS).optional(),
  owner: z.enum(['me']).optional(),
  sort: z.enum(['number', 'title', 'type', 'status', 'owner', 'updatedAt']).default('number'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type DocumentListQuery = z.infer<typeof DocumentListQuery>;

// ---- revisions -----------------------------------------------------------------------------------
/** A TipTap document: an object of type "doc". The database checks the size (≤ 500 kB). */
const EditorDoc = z.object({ type: z.literal('doc') }).passthrough();

export const UpdateRevisionBody = z
  .object({ changeSummary: text(2000), body: EditorDoc.nullable().optional() })
  .strict()
  .refine(nothingToChange, 'Nothing to change');
export type UpdateRevisionBody = z.infer<typeof UpdateRevisionBody>;

export const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export type ReasonBody = z.infer<typeof ReasonBody>;

export const DocumentFileBody = z
  .object({
    role: z.enum(['main', 'attachment']).default('attachment'),
    storagePath: z.string().min(1).max(600),
    fileName: z.string().trim().min(1).max(255),
    contentType: z.string().max(200).nullable().optional(),
    sizeBytes: z.number().int().min(0).max(52_428_800),
  })
  .strict();
export type DocumentFileBody = z.infer<typeof DocumentFileBody>;
