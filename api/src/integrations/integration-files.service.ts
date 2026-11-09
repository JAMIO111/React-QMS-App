import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { CATALOGUE, catalogueFor } from './core/catalogue';
import { FileParseError, ParsedFile, parseFile, ParseOptions } from './core/file-parsers';
import { IntegrationFileStore } from './core/file-store';
import { mappingProblems, MappingSpec } from './core/mapping';
import { CatalogueResponse, ImportSettings, ImportSettingsList, IntegrationFile, IntegrationFileDetail, IntegrationFileList, MappingList, RegisterFileBody, SaveImportSettingsBody, SaveMappingBody } from './integration-files.schemas';
import { ENTITY_TYPES, EntityType } from './core/entity-importer';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown user' } : null);
const CHUNK = 1000;

const FILE_SELECT = `select f.*, ${personName('p')} as uploaded_by_name from public.integration_files f left join public.profiles p on p.id = f.uploaded_by`;
const toFile = (r: Row): z.infer<typeof IntegrationFile> => ({
  id: r.id as string,
  connectionId: r.connection_id as string,
  fileName: r.file_name as string,
  sizeBytes: Number(r.size_bytes),
  status: r.status as z.infer<typeof IntegrationFile>['status'],
  sheet: (r.sheet_name as string) ?? null,
  headers: (r.headers as string[]) ?? [],
  rowCount: Number(r.row_count),
  error: (r.parse_error as string) ?? null,
  uploadedBy: person(r.uploaded_by, r.uploaded_by_name),
  uploadedAt: iso(r.uploaded_at)!,
  purgedAt: iso(r.purged_at),
});

/**
 * File imports and mappings (IN3). An uploaded file is fetched from storage, parsed (CSV with the connection's separator, encoding and heading setting, or the
 * first worksheet of an .xlsx) and stored as chunks of rows, so an import can read it in short steps. Mappings are checked against the field catalogue (and,
 * when a file is named, its columns) before the database saves them as a new version.
 */
