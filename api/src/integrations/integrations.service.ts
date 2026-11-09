import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { ConnectorRegistry } from './core/connector.registry';
import { SyncEngine } from './core/sync.engine';
import { ConnectionDetail, ConnectionList, CreateConnectionBody, CredentialBody, ProviderList, ReasonBody, UpdateConnectionBody } from './integrations.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown user' } : null);

const toRow = (r: Row) => ({
  id: r.id as string,
  provider: { key: r.provider_key as string, name: r.provider_name as string, kind: r.provider_kind as 'file' | 'api' | 'agent' },
  name: r.name as string,
  externalSystem: r.external_system as string,
  status: r.status as 'draft' | 'ready' | 'active' | 'paused' | 'retired',
  config: (r.config as Record<string, unknown>) ?? {},
  lastTest: r.last_tested_at ? { at: iso(r.last_tested_at)!, ok: !!r.last_test_ok, message: (r.last_test_message as string) ?? null } : null,
  readyAt: iso(r.ready_at),
  readyBy: person(r.ready_by, r.ready_by_name),
  activatedAt: iso(r.activated_at),
  activatedBy: person(r.activated_by, r.activated_by_name),
  createdAt: iso(r.created_at)!,
  createdBy: person(r.created_by, r.created_by_name),
});

const SELECT = `
  select c.*, p.key as provider_key, p.name as provider_name, p.kind as provider_kind,
         ${personName('pr')} as ready_by_name, ${personName('pa')} as activated_by_name, ${personName('pc')} as created_by_name
  from public.integration_connections c
  join public.integration_providers p on p.id = c.provider_id
  left join public.profiles pr on pr.id = c.ready_by
  left join public.profiles pa on pa.id = c.activated_by
  left join public.profiles pc on pc.id = c.created_by`;

