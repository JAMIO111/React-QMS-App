import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { apiErrorFromDatabase } from '../../common/database-errors';
import { DatabaseService } from '../../database/database.service';
import { ConnectorError, RunErrorKind } from './connector.interface';
import { ConnectorRegistry } from './connector.registry';
import { CATALOGUE } from './catalogue';
import { CatalogueService } from './catalogue.service';
import { EntityImporterRegistry, ImportContext, StagedRow } from './entity-importer';
import { applyMapping, MappingSpec } from './mapping';
import { resolveReferences } from './references';

/** How a call to `drain` ended. `paused`: the time allowed ran out with work left (call again); `waiting`: a transient error, tried again later. */
export type DrainState = 'finished' | 'paused' | 'waiting' | 'failed' | 'blocked';
export interface DrainResult {
  state: DrainState;
  reason?: string;
}

export interface DrainOptions {
  correlationId: string;
  /** How long this call may work before it hands the run back (default 20 seconds, so a request or a cron call stays short). */
  budgetMs?: number;
  /** Rows applied per transaction (default 200). */
  batchSize?: number;
}

interface Lease {
  leased: boolean;
  reason?: string;
  id: string;
  connectionId: string;
  providerKey: string;
  config: Record<string, unknown>;
  externalSystem: string;
  entityType: string;
  kind: 'preview' | 'full' | 'incremental' | 'retry';
  cursor: string | null;
  fetchDone: boolean;
  requestedBy: string | null;
  file: { id: string; status: string; chunkCount: number; headers: string[] } | null;
  mapping: (MappingSpec & { id: string; version: number }) | null;
}

const LEASE_LOST = 'The lease on this import was lost';
const messageOf = (error: unknown): string => {
  const db = apiErrorFromDatabase(error);
  if (db) return db.message;
  return error instanceof Error && error.message ? error.message : 'The row could not be applied';
};

/**
 * The sync engine (plan §6.3). Works a run for a limited time: lease it, fetch and stage pages until the source is done, then apply staged rows in batches —
 * each batch one transaction, each row in its own savepoint with its map entry, so one bad row never rolls back the others — then finish (the cursor moves
 * only then). Everything runs on the API login through the `app.system_*` functions, which re-check the organisation and the lease on every call; the person
 * who asked is passed as the initiating user so the audit trail names them. A run is resumable: the next call carries on from the last committed batch.
 */
@Injectable()
export class SyncEngine {
  private readonly log = new Logger(SyncEngine.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly connectors: ConnectorRegistry,
    private readonly importers: EntityImporterRegistry,
    private readonly catalogues: CatalogueService,
  ) {}

  /** The kinds of record a provider can preview: an adapter that fetches, and a catalogue (to map to) or an importer. Nothing is written by a preview. */
  runnable(providerKey: string): string[] {
    const adapter = this.connectors.get(providerKey);
    if (!adapter?.fetchRecords) return [];
    return [...new Set([...this.importers.types(), ...CATALOGUE.map((c) => c.entityType)])];
  }

  /** The kinds of record a provider can really import: an adapter that fetches and an importer that writes them. */
  importable(providerKey: string): string[] {
    return this.connectors.get(providerKey)?.fetchRecords ? this.importers.types() : [];
  }

