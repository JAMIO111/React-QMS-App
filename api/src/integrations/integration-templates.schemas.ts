import { z } from 'zod';
import { ENTITY_TYPES } from './core/entity-importer';
import { FieldMappingBody } from './integration-files.schemas';

export const SourceSettingsBody = z
  .object({
    hasHeader: z.boolean().optional(),
    encoding: z.enum(['auto', 'utf-8', 'windows-1252', 'utf-16le', 'utf-16be']).optional(),
    delimiter: z.enum(['auto', ',', ';', 'tab', '|']).optional(),
  })
  .strict();
export const TemplateSettingsBody = z
  .object({
    writeMode: z.enum(['add_only', 'add_update', 'update_only']).optional(),
    matchExisting: z.boolean().optional(),
    /** Cost lines only (IC1): may the import add costs to closed or cancelled non-conformances an import brought in. Off unless chosen. */
    costsOnClosed: z.boolean().optional(),
  })
  .strict();

const Iso = z.string().datetime({ offset: true });
const Person = z.object({ id: z.string().uuid(), name: z.string() }).nullable();

/** What a template version holds (decision T1: organisation-wide). */
export const TemplateBody = z
  .object({
    keyField: z.string().trim().min(1).max(200),
    fields: z.array(FieldMappingBody).min(1).max(100),
    sourceSettings: SourceSettingsBody.optional(),
    /** The headings of the file the template was made against (for the column check). */
    expectedColumns: z.array(z.string().max(200)).max(1000).optional(),
    settings: TemplateSettingsBody.optional(),
  })
  .strict();
export type TemplateBody = z.infer<typeof TemplateBody>;

export const CreateTemplateBody = TemplateBody.extend({
  entityType: z.enum(ENTITY_TYPES),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
}).strict();
export type CreateTemplateBody = z.infer<typeof CreateTemplateBody>;

export const UpdateTemplateBody = z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(1000).nullable().optional() }).strict();
export type UpdateTemplateBody = z.infer<typeof UpdateTemplateBody>;

export const SaveTemplateVersionBody = TemplateBody.extend({ reason: z.string().trim().min(3).max(1000) }).strict();
export type SaveTemplateVersionBody = z.infer<typeof SaveTemplateVersionBody>;

export const DuplicateTemplateBody = z.object({ name: z.string().trim().min(1).max(120).optional() }).strict();
export const ArchiveTemplateBody = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();
export const RestoreTemplateVersionBody = z.object({ version: z.number().int().min(1), reason: z.string().trim().min(3).max(1000) }).strict();

export const TemplateListQuery = z.object({ entityType: z.enum(ENTITY_TYPES).optional(), archived: z.enum(['exclude', 'include', 'only']).default('exclude') });
export type TemplateListQuery = z.infer<typeof TemplateListQuery>;

export const TemplateVersion = z.object({
  version: z.number().int(),
  keyField: z.string(),
  fields: z.array(z.record(z.string(), z.unknown())),
  sourceSettings: z.record(z.string(), z.unknown()),
  expectedColumns: z.array(z.string()),
  settings: z.object({ writeMode: z.string(), matchExisting: z.boolean(), costsOnClosed: z.boolean().optional() }),
  reason: z.string().nullable(),
  current: z.boolean(),
  createdBy: Person,
  createdAt: Iso,
  runCount: z.number().int(),
});
export type TemplateVersion = z.infer<typeof TemplateVersion>;

export const Template = z.object({
  id: z.string().uuid(),
  entityType: z.enum(ENTITY_TYPES),
  name: z.string(),
  description: z.string().nullable(),
  currentVersion: z.number().int(),
  archived: z.object({ at: Iso, by: Person, reason: z.string() }).nullable(),
  createdBy: Person,
  createdAt: Iso,
  updatedAt: Iso,
  runCount: z.number().int(),
  lastUsedAt: Iso.nullable(),
});
export type Template = z.infer<typeof Template>;
export const TemplateList = z.object({ data: z.array(Template) });
export const TemplateDetail = Template.extend({ current: TemplateVersion.nullable(), canManage: z.boolean() });
export type TemplateDetail = z.infer<typeof TemplateDetail>;
export const TemplateVersionList = z.object({ data: z.array(TemplateVersion.omit({ fields: true, sourceSettings: true, expectedColumns: true }).extend({ fieldCount: z.number().int() })) });

/** Preview an unsaved template against an uploaded file (T3: the screen and the import always agree because both run here). */
export const REF_KINDS = ['site', 'department', 'unit', 'category', 'supplier', 'customer', 'part', 'machine', 'employee', 'gauge_type', 'gauge', 'nonconformance'] as const;

