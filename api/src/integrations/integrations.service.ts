import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { ConnectorError } from './core/connector.interface';
import { ConnectorRegistry } from './core/connector.registry';
import { SyncEngine } from './core/sync.engine';
import { AgentCredentialBody, AllowedHosts, AllowedHostsBody, ConnectionDetail, ConnectionList, CreateConnectionBody, CredentialBody, ProviderList, ReasonBody, RecordSource, RecordSourceBody, UpdateConnectionBody } from './integrations.schemas';
import { agentCellText } from './agents/agent-batch';

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
    const agentId = (rows.rows[0].agent_id as string | null) ?? null;
    const [cred, events, problems, agent] = await Promise.all([
      db.execute<Row>(sql`select k.kind, k.created_at, k.created_by, ${sql.raw(personName('p'))} as created_by_name from public.integration_credentials k left join public.profiles p on p.id = k.created_by where k.connection_id = ${id}::uuid and k.revoked_at is null`),
      db.execute<Row>(sql`select e.action, e.from_status, e.to_status, e.note, e.at, e.by, ${sql.raw(personName('p'))} as by_name from public.integration_connection_events e left join public.profiles p on p.id = e.by where e.connection_id = ${id}::uuid order by e.at desc, e.created_at desc limit 100`),
      db.execute<{ p: string[]; can_activate: boolean | null }>(sql`select app.integration_activation_problems(${id}::uuid) as p, app.integration_can_activate(${id}::uuid) as can_activate`),
      agentId ? this.agentPart(db, id, agentId) : Promise.resolve({ agent: null, agentCredential: null, agentJobs: [], recordSources: [] }),
    ]);
    const c = cred.rows[0];
    const importable = this.engine.importable(rows.rows[0].provider_key as string);
    return {
      ...toRow(rows.rows[0]),
      credential: c ? { kind: c.kind as 'api_key' | 'bearer' | 'basic' | 'oauth_client', setAt: iso(c.created_at)!, setBy: person(c.created_by, c.created_by_name) } : null,
      problems: problems.rows[0].p ?? [],
      runnable: this.engine.runnable(rows.rows[0].provider_key as string),
      importable,
      writable: importable.length
        ? (await db.execute<{ e: string }>(sql`select e from unnest(${`{${importable.join(',')}}`}::text[]) e where app.integration_may_write(${orgOf(ctx)}::uuid, e)`)).rows.map((r) => r.e)
        : [],
      fileConnection: rows.rows[0].provider_key === 'csv',
      canActivate: !!problems.rows[0].can_activate,
      events: events.rows.map((e) => ({ action: e.action as string, fromStatus: (e.from_status as string) ?? null, toStatus: (e.to_status as string) ?? null, note: (e.note as string) ?? null, at: iso(e.at)!, by: person(e.by, e.by_name) })),
      ...agent,
    };
  }

  /** A database connection's agent, whether it holds the password, and its latest jobs for this connection (AG2). */
  private async agentPart(db: Db, id: string, agentId: string): Promise<Pick<ConnectionDetail, 'agent' | 'agentCredential' | 'agentJobs' | 'recordSources'>> {
    const [a, k, jobs, sources] = await Promise.all([
      db.execute<Row>(sql`select a.id, a.name, a.status, a.last_heartbeat_at, ky.id as key_id, ky.sealing_key
        from public.integration_agents a left join public.integration_agent_keys ky on ky.agent_id = a.id and ky.status = 'active' where a.id = ${agentId}::uuid`),
      db.execute<Row>(sql`select k.status, k.set_at, k.set_by, ${sql.raw(personName('p'))} as set_by_name, k.stored_at, k.message
        from public.integration_agent_credentials k left join public.profiles p on p.id = k.set_by where k.connection_id = ${id}::uuid`),
      db.execute<Row>(sql`select j.id, j.kind, j.status, j.error_message, j.created_at, j.finished_at, ${sql.raw(personName('p'))} as requested_by_name
        from public.integration_agent_jobs j left join public.profiles p on p.id = j.requested_by where j.connection_id = ${id}::uuid order by j.created_at desc limit 10`),
      db.execute<Row>(sql`select s.entity_type, s.source, s.updated_at from public.integration_record_sources s where s.connection_id = ${id}::uuid order by s.entity_type`),
    ]);
    const r = a.rows[0];
    const last = r?.last_heartbeat_at ? new Date(r.last_heartbeat_at as string) : null;
    const c = k.rows[0];
    return {
      agent: r
        ? {
            id: r.id as string, name: r.name as string, status: r.status as 'active' | 'revoked',
            online: r.status === 'active' && !!last && Date.now() - last.getTime() <= 180_000, lastHeartbeatAt: last ? last.toISOString() : null,
            keyId: (r.key_id as string | null) ?? null, sealingKey: r.status === 'active' ? ((r.sealing_key as string | null) ?? null) : null,
          }
        : null,
      agentCredential: c
        ? { status: c.status as 'waiting' | 'stored' | 'failed' | 'cleared', setAt: iso(c.set_at)!, setBy: person(c.set_by, c.set_by_name), storedAt: iso(c.stored_at), message: (c.message as string | null) ?? null }
        : null,
      agentJobs: jobs.rows.map((j) => ({
        id: j.id as string, kind: j.kind as string, status: j.status as string, errorMessage: (j.error_message as string | null) ?? null,
        createdAt: iso(j.created_at)!, finishedAt: iso(j.finished_at), requestedBy: (j.requested_by_name as string | null) ?? null,
      })),
      recordSources: sources.rows.map((x) => ({ entityType: x.entity_type as string, source: x.source as RecordSource, updatedAt: iso(x.updated_at)! })),
    };
  }

  /** Say which table a kind of record is read from in a database connection, or stop (AG3). The database checks the shape and the rights. */
  setRecordSource(ctx: RequestContext, id: string, b: RecordSourceBody): Promise<ConnectionDetail> {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.set_integration_record_source(${id}::uuid, ${b.entityType}, ${b.source ? JSON.stringify(b.source) : null}::jsonb)`);
      return this.load(db, ctx, id);
    });
  }

  get(ctx: RequestContext, id: string): Promise<ConnectionDetail> {
    return this.database.asUser(ctx, (db) => this.load(db, ctx, id));
  }

  create(ctx: RequestContext, b: CreateConnectionBody): Promise<ConnectionDetail> {
    return this.database.asUser(ctx, async (db) => {
      const res = b.providerKey === 'sql_agent'
        ? await db.execute<{ id: string }>(sql`select app.create_agent_connection(${orgOf(ctx)}::uuid, ${b.agentId}::uuid, ${b.name}, ${b.externalSystem}, ${JSON.stringify(b.config ?? {})}::jsonb) as id`)
        : await db.execute<{ id: string }>(sql`select app.create_integration_connection(${orgOf(ctx)}::uuid, ${b.providerKey}, ${b.name}, ${b.externalSystem}, ${JSON.stringify(b.config ?? {})}::jsonb) as id`);
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

  /**
   * Hand the agent the database password, sealed in the browser to the agent's sealing key (AG2). The API only passes the sealed bytes on; the
   * database checks they were sealed to the agent's current key and gives them to the agent as a job that forgets them when it ends.
   */
  setAgentCredential(ctx: RequestContext, id: string, b: AgentCredentialBody): Promise<ConnectionDetail> {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.set_agent_credential(${id}::uuid, ${JSON.stringify(b.sealed)}::jsonb, ${b.keyId}::uuid)`);
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

  allowedHosts(ctx: RequestContext): Promise<AllowedHosts> {
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<{ hosts: string[]; can: boolean }>(sql`select coalesce(s.integration_allowed_hosts, '{}') as hosts, app.has_permission(${orgOf(ctx)}::uuid, 'integrations.manage') as can
        from (select ${orgOf(ctx)}::uuid as id) o left join public.organisation_settings s on s.organisation_id = o.id`);
      return { hosts: r.rows[0]?.hosts ?? [], canManage: !!r.rows[0]?.can };
    });
  }

  async setAllowedHosts(ctx: RequestContext, b: AllowedHostsBody): Promise<AllowedHosts> {
    await this.database.asUser(ctx, async (_db, client) => {
      await client.query('select app.set_integration_allowed_hosts($1::uuid, $2::text[])', [orgOf(ctx), b.hosts]);
    });
    return this.allowedHosts(ctx);
  }

  /**
   * The first page of one kind of record from an API connection, without starting an import (IN7): what the API sends, as columns and rows, so an
   * import template can be made against it. Nothing is stored. Needs integrations.run; the connector applies the same rules as an import (address
   * rules, the organisation's allow-list, the stored credential).
   */
  async sample(ctx: RequestContext, id: string, entityType: string): Promise<{ columns: string[]; rows: Array<{ r: number; v: Record<string, string> }> }> {
    const info = await this.database.asUser(ctx, async (db) => {
      const rows = await db.execute<Row>(sql`select p.key as provider_key, c.config, c.status from public.integration_connections c join public.integration_providers p on p.id = c.provider_id where c.id = ${id}::uuid and c.organisation_id = ${orgOf(ctx)}::uuid`);
      if (!rows.rows[0]) throw ApiError.notFound('connection_not_found', 'Connection not found');
      const allowed = await db.execute<{ ok: boolean }>(sql`select app.has_permission(${orgOf(ctx)}::uuid, 'integrations.run') as ok`);
      if (!allowed.rows[0].ok) throw ApiError.forbidden('You are not allowed to read from integration connections');
      return rows.rows[0];
    });
    if (info.status === 'retired') throw new ApiError(409, 'integration_rule', 'A retired connection cannot be read');
    if (info.provider_key === 'sql_agent') return this.agentSample(ctx, id, entityType);
    const adapter = this.registry.get(info.provider_key as string);
    const meta = adapter?.getMetadata();
    if (!adapter?.fetchRecords || meta?.kind !== 'api') throw new ApiError(409, 'integration_rule', 'Only an API connection gives a sample; a file is read when it is uploaded');
    const { secret, allowedHosts } = await this.database.asApi(
      async (client) => ({
        secret: meta.authTypes.length > 0 ? ((await client.query('select app.integration_credential_secret($1::uuid, $2::uuid) as s', [orgOf(ctx), id])).rows[0].s as string | null) : null,
        allowedHosts: (await client.query('select app.system_integration_allowed_hosts($1::uuid) as h', [orgOf(ctx)])).rows[0].h as string[],
      }),
      ctx.correlationId,
      'integration',
    );
    let page;
    try {
      page = await adapter.fetchRecords({ config: (info.config as Record<string, unknown>) ?? {}, secret, allowedHosts }, entityType, null);
    } catch (e) {
      if (e instanceof ConnectorError) throw new ApiError(409, 'integration_rule', e.message);
      throw e;
    }
    const rows = page.records.slice(0, 20).map((rec, i) => ({ r: i + 1, v: rec.payload as Record<string, string> }));
    const columns: string[] = [];
    const seenColumns = new Set<string>();
    for (const rec of page.records) for (const k of Object.keys(rec.payload)) if (!seenColumns.has(k) && columns.length < 500) { seenColumns.add(k); columns.push(k); }
    return { columns, rows };
  }

  /**
   * A database connection's sample (AG3): the rows of the latest preview the agent sent of the table this kind of record is read from, asked for
   * since the source was last chosen, cut to the source's columns. Fortress cannot read the database itself, so the mapping page asks the agent
   * for a preview first (a `preview` job) when there is none.
   */
  private agentSample(ctx: RequestContext, id: string, entityType: string): Promise<{ columns: string[]; rows: Array<{ r: number; v: Record<string, string> }> }> {
    return this.database.asUser(ctx, async (db) => {
      const src = (await db.execute<Row>(sql`select s.source, s.updated_at from public.integration_record_sources s where s.connection_id = ${id}::uuid and s.entity_type = ${entityType}`)).rows[0];
      if (!src) throw new ApiError(409, 'integration_rule', `Choose the table ${entityType.replace(/_/g, ' ')} records are read from first`);
      const source = src.source as RecordSource;
      const job = (await db.execute<Row>(sql`select j.result from public.integration_agent_jobs j
         where j.connection_id = ${id}::uuid and j.kind = 'preview' and j.status = 'completed'
           and j.spec -> 'request' ->> 'schema' = ${source.schema} and j.spec -> 'request' ->> 'object' = ${source.object}
           and j.created_at >= ${src.updated_at}::timestamptz
         order by j.created_at desc limit 1`)).rows[0];
      if (!job) throw new ApiError(409, 'agent_sample_needed', `Ask the connector agent for a sample of ${source.schema}.${source.object} first`);
      const result = (job.result ?? {}) as { columns?: Array<{ name: string }>; rows?: Array<Record<string, unknown>> };
      const all = (result.columns ?? []).map((c) => c.name);
      const columns = source.columns ? all.filter((c) => source.columns!.includes(c)) : all;
      const rows = (result.rows ?? []).slice(0, 20).map((row, i) => ({ r: i + 1, v: Object.fromEntries(columns.map((c) => [c, agentCellText(row[c])])) }));
      return { columns, rows };
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
    // A database connection is tested by its agent: the test is a job, and its answer is recorded when the agent reports (AG2).
    if (info.provider_key === 'sql_agent') {
      return this.database.asUser(ctx, async (db) => {
        await db.execute(sql`select app.request_connection_job(${id}::uuid, 'test_connection', '{}'::jsonb, null)`);
        return this.load(db, ctx, id);
      });
    }
    const adapter = this.registry.get(info.provider_key as string);
    if (!adapter) throw new ApiError(409, 'integration_rule', 'That provider has no connector yet');
    const meta = adapter.getMetadata();
    // Only a provider that signs in has a secret to fetch, and only the API login can read it.
    const secret = meta.authTypes.length > 0 && meta.capabilities.testable
      ? await this.database.asApi(async (client) => ((await client.query('select app.integration_credential_secret($1::uuid, $2::uuid) as s', [orgOf(ctx), id])).rows[0].s as string | null), ctx.correlationId, 'integration')
      : null;
    const allowedHosts = meta.kind === 'api'
      ? await this.database.asApi(async (client) => (await client.query('select app.system_integration_allowed_hosts($1::uuid) as h', [orgOf(ctx)])).rows[0].h as string[], ctx.correlationId, 'integration')
      : undefined;
    const result = await adapter.testConnection({ config: (info.config as Record<string, unknown>) ?? {}, secret, allowedHosts });
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
