import { z } from 'zod';
import { ENTITY_TYPES } from './core/entity-importer';

/** The review queue (IN5, plan §6.5): values an import held back because their field is set to "Review" and they would change the record. */
export const CONFLICT_STATUSES = ['open', 'accepted', 'rejected', 'superseded'] as const;

export const ConflictListQuery = z
  .object({
    /** `open` (default), `decided` (accepted or rejected), `all`, or one status. */
    status: z.enum(['open', 'decided', 'all', 'accepted', 'rejected', 'superseded']).default('open'),
    entityType: z.enum(ENTITY_TYPES).optional(),
    connectionId: z.string().uuid().optional(),
    runId: z.string().uuid().optional(),
    recordId: z.string().uuid().optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ConflictListQuery = z.infer<typeof ConflictListQuery>;

export const AcceptConflictBody = z.object({ note: z.string().trim().max(1000).optional() }).strict();
export const RejectConflictBody = z.object({ reason: z.string().trim().min(3, 'Say why Fortress keeps its own value').max(1000) }).strict();

const Person = z.object({ id: z.string().uuid(), name: z.string() }).nullable();

export const Conflict = z.object({
  id: z.string().uuid(),
  status: z.enum(CONFLICT_STATUSES),
  entityType: z.enum(ENTITY_TYPES),
  /** The Fortress record; `label` is null when the caller cannot read it. */
  record: z.object({ id: z.string().uuid(), label: z.string().nullable() }),
  externalId: z.string(),
  field: z.object({ key: z.string(), label: z.string() }),
  /** What Fortress had when the value was held back, and what the source sent, as words (a link shows its code). Null = empty. */
  fortressValue: z.string().nullable(),
  sourceValue: z.string().nullable(),
  /** Set when Fortress could not take the value at all (e.g. a status move its rules do not allow); accepting it will be refused for the same reason. */
  applyError: z.string().nullable(),
  connection: z.object({ id: z.string().uuid(), name: z.string() }),
  runId: z.string().uuid(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: Person,
  decisionNote: z.string().nullable(),
  supersededAt: z.string().nullable(),
  /** Whether the caller may accept or reject it (integrations.run and the permission to edit that kind of record). */
  canDecide: z.boolean(),
});
export type Conflict = z.infer<typeof Conflict>;

export const ConflictPage = z.object({
  data: z.array(Conflict),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  /** Values waiting across the organisation (for the badge), whatever the filters. */
  openCount: z.number().int(),
});
export type ConflictPage = z.infer<typeof ConflictPage>;