/** The values a link field can take: the codes that exist in Fortress, with their names. */
export const ReferenceValuesQuery = z
  .object({
    kind: z.enum(REF_KINDS),
    q: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();
export type ReferenceValuesQuery = z.infer<typeof ReferenceValuesQuery>;
export const ReferenceValues = z.object({
  kind: z.enum(REF_KINDS),
  word: z.string(),
  total: z.number().int(),
  data: z.array(z.object({ code: z.string(), name: z.string().nullable(), hint: z.string().nullable(), active: z.boolean().nullable(), duplicate: z.boolean() })),
});

export const PreviewTemplateBody = z
  .object({
    entityType: z.enum(ENTITY_TYPES),
    /** The uploaded file to preview against, or (IN7) an API connection whose first page is read for the preview. */
    fileId: z.string().uuid().optional(),
    connectionId: z.string().uuid().optional(),
    keyField: z.string().trim().max(200).default(''),
    fields: z.array(FieldMappingBody).max(100),
    /** Source row numbers to show (as the file numbers them); the first 20 rows when left out. */
    rows: z.array(z.number().int().min(1)).max(20).optional(),
  })
  .strict()
  .refine((b) => !!b.fileId !== !!b.connectionId, 'Give a file or a connection to preview against');
export type PreviewTemplateBody = z.infer<typeof PreviewTemplateBody>;

const PreviewField = z.object({
  target: z.string(),
  label: z.string(),
  /** The value taken from the column or formula, then the value after each step. */
  taken: z.string().nullable(),
  steps: z.array(z.string()),
  /** The value as it would be imported (null when empty or wrong). */
  value: z.unknown(),
  error: z.string().nullable(),
});
/** How a link field's values fare against what exists in Fortress: over the rows read (up to 1,000), not only the ones shown. */
const ReferenceCheck = z.object({
  target: z.string(),
  label: z.string(),
  kind: z.enum(REF_KINDS),
  /** The kind of record in words ("part", "gauge type"). */
  word: z.string(),
  mode: z.enum(['code', 'source']),
  /** Rows read, and how many different values they hold. */
  checked: z.number().int(),
  distinct: z.number().int(),
  /** Different values with no record in Fortress, and ones that more than one record answers to. */
  missing: z.number().int(),
  ambiguous: z.number().int(),
  /** Some of those values (up to 10), with how many rows have each. */
  examples: z.array(z.object({ value: z.string(), reason: z.enum(['missing', 'ambiguous']), rows: z.number().int() })),
  /** More than 2,000 different values: the rest were not checked. */
  truncated: z.boolean(),
});
export const TemplatePreview = z.object({
  references: z.array(ReferenceCheck),
  columns: z.array(z.string()),
  columnCheck: z.object({
    /** Columns the template reads that the file lacks; `blocking` when a required field or the key column needs it. */
    missing: z.array(z.object({ column: z.string(), fields: z.array(z.string()), blocking: z.boolean() })),
    /** Columns of the file the template does not use. */
    unused: z.array(z.string()),
  }),
  /** What is wrong with the template itself (the same check as when it is saved). */
  problems: z.array(z.string()),
  rows: z.array(z.object({ row: z.number().int(), externalId: z.string().nullable(), fields: z.array(PreviewField), errors: z.array(z.object({ field: z.string().nullable(), message: z.string() })) })),
});
export type TemplatePreview = z.infer<typeof TemplatePreview>;

export const CheckFormulaBody = z
  .object({
    formula: z.string().max(2000),
    /** The file's columns, to check the formula's column names (and suggest the closest). */
    columns: z.array(z.string().max(200)).max(1000).optional(),
    /** One row to work the formula out on. */
    sample: z.record(z.string().max(200), z.string().max(10000)).optional(),
  })
  .strict();
export type CheckFormulaBody = z.infer<typeof CheckFormulaBody>;
export const FormulaCheckResult = z.object({
  ok: z.boolean(),
  error: z.object({ message: z.string(), position: z.number().int().nullable() }).nullable(),
  columns: z.array(z.string()),
  functions: z.array(z.string()),
  /** The result for the sample row, when one was given and the formula could be read. */
  result: z.object({ value: z.string().nullable(), error: z.string().nullable() }).nullable(),
});
export const FunctionList = z.object({ data: z.array(z.object({ name: z.string(), usage: z.string(), description: z.string(), minArgs: z.number().int(), maxArgs: z.number().int() })) });
