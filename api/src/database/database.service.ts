import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, PoolClient } from 'pg';
import { ENV, Env } from '../config/env';
import type { RequestContext } from '../common/request-context';
import { schema } from './schema';

export type Db = NodePgDatabase<typeof schema>;

/**
 * Database access. The pool logs in as `qms_api`, which has no privileges of its own. All business
 * queries go through asUser(), which runs one transaction as the `authenticated` role with the
 * caller's verified JWT claims — so Row Level Security, `auth.uid()` and the audit trail behave
 * exactly as for direct Supabase requests — and tags the audit trail with source/correlation/reason.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(ENV) env: Env) {
    this.pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: env.DATABASE_POOL_MAX,
      application_name: 'qms-api',
    });
  }

  async ping(): Promise<void> {
    await this.pool.query('select 1');
  }

  async asUser<T>(ctx: RequestContext, work: (db: Db, client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      await client.query(
        `select set_config('request.jwt.claims', $1, true),
                set_config('app.source', 'api', true),
                set_config('app.correlation_id', $2, true),
                set_config('app.reason', $3, true)`,
        [JSON.stringify({ ...ctx.user.claims, role: 'authenticated' }), ctx.correlationId, ctx.reason ?? ''],
      );
      const result = await work(drizzle(client, { schema }), client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * For system work with no signed-in person (Stripe webhook, Checkout confirmation): one transaction on the API's own login, which can run only the
   * app.stripe_* functions (granted to it by name; it has no table privileges). Callers must have verified who is asking (signature, or the person's token).
   */
  async asApi<T>(work: (client: PoolClient) => Promise<T>, correlationId = ''): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`select set_config('app.source', 'stripe', true), set_config('app.correlation_id', $1, true)`, [correlationId]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
