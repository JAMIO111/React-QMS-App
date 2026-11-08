import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { iso, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { CreateSavedFilterBody, SAVED_FILTER_LIMIT, SavedFilter, UpdateSavedFilterBody } from './saved-filters.schemas';

const toItem = (r: Row): SavedFilter => ({
  id: r.id as string,
  scope: r.scope as SavedFilter['scope'],
  name: r.name as string,
  filters: (r.filters as Record<string, string>) ?? {},
  position: Number(r.position),
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

/**
 * A person's own saved filters. Everything runs as that person: row-level security shows and changes only their own rows (and only while they belong to the
 * organisation), and the database enforces the limit of five per register and a name that is unique per person.
 */
@Injectable()
export class SavedFiltersService {
  constructor(private readonly database: DatabaseService) {}

  list(ctx: RequestContext, scope: string): Promise<{ data: SavedFilter[]; limit: number }> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`
        select * from public.saved_filters where organisation_id = ${ctx.organisationId}::uuid and scope = ${scope}
        order by position, created_at`);
      return { data: res.rows.map(toItem), limit: SAVED_FILTER_LIMIT };
    });
  }

  create(ctx: RequestContext, body: CreateSavedFilterBody): Promise<SavedFilter> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`
        insert into public.saved_filters (organisation_id, scope, name, filters)
        values (${ctx.organisationId}::uuid, ${body.scope}, ${body.name}, ${JSON.stringify(body.filters)}::jsonb)
        returning *`);
      return toItem(res.rows[0]);
    });
  }

  update(ctx: RequestContext, id: string, body: UpdateSavedFilterBody): Promise<SavedFilter> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`
        update public.saved_filters set
          name = coalesce(${body.name ?? null}, name),
          filters = coalesce(${body.filters === undefined ? null : JSON.stringify(body.filters)}::jsonb, filters)
        where id = ${id}::uuid and organisation_id = ${ctx.organisationId}::uuid
        returning *`);
      if (res.rows.length === 0) throw ApiError.notFound();
      return toItem(res.rows[0]);
    });
  }

  remove(ctx: RequestContext, id: string): Promise<void> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`
        delete from public.saved_filters where id = ${id}::uuid and organisation_id = ${ctx.organisationId}::uuid returning id`);
      if (res.rows.length === 0) throw ApiError.notFound();
    });
  }
}