/**
 * Integration connections (IN1): the catalogue of providers, connections and their lifecycle, and credentials kept in Supabase Vault.
 * Every change is a SECURITY DEFINER function the database enforces (permissions, the second-person activation rule, configuration checks); this service only reads, calls them and reshapes.
 * A credential value is passed straight to the database over a raw query (never through a layer that could echo parameters) and is never returned or logged.
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly registry: ConnectorRegistry,
    private readonly engine: SyncEngine,
  ) {}

  providers(ctx: RequestContext): Promise<z.infer<typeof ProviderList>> {
    return this.database.asUser(ctx, async (db) => {
      const rows = await db.execute<Row>(sql`select key, name, description, kind, auth_types, capabilities, status from public.integration_providers order by display_order, key`);
      return {
        data: rows.rows.map((r) => ({
          key: r.key as string, name: r.name as string, description: (r.description as string) ?? null, kind: r.kind as 'file' | 'api' | 'agent',
          authTypes: (r.auth_types as string[]) ?? [], capabilities: r.capabilities as z.infer<typeof ProviderList>['data'][number]['capabilities'], status: r.status as 'available' | 'planned' | 'retired',
        })),
      };
    });
  }

  list(ctx: RequestContext): Promise<z.infer<typeof ConnectionList>> {
    return this.database.asUser(ctx, async (db) => {
      const rows = await db.execute<Row>(sql`${sql.raw(SELECT)} where c.organisation_id = ${orgOf(ctx)}::uuid order by c.status = 'retired', lower(c.name)`);
      return { data: rows.rows.map(toRow) };
    });
  }

  private async load(db: Db, ctx: RequestContext, id: string): Promise<ConnectionDetail> {
    const rows = await db.execute<Row>(sql`${sql.raw(SELECT)} where c.id = ${id}::uuid and c.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!rows.rows[0]) throw ApiError.notFound('connection_not_found', 'Connection not found');
    const [cred, events, problems] = await Promise.all([
      db.execute<Row>(sql`select k.kind, k.created_at, k.created_by, ${sql.raw(personName('p'))} as created_by_name from public.integration_credentials k left join public.profiles p on p.id = k.created_by where k.connection_id = ${id}::uuid and k.revoked_at is null`),
      db.execute<Row>(sql`select e.action, e.from_status, e.to_status, e.note, e.at, e.by, ${sql.raw(personName('p'))} as by_name from public.integration_connection_events e left join public.profiles p on p.id = e.by where e.connection_id = ${id}::uuid order by e.at desc, e.created_at desc limit 100`),
      db.execute<{ p: string[]; can_activate: boolean | null }>(sql`select app.integration_activation_problems(${id}::uuid) as p, app.integration_can_activate(${id}::uuid) as can_activate`),
    ]);
    const c = cred.rows[0];
    return {
      ...toRow(rows.rows[0]),
      credential: c ? { kind: c.kind as 'api_key' | 'bearer' | 'basic' | 'oauth_client', setAt: iso(c.created_at)!, setBy: person(c.created_by, c.created_by_name) } : null,
      problems: problems.rows[0].p ?? [],
      runnable: this.engine.runnable(rows.rows[0].provider_key as string),
      canActivate: !!problems.rows[0].can_activate,
      events: events.rows.map((e) => ({ action: e.action as string, fromStatus: (e.from_status as string) ?? null, toStatus: (e.to_status as string) ?? null, note: (e.note as string) ?? null, at: iso(e.at)!, by: person(e.by, e.by_name) })),
    };
  }

  get(ctx: RequestContext, id: string): Promise<ConnectionDetail> {
    return this.database.asUser(ctx, (db) => this.load(db, ctx, id));
  }

  create(ctx: RequestContext, b: CreateConnectionBody): Promise<ConnectionDetail> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ id: string }>(sql`select app.create_integration_connection(${orgOf(ctx)}::uuid, ${b.providerKey}, ${b.name}, ${b.externalSystem}, ${JSON.stringify(b.config ?? {})}::jsonb) as id`);
      return this.load(db, ctx, res.rows[0].id);
    });
  }

  update(ctx: RequestContext, id: string, b: UpdateConnectionBody): Promise<ConnectionDetail> {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.update_integration_connection(${id}::uuid, ${b.name ?? null}, ${b.config === undefined ? null : JSON.stringify(b.config)}::jsonb)`);
      return this.load(db, ctx, id);
    });
  }

  /** Store or replace the credential. The value goes to Vault through a raw query and appears nowhere else. */
  setCredential(ctx: RequestContext, id: string, b: CredentialBody): Promise<ConnectionDetail> {
    return this.database.asUser(ctx, async (db, client) => {
      try {
        await client.query('select app.set_integration_credential($1::uuid, $2, $3)', [id, b.kind, b.secret]);
      } catch (error) {
        if ((error as { code?: string }).code) throw error; // a database rule: the filter turns it into a message that never contains the value
        throw new ApiError(500, 'credential_failed', 'The credential could not be saved');
      }
      return this.load(db, ctx, id);
    });
  }

  revokeCredential(ctx: RequestContext, id: string, b: ReasonBody): Promise<ConnectionDetail> {
    return this.database.asUser(ctx, async (db) => {
      const live = await db.execute<{ id: string }>(sql`select k.id from public.integration_credentials k where k.connection_id = ${id}::uuid and k.organisation_id = ${orgOf(ctx)}::uuid and k.revoked_at is null`);
      if (!live.rows[0]) throw ApiError.notFound('credential_not_found', 'This connection has no stored credential');
      await db.execute(sql`select app.revoke_integration_credential(${live.rows[0].id}::uuid, ${b.reason})`);
      return this.load(db, ctx, id);
    });
  }

  /** Ask the provider's adapter whether the connection works, and record the result. An adapter that cannot test yet is reported, not recorded. */
  async test(ctx: RequestContext, id: string): Promise<ConnectionDetail> {
    const info = await this.database.asUser(ctx, async (db) => {
      const rows = await db.execute<Row>(sql`select p.key as provider_key, c.config, c.status from public.integration_connections c join public.integration_providers p on p.id = c.provider_id where c.id = ${id}::uuid and c.organisation_id = ${orgOf(ctx)}::uuid`);
      if (!rows.rows[0]) throw ApiError.notFound('connection_not_found', 'Connection not found');
      const allowed = await db.execute<{ ok: boolean }>(sql`select app.has_permission(${orgOf(ctx)}::uuid, 'integrations.manage') as ok`);
      if (!allowed.rows[0].ok) throw ApiError.forbidden('You are not allowed to test integration connections');
      return rows.rows[0];
    });
    if (info.status === 'retired') throw new ApiError(409, 'integration_rule', 'A retired connection cannot be tested');
    const adapter = this.registry.get(info.provider_key as string);
    if (!adapter) throw new ApiError(409, 'integration_rule', 'That provider has no connector yet');
    const meta = adapter.getMetadata();
    // Only a provider that signs in has a secret to fetch, and only the API login can read it.
    const secret = meta.authTypes.length > 0 && meta.capabilities.testable
      ? await this.database.asApi(async (client) => ((await client.query('select app.integration_credential_secret($1::uuid, $2::uuid) as s', [orgOf(ctx), id])).rows[0].s as string | null), ctx.correlationId, 'integration')
      : null;
    const result = await adapter.testConnection({ config: (info.config as Record<string, unknown>) ?? {}, secret });
    if (result.notImplemented) throw new ApiError(409, 'integration_rule', result.message);
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.record_integration_connection_test(${id}::uuid, ${result.ok}, ${result.message})`);
      return this.load(db, ctx, id);
    });
  }

  private command(ctx: RequestContext, id: string, call: (db: Db) => Promise<unknown>): Promise<ConnectionDetail> {
    return this.database.asUser(ctx, async (db) => {
      await call(db);
      return this.load(db, ctx, id);
    });
  }

  markReady(ctx: RequestContext, id: string) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.mark_integration_ready(${id}::uuid)`));
  }
  activate(ctx: RequestContext, id: string) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.activate_integration_connection(${id}::uuid)`));
  }
  pause(ctx: RequestContext, id: string, b: ReasonBody) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.pause_integration_connection(${id}::uuid, ${b.reason})`));
  }
  resume(ctx: RequestContext, id: string) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.resume_integration_connection(${id}::uuid)`));
  }
  retire(ctx: RequestContext, id: string, b: ReasonBody) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.retire_integration_connection(${id}::uuid, ${b.reason})`));
  }
}
