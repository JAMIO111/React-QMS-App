import { sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { ApiError } from './api-error';
import { pgErrorOf } from './database-errors';
import type { RequestContext } from './request-context';

/** The tables whose rows can carry a client key (docs/audit-nc-2026-11.md API-13). */
export type KeyedTable = 'nonconformances' | 'ncr_costs' | 'ncr_dispositions';

/**
 * Makes a record once for a client key. A screen makes the key when its form opens and sends it again on a retry or a second click; the same key answers the
 * record already made instead of making another. With no key, the record is simply made (imports, scripts and older callers send none).
 *
 * `parent` is the non-conformance a cost line or a disposition belongs to: a key already used for another one is refused rather than answered. The lookup is
 * made as the caller (row-level security), and the unique index on (organisation, key) is the backstop for two retries that arrive together: the loser's insert
 * fails with that index named, and it then answers the winner's record.
 */
export async function onceByKey<T>(args: {
  database: DatabaseService;
  ctx: RequestContext;
  table: KeyedTable;
  key: string | undefined;
  parent?: string;
  make: () => Promise<T>;
  read: (id: string) => Promise<T>;
}): Promise<T> {
  const { database, ctx, table, key, parent, make, read } = args;
  if (!key) return make();
  const find = async (): Promise<string | undefined> => {
    const found = await database.asUser(ctx, async (db) =>
      (await db.execute<{ id: string; nonconformance_id?: string }>(sql`
        select id${table === 'nonconformances' ? sql`` : sql`, nonconformance_id`} from public.${sql.raw(table)}
         where organisation_id = ${ctx.organisationId!}::uuid and client_key = ${key}`)).rows[0],
    );
    if (!found) return undefined;
    if (parent && found.nonconformance_id !== parent) throw new ApiError(409, 'client_key_in_use', 'That client key was used for another record');
    return found.id;
  };
  const existing = await find();
  if (existing) return read(existing);
  try {
    return await make();
  } catch (error) {
    const pg = pgErrorOf(error);
    if (pg?.code === '23505' && pg.constraint === `${table}_client_key`) {
      const winner = await find();
      if (winner) return read(winner);
    }
    throw error;
  }
}
