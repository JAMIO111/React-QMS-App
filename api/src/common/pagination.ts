import { z } from 'zod';
import { ApiError } from './api-error';

export const MAX_LIMIT = 200;

export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  cursor: z.string().max(500).optional(),
});
export type ListQuery = z.infer<typeof ListQuery>;

/** Opaque keyset cursor: base64url JSON of the last item's sort key and id. */
export interface Cursor {
  k: string;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(value: string | undefined): Cursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    if (typeof parsed.k === 'string' && typeof parsed.id === 'string') return parsed;
  } catch {
    // fall through
  }
  throw ApiError.badRequest('invalid_cursor', 'The cursor is not valid');
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

/** Given limit+1 rows, returns a page and the cursor for the next one. */
export function toPage<T>(rows: T[], limit: number, key: (row: T) => Cursor): Page<T> {
  const data = rows.slice(0, limit);
  return { data, nextCursor: rows.length > limit ? encodeCursor(key(data[data.length - 1])) : null };
}

export const pageSchema = <T extends z.ZodTypeAny>(item: T) => z.object({ data: z.array(item), nextCursor: z.string().nullable() });
