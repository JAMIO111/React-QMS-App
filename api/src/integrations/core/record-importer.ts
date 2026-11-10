import type { PoolClient } from 'pg';
import { EntityImporter, EntityType, ImportContext, StagedRow } from './entity-importer';

/** The kinds of record imported (IN4; production orders IN5), each through its database import function (app.system_import_record). */
export const IMPORTED_TYPES: EntityType[] = ['supplier', 'customer', 'part', 'machine', 'employee', 'gauge_type', 'gauge', 'nonconformance', 'production_order', 'purchase_order', 'goods_receipt', 'po_receipt_total'];

/**
 * Writes one staged row through app.system_import_record, which re-checks the run, the lease and the row, refuses what the run's frozen settings do not allow
 * (an update under "add new only", a new record under "update existing only", any update of a non-conformance), then acts as the person who started the run
 * so the table's own rules and the audit trail apply exactly as for the screens. The record must have been mapped (IN3): its identifier is the key column.
 */
export class RecordImporter implements EntityImporter {
  constructor(readonly entityType: EntityType) {}

  externalIdOf(): string | null {
    return null;
  }

  async apply(client: PoolClient, row: StagedRow, ctx: ImportContext): Promise<{ internalId: string }> {
    if (!row.canonical) throw new Error('This record has no mapped fields: map the source before importing');
    const res = await client.query<{ id: string }>('select app.system_import_record($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::jsonb) as id', [
      ctx.organisationId,
      ctx.runId,
      ctx.owner,
      row.id,
      row.internalId,
      JSON.stringify(row.canonical),
    ]);
    return { internalId: res.rows[0].id };
  }
}
