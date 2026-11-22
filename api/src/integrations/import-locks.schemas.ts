import { z } from 'zod';

/** The kinds of record an import can lock fields on (the database's guard is on the same eight tables). */
export const LOCKABLE_ENTITIES = ['supplier', 'customer', 'part', 'machine', 'employee', 'gauge_type', 'gauge', 'production_order'] as const;

export const ImportLocksQuery = z.object({ entityType: z.enum(LOCKABLE_ENTITIES), recordId: z.string().uuid() }).strict();
export type ImportLocksQuery = z.infer<typeof ImportLocksQuery>;

/** `field` is the import catalogue's key for the field, which is also the word the record's form and API use for it. */
export const ImportLock = z.object({ field: z.string(), connection: z.object({ id: z.string().uuid(), name: z.string() }) });
export const ImportLockList = z.object({ data: z.array(ImportLock) });
export type ImportLockList = z.infer<typeof ImportLockList>;
