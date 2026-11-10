import { StepsBody } from './integration-steps.schemas';
import { z } from 'zod';
import { ENTITY_TYPES } from './core/entity-importer';
import { DATE_FORMATS, OWNERSHIP, REF_MATCH, TRANSFORMS } from './core/mapping';

const Iso = z.string().datetime({ offset: true });
const Person = z.object({ id: z.string().uuid(), name: z.string() }).nullable();

/** After the browser has uploaded the file to integration-files at <org>/integration/<connection>/<uuid>-<name>. */
export const RegisterFileBody = z
  .object({
    path: z.string().min(10).max(600),
    fileName: z.string().trim().min(1).max(255),
    size: z.number().int().min(0).max(26_214_400),
    /** How to read this file; anything left out follows the connection's settings. */
    options: z
      .object({
        delimiter: z.enum(['auto', ',', ';', 'tab', '|']).optional(),
        encoding: z.enum(['auto', 'utf-8', 'windows-1252', 'utf-16le', 'utf-16be']).optional(),
        hasHeader: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RegisterFileBody = z.infer<typeof RegisterFileBody>;

export const FieldMappingBody = z
  .object({
    target: z.string().min(1).max(60),
    source: z.string().max(200).nullable().optional(),
    sources: z.array(z.string().max(200)).max(10).optional(),
    transform: z.enum(TRANSFORMS).optional(),
    values: z.record(z.string().max(200), z.string().max(200)).refine((v) => Object.keys(v).length <= 200, 'At most 200 values').optional(),
    value: z.string().max(500).optional(),
    separator: z.string().max(10).optional(),
    dateFormat: z.enum(DATE_FORMATS).optional(),
    decimal: z.enum(['.', ',']).optional(),
    default: z.string().max(500).nullable().optional(),
    ownership: z.enum(OWNERSHIP).optional(),
    /** A reference field: by the Fortress code (default) or by the id the source gave the record in an earlier import (D10). */
    match: z.enum(REF_MATCH).optional(),
    /** Steps applied in order after the value is taken (core/steps.ts). */
    steps: StepsBody.optional(),
    /** A formula used instead of the column (core/formula); checked before saving. */
    formula: z.string().max(2000).nullable().optional(),
  })
  .strict();

export const SaveMappingBody = z
  .object({
    entityType: z.enum(ENTITY_TYPES),
    keyField: z.string().trim().min(1).max(200),
    fields: z.array(FieldMappingBody).min(1).max(100),
    reason: z.string().trim().max(1000).optional(),
    /** Check the columns against this uploaded file. */
    fileId: z.string().uuid().optional(),
  })
  .strict();
export type SaveMappingBody = z.infer<typeof SaveMappingBody>;

export const MappingQuery = z.object({ entityType: z.enum(ENTITY_TYPES).optional() });

// ---- output --------------------------------------------------------------------------------------

export const IntegrationFile = z.object({
  id: z.string().uuid(),
  connectionId: z.string().uuid(),
  fileName: z.string(),
  sizeBytes: z.number().int(),
  status: z.enum(['uploaded', 'parsed', 'failed', 'purged']),
  sheet: z.string().nullable(),
  headers: z.array(z.string()),
  rowCount: z.number().int(),
  error: z.string().nullable(),
  uploadedBy: Person,
  uploadedAt: Iso,
  purgedAt: Iso.nullable(),
});
export const IntegrationFileDetail = IntegrationFile.extend({
  /** The first rows, to check the columns while mapping (empty once the rows are cleared). */
  sample: z.array(z.object({ row: z.number().int(), values: z.record(z.string(), z.string()) })),
});
export type IntegrationFileDetail = z.infer<typeof IntegrationFileDetail>;
export const IntegrationFileList = z.object({ data: z.array(IntegrationFile) });

export const CatalogueResponse = z.object({
  data: z.array(
    z.object({
      entityType: z.enum(ENTITY_TYPES),
      label: z.string(),
      keyHint: z.string(),
      fields: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          type: z.string(),
          required: z.boolean(),
          maxLength: z.number().int().nullable(),
          options: z.array(z.object({ value: z.string(), label: z.string() })).nullable(),
          description: z.string().nullable(),
          /** A link to another record: what it points at, and whether it can be matched by the source's own id. */
          ref: z.object({ kind: z.string(), source: z.boolean() }).nullable(),
          /** Read from the database's own rules: a pattern the text must match, and numeric bounds. */
          pattern: z.string().nullable(),
          min: z.number().nullable(),
          max: z.number().nullable(),
          minExclusive: z.boolean(),
          /** One of the organisation's custom fields (key `cf_<field key>`). */
          custom: z.boolean(),
          /** Its new values cannot be held for review (IN5): "Source wins" or "Fortress wins" only. */
          reviewable: z.boolean(),
        }),
      ),
    }),
  ),
});

export const MappingVersion = z.object({
  id: z.string().uuid(),
  entityType: z.enum(ENTITY_TYPES),
  version: z.number().int(),
  keyField: z.string(),
  fields: z.array(z.record(z.string(), z.unknown())),
  reason: z.string().nullable(),
  current: z.boolean(),
  createdBy: Person,
  createdAt: Iso,
});
export const MappingList = z.object({ data: z.array(MappingVersion) });

// ---- import settings (D9) ------------------------------------------------------------------------

export const WRITE_MODES = ['add_only', 'add_update', 'update_only'] as const;
export const ON_MISSING = ['nothing', 'list', 'deactivate'] as const;
export const SCHEDULES = ['manual', 'daily'] as const;
export const ImportSettings = z.object({
  entityType: z.enum(ENTITY_TYPES),
  writeMode: z.enum(WRITE_MODES),
  matchExisting: z.boolean(),
  onMissing: z.enum(ON_MISSING),
  schedule: z.enum(SCHEDULES),
  /** False while the defaults apply (nothing saved yet). */
  saved: z.boolean(),
  /** Fixed for this kind of record (non-conformances are only ever added). */
  fixed: z.boolean(),
  /** "Make inactive" is possible for this kind of record. */
  canDeactivate: z.boolean(),
  /** Whether "when a record disappears" applies (not to records of events: NCs, goods receipts, received quantities). */
  tracksMissing: z.boolean(),
  /** The import template a daily import uses, and who it acts for (IN8). */
  template: z.object({ id: z.string().uuid(), name: z.string(), version: z.number().int(), archived: z.boolean() }).nullable(),
  scheduledBy: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
  lastScheduledAt: z.string().nullable(),
  scheduleProblem: z.string().nullable(),
});
export const ImportSettingsList = z.object({ data: z.array(ImportSettings) });
export const SaveImportSettingsBody = z
  .object({
    entityType: z.enum(ENTITY_TYPES),
    writeMode: z.enum(WRITE_MODES).optional(),
    matchExisting: z.boolean().optional(),
    onMissing: z.enum(ON_MISSING).optional(),
    schedule: z.enum(SCHEDULES).optional(),
    /** The template a daily import uses; null clears it. */
    templateId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type SaveImportSettingsBody = z.infer<typeof SaveImportSettingsBody>;

// ---- received quantities check (IN6c) ----------------------------------------------------------------
export const ReconciliationQuery = z.object({ all: z.enum(['true', 'false']).default('false') }).strict();
export const RECONCILIATION_STATES = ['short', 'over', 'date', 'match'] as const;
export const Reconciliation = z.object({
  data: z.array(
    z.object({
      poLineId: z.string().uuid(),
      poNumber: z.string(),
      lineNumber: z.number().int(),
      supplier: z.string(),
      item: z.string().nullable(),
      /** What the source says it has received, and its last date. */
      sourceQuantity: z.number(),
      sourceLastReceivedOn: z.string().nullable(),
      /** What Fortress has received on the line (receipts not cancelled), and its latest date. */
      fortressQuantity: z.number(),
      fortressLastReceivedOn: z.string().nullable(),
      recordedAt: z.string(),
      /** short: Fortress has less; over: more; date: the same quantity but another last date; match. */
      state: z.enum(RECONCILIATION_STATES),
    }),
  ),
  counts: z.object({ short: z.number().int(), over: z.number().int(), date: z.number().int(), match: z.number().int() }),
});
export type Reconciliation = z.infer<typeof Reconciliation>;
