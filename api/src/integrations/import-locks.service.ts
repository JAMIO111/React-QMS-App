import { Injectable } from '@nestjs/common';
import type { RequestContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { ImportLockList, ImportLocksQuery, ImportManagedList } from './import-locks.schemas';

/**
 * Which fields of a record a scheduled import owns right now (docs/import-field-locks-plan.md). The database works it out and answers only members who
 * may read that kind of record, and only for records an import manages, so a record nothing manages has no answer to give.
 */
@Injectable()
export class ImportLocksService {
  constructor(private readonly database: DatabaseService) {}

  list(ctx: RequestContext, q: ImportLocksQuery): Promise<ImportLockList> {
    return this.database.asUser(ctx, async (_db, client) => {
      const r = await client.query<{ field: string; connection_id: string; connection_name: string }>(
        'select field, connection_id, connection_name from app.integration_locked_fields($1::uuid, $2, $3::uuid)',
        [ctx.organisationId, q.entityType, q.recordId],
      );
      return { data: r.rows.map((x) => ({ field: x.field, connection: { id: x.connection_id, name: x.connection_name } })) };
    });
  }

  /** Which areas (purchase orders, deliveries, customer orders, shipments) a scheduled import owns right now: hand entry of those is refused. */
  managed(ctx: RequestContext): Promise<ImportManagedList> {
    return this.database.asUser(ctx, async (_db, client) => {
      const r = await client.query<{ area: ImportManagedList['data'][number]['area']; connection_name: string }>('select area, connection_name from app.import_managed_areas($1::uuid)', [ctx.organisationId]);
      return { data: r.rows.map((x) => ({ area: x.area, connection: x.connection_name })) };
    });
  }
}