  async drain(organisationId: string, runId: string, options: DrainOptions): Promise<DrainResult> {
    const owner = randomUUID();
    const budget = options.budgetMs ?? 20_000;
    const deadline = Date.now() + budget;
    const batchSize = options.batchSize ?? 200;
    const api = <T>(work: (client: PoolClient) => Promise<T>, user: string | null = null) =>
      this.database.asApi(async (client) => {
        await client.query(`select set_config('app.initiating_user', $1, true)`, [user ?? '']);
        return work(client);
      }, options.correlationId, 'integration');

    const lease = (await api((c) => c.query('select app.system_lease_integration_run($1::uuid, $2::uuid, $3::uuid, $4::int) as l', [organisationId, runId, owner, Math.ceil(budget / 1000) + 60]))).rows[0].l as Lease;
    if (!lease.leased) return { state: 'blocked', reason: lease.reason };
    const user = lease.requestedBy;
    const call = <T>(work: (client: PoolClient) => Promise<T>) => api(work, user);
    const runError = async (kind: RunErrorKind, message: string, transient: boolean, retryAfter?: number): Promise<DrainResult> => {
      const res = (await call((c) => c.query('select app.system_integration_run_error($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::int) as r', [organisationId, runId, owner, kind, message, transient, retryAfter ?? null]))).rows[0].r as { status: string };
      return res.status === 'waiting' ? { state: 'waiting', reason: message } : { state: 'failed', reason: message };
    };

    try {
      const importer = this.importers.get(lease.entityType);
      if (!importer && lease.kind !== 'preview') return await runError('mapping', `Importing ${lease.entityType.replace('_', ' ')} records is not available yet`, false);
      const catalogue = await this.catalogues.get(lease.entityType, organisationId);
      if (lease.mapping && !catalogue) return await runError('mapping', `There are no fields to map ${lease.entityType.replace('_', ' ')} records to yet`, false);
      if (!lease.mapping && !importer) return await runError('mapping', 'Map the source to Fortress fields before importing', false);
      const file = lease.file
        ? {
            id: lease.file.id,
            chunkCount: lease.file.chunkCount,
            readChunk: async (seq: number) =>
              (await call((c) => c.query('select app.system_integration_file_chunk($1::uuid, $2::uuid, $3::uuid, $4::int) as r', [organisationId, runId, owner, seq]))).rows[0].r as Array<{ r: number; v: Record<string, string> }> | null,
          }
        : undefined;
      let fetchDone = lease.fetchDone;
      let cursor = lease.cursor;
      const ctx: ImportContext = { organisationId, connectionId: lease.connectionId, runId, externalSystem: lease.externalSystem, initiatingUser: user, owner };

      while (Date.now() < deadline) {
        if (!fetchDone) {
          const adapter = this.connectors.get(lease.providerKey);
          if (!adapter?.fetchRecords) return await runError('internal', 'This connection cannot fetch records yet', false);
          const needsSecret = adapter.getMetadata().authTypes.length > 0;
          const secret = needsSecret
            ? ((await call((c) => c.query('select app.integration_credential_secret($1::uuid, $2::uuid) as s', [organisationId, lease.connectionId]))).rows[0].s as string | null)
            : null;
          let page;
          try {
            page = await adapter.fetchRecords({ config: lease.config ?? {}, secret, file }, lease.entityType, cursor);
          } catch (error) {
            if (error instanceof ConnectorError) return await runError(error.kind, error.message, error.transient, error.retryAfterSeconds);
            this.log.warn({ runId, err: error instanceof Error ? error.name : 'unknown' }, 'integration fetch failed');
            return await runError('transient', 'The source could not be read', true);
          }
          // With a mapping, each record is mapped and checked here: its identifier comes from the key column and any problem rejects the row when it is staged.
          const records = page.records.map((r) => {
            if (lease.mapping && catalogue) {
              const mapped = applyMapping(catalogue, lease.mapping, r.payload);
              // A row the mapping marks "leave this row out" is staged as skipped, whatever else is wrong with it.
              const skip = mapped.canonical.leaveOut === true ? 'Left out by the mapping' : undefined;
              return { externalId: mapped.externalId, sourceRow: r.sourceRow ?? null, payload: r.payload, canonical: mapped.canonical as Record<string, unknown> | null, errors: mapped.errors, skip };
            }
            return { externalId: importer!.externalIdOf(r.payload), sourceRow: r.sourceRow ?? null, payload: r.payload } as { externalId: string | null; sourceRow: number | null; payload: Record<string, unknown>; canonical: Record<string, unknown> | null; errors: { field: string | null; message: string }[]; skip?: string };
          });
          // Links to other records (D10) are resolved before staging, so a preview shows a row that cannot be linked as rejected, with the reason.
          if (lease.mapping && catalogue) {
            await resolveReferences(catalogue, lease.mapping, records, async (kind, mode, values) =>
              (await call((c) => c.query('select app.system_integration_lookup($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::text[]) as r', [organisationId, runId, owner, kind, mode, values]))).rows[0].r as Record<string, string>,
            );
          }
          try {
            await call((c) => c.query('select app.system_stage_integration_records($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, $6)', [organisationId, runId, owner, JSON.stringify(records), page.nextCursor, page.done]));
          } catch (error) {
            const db = apiErrorFromDatabase(error);
            if (db && db.message !== LEASE_LOST && (error as { code?: string }).code === 'QM022') return await runError('limit', db.message, false);
            throw error;
          }
          cursor = page.nextCursor;
          fetchDone = page.done;
          continue;
        }

        const rows = lease.kind === 'preview'
          ? []
          : ((await call((c) => c.query('select app.system_integration_rows_to_apply($1::uuid, $2::uuid, $3::uuid, $4::int) as r', [organisationId, runId, owner, batchSize]))).rows[0].r as StagedRow[]);
        if (rows.length === 0) {
          await call((c) => c.query('select app.system_finish_integration_run($1::uuid, $2::uuid, $3::uuid)', [organisationId, runId, owner]));
          return { state: 'finished' };
        }
        await call(async (c) => {
          for (const row of rows) {
            await c.query('savepoint integration_row');
            try {
              const { internalId } = await importer!.apply(c, row, ctx);
              await c.query('select app.system_apply_integration_row($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6)', [organisationId, runId, owner, row.id, internalId, row.action]);
              await c.query('release savepoint integration_row');
            } catch (error) {
              await c.query('rollback to savepoint integration_row');
              const message = messageOf(error);
              if (message === LEASE_LOST) throw error;
              await c.query('select app.system_fail_integration_row($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6)', [organisationId, runId, owner, row.id, message, null]);
            }
          }
        });
      }
      await call((c) => c.query('select app.system_release_integration_run($1::uuid, $2::uuid, $3::uuid)', [organisationId, runId, owner]));
      return { state: 'paused', reason: 'There is more to do: carry on to continue' };
    } catch (error) {
      if (messageOf(error) === LEASE_LOST) return { state: 'blocked', reason: 'The import was cancelled or taken over' };
      this.log.error({ runId, err: error instanceof Error ? error.message : 'unknown' }, 'integration run failed');
      try {
        return await runError('internal', 'The import stopped unexpectedly and will be tried again', true);
      } catch {
        return { state: 'blocked', reason: 'The import stopped unexpectedly' };
      }
    }
  }
}
