import { z } from 'zod';

/** The registers that can keep saved filters (each person may keep up to `SAVED_FILTER_LIMIT` per register). */
export const SAVED_FILTER_SCOPES = ['ncr_register', 'supplier_register'] as const;
export const SAVED_FILTER_LIMIT = 5;
export const SavedFilterScope = z.enum(SAVED_FILTER_SCOPES);

const Name = z.string().trim().min(1, 'Give the filter a name').max(40, 'A name is at most 40 characters');
/** The register's filters as they sit in its address: plain text values under short names. Empty values are dropped. */
const Filters = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,29}$/, 'Not a filter name'), z.string().max(500))
  .refine((f) => Object.keys(f).length <= 40, 'Too many filters')
  .transform((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '')));

export const SavedFilter = z.object({
  id: z.string().uuid(),
  scope: SavedFilterScope,
  name: z.string(),
  filters: z.record(z.string(), z.string()),
  position: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SavedFilter = z.infer<typeof SavedFilter>;

export const SavedFilterList = z.object({ data: z.array(SavedFilter), limit: z.number().int() });

export const SavedFiltersQuery = z.object({ scope: SavedFilterScope });
export const CreateSavedFilterBody = z.object({ scope: SavedFilterScope, name: Name, filters: Filters }).strict();
export type CreateSavedFilterBody = z.infer<typeof CreateSavedFilterBody>;
export const UpdateSavedFilterBody = z
  .object({ name: Name.optional(), filters: Filters.optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.filters !== undefined, 'Nothing to change');
export type UpdateSavedFilterBody = z.infer<typeof UpdateSavedFilterBody>;
