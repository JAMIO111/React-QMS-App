import { CanActivate, ExecutionContext, Injectable, createParamDecorator } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ApiError } from '../../common/api-error';
import { resolveCorrelationId, type ApiRequest } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { clientAddress } from '../../security/client-address';
import { AGENT_HEADERS, freshTimestamp, validNonce, verifySignature } from './agent-signature';

export interface AgentCaller {
  agentId: string;
  organisationId: string;
  address: string | null;
  correlationId: string;
}

type AgentRequest = RawBodyRequest<Request> & ApiRequest & { agent?: AgentCaller };

const header = (req: Request, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authenticates a Connector Agent's request (docs/connector-agent-plan.md AG-D2, AG-D10): the agent id, a fresh timestamp, a one-off nonce and an
 * ECDSA P-256 signature over the canonical string, checked against the agent's active key in the database; then the nonce is recorded (a repeat is
 * a replay) and the organisation's network rule is applied as for a person. The route must also be @Public() (no person's token).
 * Every refusal is a 401 that says only what the agent can act on; a network refusal is a 403 network_not_allowed with the address.
 */
@Injectable()
export class AgentGuard implements CanActivate {
  private readonly failures = new FailureLimiter();

  constructor(private readonly database: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AgentRequest>();
    const from = clientAddress(req.ip) ?? 'unknown';
    // Agents skip the per-person rate limit (they poll), so failed sign-ins are limited here instead, before any database work (AG6d review).
    if (this.failures.blocked(from)) {
      throw new ApiError(429, 'agent_too_many_failures', 'Too many unsigned or wrongly signed requests from this address; wait a minute');
    }
    try {
      return await this.check(req);
    } catch (e) {
      if (e instanceof ApiError && e.getStatus() === 401) this.failures.record(from);
      throw e;
    }
  }

  private async check(req: AgentRequest): Promise<boolean> {
    const correlationId = resolveCorrelationId(req);
    const agentId = header(req, AGENT_HEADERS.id);
    const timestamp = header(req, AGENT_HEADERS.timestamp);
    const nonce = header(req, AGENT_HEADERS.nonce);
    const signature = header(req, AGENT_HEADERS.signature);
    if (!agentId || !UUID.test(agentId) || !validNonce(nonce) || !signature) {
      throw new ApiError(401, 'agent_unauthenticated', 'This request is not signed by a connector agent');
    }
    if (!freshTimestamp(timestamp)) {
      throw new ApiError(401, 'agent_clock', 'The agent\'s clock is more than five minutes away from Fortress\'s. Check the time on the agent\'s machine.');
    }
    const identity = await this.database.asApi(
      async (c) => (await c.query('select app.system_agent_identity($1::uuid) as r', [agentId])).rows[0]?.r as
        | { organisationId: string; status: string; signingKey: string | null }
        | null,
      correlationId,
      'agent',
    );
    if (!identity) throw new ApiError(401, 'agent_unauthenticated', 'This agent is not registered with Fortress');
    if (identity.status !== 'active') throw new ApiError(401, 'agent_revoked', 'This agent has been revoked in Fortress. Register it again to use it.');
    const ok = verifySignature(identity.signingKey, { method: req.method, path: req.originalUrl, body: req.rawBody ?? (Buffer.isBuffer(req.body) ? req.body : undefined), timestamp: timestamp!, nonce, agentId }, signature);
    if (!ok) throw new ApiError(401, 'agent_unauthenticated', 'The request\'s signature does not match this agent\'s key');

    const address = clientAddress(req.ip);
    const seen = await this.database.asApi(
      async (c) => (await c.query('select app.system_agent_seen($1::uuid, $2, $3, $4) as r', [agentId, nonce, address, req.originalUrl])).rows[0].r as
        { ok: boolean; reason?: string },
      correlationId,
      'agent',
    );
    if (!seen.ok) {
      if (seen.reason === 'network') {
        throw new ApiError(403, 'network_not_allowed', 'This organisation does not allow access from the agent\'s network', { address });
      }
      if (seen.reason === 'revoked') throw new ApiError(401, 'agent_revoked', 'This agent has been revoked in Fortress. Register it again to use it.');
      throw new ApiError(401, 'agent_replay', 'This request has already been seen');
    }
    req.agent = { agentId, organisationId: identity.organisationId, address, correlationId };
    return true;
  }
}

/** The authenticated agent on a route guarded by AgentGuard. */
export const Agent = createParamDecorator((_: unknown, ctx: ExecutionContext): AgentCaller => {
  const agent = ctx.switchToHttp().getRequest<AgentRequest>().agent;
  if (!agent) throw new ApiError(401, 'agent_unauthenticated', 'This request is not signed by a connector agent');
  return agent;
});

/**
 * Failed agent sign-ins per address in a sliding minute, kept in this process. Past the limit, requests from that address are refused before the
 * database is asked anything. A real agent never fails like this (a revoked or reinstalled one stops by itself), so the limit is low.
 */
export class FailureLimiter {
  private readonly seen = new Map<string, number[]>();

  constructor(
    readonly limit = 30,
    readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(address: string): number[] {
    const since = this.now() - this.windowMs;
    const list = (this.seen.get(address) ?? []).filter((t) => t > since);
    if (list.length) this.seen.set(address, list);
    else this.seen.delete(address);
    return list;
  }

  blocked(address: string): boolean {
    return this.recent(address).length >= this.limit;
  }

  record(address: string): void {
    const list = this.recent(address);
    list.push(this.now());
    this.seen.set(address, list);
    if (this.seen.size > 10_000) this.seen.delete(this.seen.keys().next().value!);
  }
}
