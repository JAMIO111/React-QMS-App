import { z } from 'zod';
import { ENTITY_TYPES } from './core/entity-importer';

const Iso = z.string().datetime({ offset: true });
const Person = z.object({ id: z.string().uuid(), name: z.string() }).nullable();

export const RUN_KINDS = ['preview', 'full', 'incremental', 'retry'] as const;
export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'] as const;
export const ROW_STATUSES = ['staged', 'previewed', 'unchanged', 'skipped', 'applied', 'rejected', 'failed', 'superseded'] as const;

/** A file connection names the uploaded file (`fileId`); other connections leave it out. */
export const RequestRunBody = z.object({ entityType: z.enum(ENTITY_TYPES), kind: z.enum(['preview', 'full', 'incremental']), fileId: z.string().uuid().optional() }).strict();
export type RequestRunBody = z.infer<typeof RequestRunBody>;

/** Retry the failed rows of a kind of record on the connection (all of them, or the ones named). */
export const RetryBody = z.object({ entityType: z.enum(ENTITY_TYPES), rowIds: z.array(z.string().uuid()).min(1).max(500).optional() }).strict();
export type RetryBody = z.infer<typeof RetryBody>;

export const RunListQuery = z.object({
  connectionId: z.string().uuid().optional(),
  status: z.enum(RUN_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type RunListQuery = z.infer<typeof RunListQuery>;

export const RowListQuery = z.object({
  status: z.enum(ROW_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type RowListQuery = z.infer<typeof RowListQuery>;

export const ExternalRecordQuery = z.object({
  entityType: z.enum(ENTITY_TYPES).optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ExternalRecordQuery = z.infer<typeof ExternalRecordQuery>;

// ---- output --------------------------------------------------------------------------------------

const Counts = z.object({
  total: z.number().int(),
  rejected: z.number().int(),
  unchanged: z.number().int(),
  /** For a preview: how many would be created / updated. */
  created: z.number().int(),
  updated: z.number().int(),
  failed: z.number().int(),
  superseded: z.number().int(),
  /** Left alone by the import settings: already imported under "add new only", or not in Fortress under "update existing only". */
  skipped: z.number().int(),
});

export const Run = z.object({
  id: z.string().uuid(),
  connection: z.object({ id: z.string().uuid(), name: z.string() }),
  entityType: z.enum(ENTITY_TYPES),
  kind: z.enum(RUN_KINDS),
  trigger: z.enum(['user', 'schedule']),
  status: z.enum(RUN_STATUSES),
  requestedBy: Person,
  requestedAt: Iso,
  startedAt: Iso.nullable(),
  finishedAt: Iso.nullable(),
  counts: Counts,
  attempts: z.number().int(),
  /** Set while a run waits to try again after a transient error. */
  nextAttemptAt: Iso.nullable(),
  errorSummary: z.string().nullable(),
  cancelReason: z.string().nullable(),
  cancelledBy: Person,
  fetchDone: z.boolean(),
  /** The file a file connection imported, and the mapping version applied. */
  file: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
  mappingVersion: z.number().int().nullable(),
  /** The import settings this run used (frozen when it was asked for); null for runs from before IN4. */
  settings: z.object({ writeMode: z.string(), matchExisting: z.boolean(), onMissing: z.string(), schedule: z.string() }).nullable(),
});
export const RunPage = z.object({ data: z.array(Run), page: z.number().int(), pageSize: z.number().int(), total: z.number().int() });

export const RunDetail = Run.extend({
  cursorStart: z.string().nullable(),
  cursorNext: z.string().nullable(),
  errors: z.array(z.object({ attempt: z.number().int(), kind: z.string(), message: z.string(), transient: z.boolean(), at: Iso })),
  /** The rows this run staged or worked on, by their status now (a retry may have applied some since). */
  rowsNow: z.record(z.enum(ROW_STATUSES), z.number().int()),
  /** Only in answers to a command: how the work done during the request ended (`paused`: carry on to continue). */
  drain: z.object({ state: z.enum(['finished', 'paused', 'waiting', 'failed', 'blocked']), reason: z.string().nullable() }).nullable(),
});
export type RunDetail = z.infer<typeof RunDetail>;

export const InboxRow = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  externalId: z.string().nullable(),
  sourceRow: z.number().int().nullable(),
  status: z.enum(ROW_STATUSES),
  action: z.enum(['create', 'update']).nullable(),
  internalId: z.string().uuid().nullable(),
  errors: z.array(z.object({ field: z.string().nullable(), message: z.string() })),
  attempts: z.number().int(),
  /** Null once the payload has been cleared by the retention policy (`purgedAt`). */
  payload: z.record(z.string(), z.unknown()).nullable(),
  purgedAt: Iso.nullable(),
  createdAt: Iso,
  appliedAt: Iso.nullable(),
});
export const InboxRowPage = z.object({ data: z.array(InboxRow), page: z.number().int(), pageSize: z.number().int(), total: z.number().int() });

export const ExternalRecord = z.object({
  entityType: z.enum(ENTITY_TYPES),
  externalId: z.string(),
  internalId: z.string().uuid(),
  firstRunId: z.string().uuid(),
  lastRunId: z.string().uuid(),
  createdAt: Iso,
  updatedAt: Iso,
});
export const ExternalRecordPage = z.object({ data: z.array(ExternalRecord), page: z.number().int(), pageSize: z.number().int(), total: z.number().int() });

export const CronRunsResult = z.object({ due: z.number().int(), results: z.array(z.object({ runId: z.string().uuid(), state: z.string(), reason: z.string().nullable() })) });
