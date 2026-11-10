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
export const TemplateSettingsBody = z.object({ writeMode: z.enum(['add_only', 'add_update', 'update_only']).optional(), matchExisting: z.boolean().optional() }).strict();

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
  settings: z.object({ writeMode: z.string(), matchExisting: z.boolean() }),
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
