import { z } from 'zod';
import { ENTITY_TYPES } from './core/entity-importer';

const Iso = z.string();
const Person = z.object({ id: z.string().uuid(), name: z.string() }).nullable();

// ---- health (IN8) ----------------------------------------------------------------------------------------------------------
export const HealthRow = z.object({
  connectionId: z.string().uuid(),
  connectionName: z.string(),
  connectionStatus: z.string(),
  providerKind: z.string(),
  entityType: z.string(),
  schedule: z.enum(['manual', 'daily']),
  onMissing: z.enum(['nothing', 'list', 'deactivate']),
  template: z.object({ id: z.string().uuid(), name: z.string(), version: z.number().int(), archived: z.boolean() }).nullable(),
  lastScheduledAt: Iso.nullable(),
  scheduleProblem: z.string().nullable(),
  lastRun: z
    .object({ id: z.string().uuid(), kind: z.string(), trigger: z.string(), status: z.string(), requestedAt: Iso, finishedAt: Iso.nullable(), errorSummary: z.string().nullable(), nextAttemptAt: Iso.nullable() })
    .nullable(),
  lastSuccessAt: Iso.nullable(),
  failedInARow: z.number().int(),
  rowsNeedingAction: z.number().int(),
  missingWaiting: z.number().int(),
  missingHeld: z.number().int(),
  conflictsOpen: z.number().int(),
  /** In words: ok, attention (something waits for a person) or failing (the last import failed or the schedule could not run). */
  state: z.enum(['ok', 'attention', 'failing']),
});
export const Health = z.object({ data: z.array(HealthRow), counts: z.object({ ok: z.number().int(), attention: z.number().int(), failing: z.number().int() }) });
export type Health = z.infer<typeof Health>;

// ---- records that disappeared --------------------------------------------------------------------------------------------
export const MISSING_STATUSES = ['listed', 'held', 'deactivated', 'kept', 'returned'] as const;
export const MissingListQuery = z
  .object({
    connectionId: z.string().uuid().optional(),
    entityType: z.enum(ENTITY_TYPES).optional(),
    runId: z.string().uuid().optional(),
    status: z.enum(['open', 'decided', 'all']).default('open'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type MissingListQuery = z.infer<typeof MissingListQuery>;
export const MissingRecord = z.object({
  id: z.string().uuid(),
  connection: z.object({ id: z.string().uuid(), name: z.string() }),
  entityType: z.string(),
  externalId: z.string(),
  record: z.object({ id: z.string().uuid(), label: z.string().nullable(), active: z.boolean().nullable() }),
  status: z.enum(MISSING_STATUSES),
  reason: z.string().nullable(),
  detectedRunId: z.string().uuid(),
  detectedAt: Iso,
  decidedAt: Iso.nullable(),
  decidedBy: Person,
  decisionNote: z.string().nullable(),
  canDecide: z.boolean(),
  canDeactivate: z.boolean(),
});
export const MissingPage = z.object({ data: z.array(MissingRecord), page: z.number().int(), pageSize: z.number().int(), total: z.number().int(), openCount: z.number().int() });
export type MissingPage = z.infer<typeof MissingPage>;
export const DecideMissingBody = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(500),
    deactivate: z.boolean(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine((b) => b.deactivate || (b.note ?? '').length >= 3, { message: 'Say why they stay active', path: ['note'] });
export type DecideMissingBody = z.infer<typeof DecideMissingBody>;

// ---- rows that need a person ---------------------------------------------------------------------------------------------
export const AttentionQuery = z
  .object({ entityType: z.enum(ENTITY_TYPES), ignored: z.enum(['exclude', 'only']).default('exclude') })
  .strict();
export type AttentionQuery = z.infer<typeof AttentionQuery>;
export const AttentionRow = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  externalId: z.string().nullable(),
  sourceRow: z.number().int().nullable(),
  status: z.enum(['rejected', 'failed', 'ignored']),
  errors: z.array(z.object({ field: z.string().nullable(), message: z.string() })),
  payload: z.record(z.string(), z.unknown()).nullable(),
  createdAt: Iso,
  ignored: z.object({ at: Iso, by: Person, reason: z.string(), from: z.string() }).nullable(),
});
export const AttentionList = z.object({ data: z.array(AttentionRow), total: z.number().int() });
export type AttentionList = z.infer<typeof AttentionList>;
export const IgnoreRowsBody = z.object({ rowIds: z.array(z.string().uuid()).min(1).max(500), reason: z.string().trim().min(3, 'Say why').max(1000) }).strict();
export type IgnoreRowsBody = z.infer<typeof IgnoreRowsBody>;
export const RestoreRowsBody = z.object({ rowIds: z.array(z.string().uuid()).min(1).max(500) }).strict();
export type RestoreRowsBody = z.infer<typeof RestoreRowsBody>;
export const RowsChanged = z.object({ changed: z.number().int() });