@Injectable()
export class IntegrationFilesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly store: IntegrationFileStore,
  ) {}

  catalogue(): z.infer<typeof CatalogueResponse> {
    return {
      data: CATALOGUE.map((c) => ({
        entityType: c.entityType,
        label: c.label,
        keyHint: c.keyHint,
        fields: c.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, required: !!f.required, maxLength: f.maxLength ?? null, options: f.options ?? null, description: f.description ?? null, ref: f.ref ?? null })),
      })),
    };
  }

  private async connection(db: Db, ctx: RequestContext, id: string): Promise<{ provider: string; config: Record<string, unknown> }> {
    const rows = await db.execute<Row>(sql`select p.key, c.config from public.integration_connections c join public.integration_providers p on p.id = c.provider_id where c.id = ${id}::uuid and c.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!rows.rows[0]) throw ApiError.notFound('connection_not_found', 'Connection not found');
    return { provider: rows.rows[0].key as string, config: (rows.rows[0].config as Record<string, unknown>) ?? {} };
  }

  private async load(db: Db, ctx: RequestContext, fileId: string): Promise<IntegrationFileDetail> {
    const rows = await db.execute<Row>(sql`${sql.raw(FILE_SELECT)} where f.id = ${fileId}::uuid and f.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!rows.rows[0]) throw ApiError.notFound('file_not_found', 'File not found');
    const chunk = await db.execute<{ rows: Array<{ r: number; v: Record<string, string> }> }>(sql`select rows from public.integration_file_chunks where file_id = ${fileId}::uuid and seq = 0`);
    return { ...toFile(rows.rows[0]), sample: (chunk.rows[0]?.rows ?? []).slice(0, 20).map((x) => ({ row: x.r, values: x.v })) };
  }

  /** Record an upload, read it and keep its rows. A file that cannot be read is kept as failed with the reason (nothing is imported from it). */
  async register(ctx: RequestContext, connectionId: string, b: RegisterFileBody): Promise<IntegrationFileDetail> {
    const { provider, config } = await this.database.asUser(ctx, (db) => this.connection(db, ctx, connectionId));
    if (!this.store.enabled) throw new ApiError(503, 'file_storage_unavailable', 'File imports are not set up on this server yet');
    if (provider !== 'csv') throw new ApiError(409, 'integration_rule', 'Only a file connection imports files');
    const fileId = await this.database.asUser(ctx, async (db) =>
      (await db.execute<{ id: string }>(sql`select app.register_integration_file(${connectionId}::uuid, ${b.path}, ${b.fileName}, ${b.size}::bigint) as id`)).rows[0].id,
    );
    let parsed: ParsedFile | undefined;
    let error: string | null = null;
    try {
      const bytes = await this.store.download(b.path);
      if (!bytes) throw new FileParseError('The uploaded file was not found in storage: upload it again');
      const opts: ParseOptions = {
        delimiter: (config.delimiter as ParseOptions['delimiter']) ?? ',',
        encoding: (config.encoding as ParseOptions['encoding']) ?? 'utf-8',
        hasHeader: config.hasHeader !== false,
      };
      parsed = parseFile(b.fileName, bytes, opts);
    } catch (e) {
      error = e instanceof FileParseError ? e.message : 'The file could not be read';
    }
    return this.database.asUser(ctx, async (db, client) => {
      if (parsed) {
        for (let seq = 0; seq * CHUNK < parsed.rows.length; seq += 1) {
          const rows = parsed.rows.slice(seq * CHUNK, (seq + 1) * CHUNK).map((r) => ({ r: r.row, v: r.values }));
          await client.query('select app.add_integration_file_chunk($1::uuid, $2::int, $3::jsonb)', [fileId, seq, JSON.stringify(rows)]);
        }
        await client.query('select app.finish_integration_file($1::uuid, $2::text[], $3, null)', [fileId, parsed.headers, parsed.sheet]);
      } else {
        await client.query('select app.finish_integration_file($1::uuid, null, null, $2)', [fileId, error]);
      }
      return this.load(db, ctx, fileId);
    });
  }

  list(ctx: RequestContext, connectionId: string): Promise<z.infer<typeof IntegrationFileList>> {
    return this.database.asUser(ctx, async (db) => {
      await this.connection(db, ctx, connectionId);
      const rows = await db.execute<Row>(sql`${sql.raw(FILE_SELECT)} where f.connection_id = ${connectionId}::uuid and f.organisation_id = ${orgOf(ctx)}::uuid order by f.uploaded_at desc limit 50`);
      return { data: rows.rows.map(toFile) };
    });
  }

  get(ctx: RequestContext, fileId: string): Promise<IntegrationFileDetail> {
    return this.database.asUser(ctx, (db) => this.load(db, ctx, fileId));
  }

  private async loadMappings(db: Db, ctx: RequestContext, connectionId: string, entityType?: string): Promise<z.infer<typeof MappingList>> {
    const rows = await db.execute<Row>(sql`
      select m.*, ${sql.raw(personName('p'))} as created_by_name from public.integration_mappings m left join public.profiles p on p.id = m.created_by
       where m.connection_id = ${connectionId}::uuid and m.organisation_id = ${orgOf(ctx)}::uuid and (${entityType ?? null}::text is null or m.entity_type = ${entityType ?? null})
       order by m.entity_type, m.version desc`);
    return {
      data: rows.rows.map((m) => ({
        id: m.id as string,
        entityType: m.entity_type as z.infer<typeof MappingList>['data'][number]['entityType'],
        version: Number(m.version),
        keyField: m.key_field as string,
        fields: (m.fields as Record<string, unknown>[]) ?? [],
        reason: (m.reason as string) ?? null,
        current: m.superseded_at === null,
        createdBy: person(m.created_by, m.created_by_name),
        createdAt: iso(m.created_at)!,
      })),
    };
  }

  mappings(ctx: RequestContext, connectionId: string, entityType?: string): Promise<z.infer<typeof MappingList>> {
    return this.database.asUser(ctx, async (db) => {
      await this.connection(db, ctx, connectionId);
      return this.loadMappings(db, ctx, connectionId, entityType);
    });
  }

  /** Check the mapping against the catalogue (and the named file's columns), then save it as a new version. */
  saveMapping(ctx: RequestContext, connectionId: string, b: SaveMappingBody): Promise<z.infer<typeof MappingList>> {
    const catalogue = catalogueFor(b.entityType);
    if (!catalogue) throw new ApiError(409, 'integration_rule', 'There are no Fortress fields to map this kind of record to yet');
    return this.database.asUser(ctx, async (db, client) => {
      await this.connection(db, ctx, connectionId);
      let headers: string[] | undefined;
      if (b.fileId) {
        const f = await db.execute<Row>(sql`select headers from public.integration_files where id = ${b.fileId}::uuid and connection_id = ${connectionId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
        if (!f.rows[0]) throw ApiError.notFound('file_not_found', 'File not found');
        headers = f.rows[0].headers as string[];
      }
      const spec: MappingSpec = { keyField: b.keyField, fields: b.fields };
      const problems = mappingProblems(catalogue, spec, headers);
      if (problems.length) throw new ApiError(409, 'integration_rule', problems[0], { problems });
      // Keep only what was given, in a stable order, so an unchanged mapping is recognised as unchanged.
      const fields = b.fields.map((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)));
      await client.query('select app.save_integration_mapping($1::uuid, $2, $3, $4::jsonb, $5)', [connectionId, b.entityType, b.keyField, JSON.stringify(fields), b.reason ?? null]);
      return this.loadMappings(db, ctx, connectionId, b.entityType);
    });
  }

  /** The import settings of every kind of record on a connection (the defaults where none are saved; NCs are fixed to "add new only"). */
  settings(ctx: RequestContext, connectionId: string): Promise<z.infer<typeof ImportSettingsList>> {
    return this.database.asUser(ctx, async (db) => {
      await this.connection(db, ctx, connectionId);
      const rows = await db.execute<Row>(sql`select * from public.integration_import_settings where connection_id = ${connectionId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      const saved = new Map(rows.rows.map((r) => [r.entity_type as string, r]));
      return { data: ENTITY_TYPES.map((t) => toSettings(t, saved.get(t))) };
    });
  }

  saveSettings(ctx: RequestContext, connectionId: string, b: SaveImportSettingsBody): Promise<z.infer<typeof ImportSettings>> {
    return this.database.asUser(ctx, async (db, client) => {
      await this.connection(db, ctx, connectionId);
      const { entityType, ...rest } = b;
      await client.query('select app.set_integration_import_settings($1::uuid, $2, $3::jsonb)', [connectionId, entityType, JSON.stringify(rest)]);
      const row = await db.execute<Row>(sql`select * from public.integration_import_settings where connection_id = ${connectionId}::uuid and entity_type = ${entityType}`);
      return toSettings(entityType, row.rows[0]);
    });
  }
}

const HAS_ACTIVE = new Set<EntityType>(['supplier', 'customer', 'part', 'machine', 'employee', 'gauge_type']);
function toSettings(t: EntityType, r: Row | undefined): z.infer<typeof ImportSettings> {
  const fixed = t === 'nonconformance';
  return {
    entityType: t,
    writeMode: fixed ? 'add_only' : ((r?.write_mode as z.infer<typeof ImportSettings>['writeMode']) ?? 'add_only'),
    matchExisting: fixed ? false : !!r?.match_existing,
    onMissing: (r?.on_missing as z.infer<typeof ImportSettings>['onMissing']) ?? 'nothing',
    schedule: (r?.schedule as z.infer<typeof ImportSettings>['schedule']) ?? 'manual',
    saved: !!r,
    fixed,
    canDeactivate: HAS_ACTIVE.has(t),
  };
}
