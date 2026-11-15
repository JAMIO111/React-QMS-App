import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ApiError } from '../../common/api-error';
import type { RequestContext } from '../../common/request-context';
import { DatabaseService, Db } from '../../database/database.service';
import type { AgentCaller } from './agent.guard';
import { freshTimestamp, p256Key, REGISTRATION_SUBJECT, sha256Hex, tokenHash, validNonce, verifySignature } from './agent-signature';

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const orgOf = (ctx: RequestContext) => {
  if (!ctx.organisationId) throw new Error('organisation-scoped route without an organisation');
  return ctx.organisationId;
};

/** An agent is online when it sent a heartbeat in the last three minutes (it sends one every minute, every 15 seconds when asked to hurry). */
export const ONLINE_WITHIN_SECONDS = 180;
export const POLL_SECONDS = 60;
export const FAST_POLL_SECONDS = 15;

/** A short, stable fingerprint of a public key so people can compare it with what the agent's machine shows. */
export const keyFingerprint = (spki: string) => sha256Hex(Buffer.from(spki, 'base64')).slice(0, 16).replace(/(.{4})(?=.)/g, '$1 ');

const job = (r: Row) => ({
  id: r.id as string,
  kind: r.kind as string,
  status: r.status as string,
  attempts: Number(r.attempts),
  maxAttempts: Number(r.max_attempts),
  progress: (r.progress as object | null) ?? null,
  result: (r.result as unknown) ?? null,
  errorKind: (r.error_kind as string | null) ?? null,
  errorMessage: (r.error_message as string | null) ?? null,
  requestedBy: (r.requested_by_name as string | null) ?? null,
  createdAt: iso(r.created_at)!,
  receivedAt: iso(r.received_at),
  startedAt: iso(r.started_at),
  finishedAt: iso(r.finished_at),
});

const agentRow = (r: Row) => {
  const last = r.last_heartbeat_at ? new Date(r.last_heartbeat_at as string) : null;
  return {
    id: r.id as string,
    name: r.name as string,
    location: (r.location as string | null) ?? null,
    status: r.status as 'active' | 'revoked',
    online: r.status === 'active' && !!last && Date.now() - last.getTime() <= ONLINE_WITHIN_SECONDS * 1000,
    lastHeartbeatAt: last ? last.toISOString() : null,
    lastAddress: (r.last_address as string | null) ?? null,
    version: (r.agent_version as string | null) ?? null,
    operatingSystem: (r.operating_system as string | null) ?? null,
    machineName: (r.machine_name as string | null) ?? null,
    capabilities: (r.capabilities as Record<string, unknown>) ?? {},
    activeJobs: Number(r.active_jobs ?? 0),
    lastError: r.last_error_message ? { message: r.last_error_message as string, at: iso(r.last_error_at) } : null,
    registeredAt: iso(r.registered_at)!,
    registeredBy: (r.registered_by_name as string | null) ?? null,
    revokedAt: iso(r.revoked_at),
    revokedBy: (r.revoked_by_name as string | null) ?? null,
    revokedReason: (r.revoked_reason as string | null) ?? null,
  };
};

const NAME = (col: string) => sql.raw(`(select nullif(btrim(concat_ws(' ', p.first_name, p.surname)), '') from public.profiles p where p.id = ${col})`);

/**
 * Connector agents (docs/connector-agent-plan.md AG1). People manage agents under RLS with the database's own rules (integrations.read to see,
 * integrations.manage to register, rename, revoke and test). The agent's own requests, already authenticated by AgentGuard (or, for registration,
 * by a signature with the key it registers), reach the database only through the app.system_agent_* functions on the API's login.
 */
@Injectable()
export class AgentsService {
  constructor(private readonly database: DatabaseService) {}

  // ---------------------------------------------------------------- people

  list(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const rows = await this.agentRows(db, orgOf(ctx));
      const data = rows.map(agentRow);
      return { data, onlineCount: data.filter((a) => a.online).length, activeCount: data.filter((a) => a.status === 'active').length };
    });
  }

  get(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, (db) => this.detail(db, orgOf(ctx), id));
  }

  rename(ctx: RequestContext, id: string, body: { name: string; location?: string | null }) {
    return this.database.asUser(ctx, async (db) => {
      await this.own(db, orgOf(ctx), id);
      await db.execute(sql`select app.rename_agent(${id}::uuid, ${body.name}, ${body.location ?? null})`);
      return this.detail(db, orgOf(ctx), id);
    });
  }

  revoke(ctx: RequestContext, id: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.own(db, orgOf(ctx), id);
      await db.execute(sql`select app.revoke_agent(${id}::uuid, ${reason})`);
      return this.detail(db, orgOf(ctx), id);
    });
  }

  wake(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.own(db, orgOf(ctx), id);
      await db.execute(sql`select app.wake_agent(${id}::uuid)`);
      return { woken: true };
    });
  }

  ping(ctx: RequestContext, id: string, idempotencyKey: string | null) {
    return this.database.asUser(ctx, async (db) => {
      await this.own(db, orgOf(ctx), id);
      const r = (await db.execute(sql`select app.request_agent_job(${id}::uuid, 'ping', '{}'::jsonb, ${idempotencyKey}) as id`)).rows[0] as Row;
      return this.jobById(db, orgOf(ctx), r.id as string);
    });
  }

  job(ctx: RequestContext, jobId: string) {
    return this.database.asUser(ctx, (db) => this.jobById(db, orgOf(ctx), jobId));
  }

  registrations(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const rows = (await db.execute(sql`
        select g.id, g.name, g.location, g.replaces_agent_id, g.expires_at, g.used_at, g.agent_id, g.cancelled_at, g.created_at,
               ${NAME('g.created_by')} as created_by_name, (select name from public.integration_agents a where a.id = g.replaces_agent_id) as replaces_name
          from public.integration_agent_registrations g
         where g.organisation_id = ${orgOf(ctx)}::uuid
         order by g.created_at desc
         limit 30`)).rows as Row[];
      return {
        data: rows.map((r) => ({
          id: r.id as string,
          name: r.name as string,
          location: (r.location as string | null) ?? null,
          replaces: r.replaces_agent_id ? { id: r.replaces_agent_id as string, name: r.replaces_name as string } : null,
          state: r.used_at ? 'used' : r.cancelled_at ? 'cancelled' : new Date(r.expires_at as string) <= new Date() ? 'expired' : 'waiting',
          expiresAt: iso(r.expires_at)!,
          usedAt: iso(r.used_at),
          agentId: (r.agent_id as string | null) ?? null,
          createdAt: iso(r.created_at)!,
          createdBy: (r.created_by_name as string | null) ?? null,
        })),
      };
    });
  }

  /** A one-time registration: the token is made here (32 random bytes), shown once, and only its SHA-256 is stored. */
  createRegistration(ctx: RequestContext, body: { name?: string; location?: string | null; expiresHours?: number; replacesAgentId?: string | null }, apiUrl: string, downloadUrl: string | null) {
    const token = `FAGT-${randomBytes(32).toString('base64url')}`;
    return this.database.asUser(ctx, async (db) => {
      if (body.replacesAgentId) await this.own(db, orgOf(ctx), body.replacesAgentId);
      const r = (await db.execute(sql`
        select app.create_agent_registration(${orgOf(ctx)}::uuid, ${tokenHash(token)}, ${body.name ?? ''}, ${body.location ?? null},
                                             ${body.expiresHours ?? 24}::int, ${body.replacesAgentId ?? null}::uuid) as id`)).rows[0] as Row;
      const g = (await db.execute(sql`select name, expires_at from public.integration_agent_registrations where id = ${r.id as string}::uuid`)).rows[0] as Row;
      return { id: r.id as string, name: g.name as string, token, expiresAt: iso(g.expires_at)!, apiUrl, downloadUrl };
    });
  }

  cancelRegistration(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      const found = (await db.execute(sql`select 1 from public.integration_agent_registrations where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`)).rows;
      if (!found.length) throw ApiError.notFound('not_found', 'Registration not found');
      await db.execute(sql`select app.cancel_agent_registration(${id}::uuid)`);
      return { cancelled: true };
    });
  }

  // ---------------------------------------------------------------- the agent

  /**
   * Registration. No agent exists yet, so the request is signed with the key being registered (proof that the agent holds its private half),
   * and the single-use token stands in for the agent id. The token's hash is what the database compares.
   */
  register(
    body: { token: string; signingKey: string; sealingKey: string; version: string; os: string; machine: string; capabilities?: Record<string, unknown> },
    signed: { method: string; path: string; rawBody: Buffer | undefined; timestamp?: string; nonce?: string; signature?: string },
    address: string | null,
    correlationId: string,
  ) {
    if (!p256Key(body.signingKey) || !p256Key(body.sealingKey)) {
      throw ApiError.badRequest('invalid_key', 'The agent\'s keys must be P-256 public keys (SPKI, base64)');
    }
    if (body.signingKey === body.sealingKey) throw ApiError.badRequest('invalid_key', 'The signing and sealing keys must differ');
    if (!freshTimestamp(signed.timestamp)) {
      throw new ApiError(401, 'agent_clock', 'The agent\'s clock is more than five minutes away from Fortress\'s. Check the time on the agent\'s machine.');
    }
    if (!validNonce(signed.nonce) || !verifySignature(body.signingKey, {
      method: signed.method, path: signed.path, body: signed.rawBody, timestamp: signed.timestamp!, nonce: signed.nonce, agentId: REGISTRATION_SUBJECT,
    }, signed.signature)) {
      throw new ApiError(401, 'agent_unauthenticated', 'The registration is not signed with the key it registers');
    }
    return this.database.asApi(async (c) => {
      const r = (await c.query('select app.system_register_agent($1, $2, $3, $4, $5, $6, $7::jsonb, $8) as r', [
        tokenHash(body.token), body.signingKey, body.sealingKey, body.version, body.os, body.machine, JSON.stringify(body.capabilities ?? {}), address,
      ])).rows[0].r as { agentId: string; organisationId: string; organisationName: string; name: string };
      return { ...r, pollSeconds: POLL_SECONDS, fingerprint: keyFingerprint(body.signingKey) };
    }, correlationId, 'agent');
  }

  heartbeat(agent: AgentCaller, body: { version?: string | null; os?: string | null; machine?: string | null; capabilities?: Record<string, unknown> | null }) {
    return this.database.asApi(async (c) => {
      const r = (await c.query('select app.system_agent_heartbeat($1::uuid, $2, $3, $4, $5::jsonb, $6) as r', [
        agent.agentId, body.version ?? null, body.os ?? null, body.machine ?? null, body.capabilities ? JSON.stringify(body.capabilities) : null, agent.address,
      ])).rows[0].r as { revoked: boolean; jobsWaiting?: boolean; fastPollUntil?: string | null };
      const fast = !!r.fastPollUntil || !!r.jobsWaiting;
      return {
        revoked: r.revoked,
        jobsWaiting: !!r.jobsWaiting,
        fastPollUntil: r.fastPollUntil ?? null,
        pollSeconds: fast ? FAST_POLL_SECONDS : POLL_SECONDS,
        serverTime: new Date().toISOString(),
      };
    }, agent.correlationId, 'agent');
  }

  nextJob(agent: AgentCaller) {
    return this.database.asApi(
      async (c) => (await c.query('select app.system_agent_next_job($1::uuid, 300) as r', [agent.agentId])).rows[0].r as
        | { id: string; kind: string; spec: Record<string, unknown>; attempt: number; leasedUntil: string }
        | null,
      agent.correlationId,
      'agent',
    );
  }

  report(agent: AgentCaller, jobId: string, action: 'ack' | 'progress' | 'complete' | 'fail', payload: Record<string, unknown>) {
    return this.database.asApi(
      async (c) => (await c.query('select app.system_agent_job_report($1::uuid, $2::uuid, $3, $4::jsonb) as r', [agent.agentId, jobId, action, JSON.stringify(payload)])).rows[0]
        .r as { status: string; cancelled: boolean },
      agent.correlationId,
      'agent',
    );
  }

  rotateKey(agent: AgentCaller, body: { signingKey: string; sealingKey: string }) {
    if (!p256Key(body.signingKey) || !p256Key(body.sealingKey) || body.signingKey === body.sealingKey) {
      throw ApiError.badRequest('invalid_key', 'The agent\'s keys must be two different P-256 public keys (SPKI, base64)');
    }
    return this.database.asApi(async (c) => {
      await c.query('select app.system_agent_rotate_key($1::uuid, $2, $3)', [agent.agentId, body.signingKey, body.sealingKey]);
      return { rotated: true, fingerprint: keyFingerprint(body.signingKey) };
    }, agent.correlationId, 'agent');
  }

  deregister(agent: AgentCaller) {
    return this.database.asApi(async (c) => {
      await c.query('select app.system_agent_deregister($1::uuid)', [agent.agentId]);
      return { deregistered: true };
    }, agent.correlationId, 'agent');
  }

  // ---------------------------------------------------------------- reading

  private agentRows(db: Db, org: string, id: string | null = null) {
    return db.execute(sql`
      select a.*, ${NAME('a.registered_by')} as registered_by_name, ${NAME('a.revoked_by')} as revoked_by_name,
             (select count(*) from public.integration_agent_jobs j where j.agent_id = a.id and j.status in ('pending', 'received', 'running')) as active_jobs,
             le.error_message as last_error_message, le.finished_at as last_error_at
        from public.integration_agents a
        left join lateral (select j.error_message, j.finished_at from public.integration_agent_jobs j
                            where j.agent_id = a.id and j.status = 'failed' and j.finished_at > now() - interval '7 days'
                            order by j.finished_at desc limit 1) le on true
       where a.organisation_id = ${org}::uuid and (${id}::uuid is null or a.id = ${id}::uuid)
       order by a.status, lower(a.name)`).then((r) => r.rows as Row[]);
  }

  private async own(db: Db, org: string, id: string) {
    const found = (await db.execute(sql`select 1 from public.integration_agents where id = ${id}::uuid and organisation_id = ${org}::uuid`)).rows;
    if (!found.length) throw ApiError.notFound('not_found', 'Agent not found');
  }

  private async detail(db: Db, org: string, id: string) {
    const rows = await this.agentRows(db, org, id);
    if (!rows.length) throw ApiError.notFound('not_found', 'Agent not found');
    const keys = (await db.execute(sql`
      select signing_key, status, created_at, retired_at from public.integration_agent_keys where agent_id = ${id}::uuid order by created_at desc limit 10`)).rows as Row[];
    const jobs = (await db.execute(sql`
      select j.*, ${NAME('j.requested_by')} as requested_by_name from public.integration_agent_jobs j
       where j.agent_id = ${id}::uuid order by j.created_at desc limit 20`)).rows as Row[];
    const events = (await db.execute(sql`
      select e.kind, e.detail, e.created_at, ${NAME('e.actor_user_id')} as actor_name from public.integration_agent_events e
       where e.agent_id = ${id}::uuid order by e.created_at desc limit 50`)).rows as Row[];
    return {
      ...agentRow(rows[0]),
      keys: keys.map((k) => ({ fingerprint: keyFingerprint(k.signing_key as string), status: k.status as string, createdAt: iso(k.created_at)!, retiredAt: iso(k.retired_at) })),
      jobs: jobs.map(job),
      events: events.map((e) => ({ kind: e.kind as string, detail: e.detail as Record<string, unknown>, at: iso(e.created_at)!, by: (e.actor_name as string | null) ?? null })),
    };
  }

  private async jobById(db: Db, org: string, jobId: string) {
    const r = (await db.execute(sql`
      select j.*, ${NAME('j.requested_by')} as requested_by_name from public.integration_agent_jobs j
       where j.id = ${jobId}::uuid and j.organisation_id = ${org}::uuid`)).rows[0] as Row | undefined;
    if (!r) throw ApiError.notFound('not_found', 'Job not found');
    return { ...job(r), agentId: r.agent_id as string };
  }
}
