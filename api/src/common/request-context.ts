import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { JWTPayload } from 'jose';
import { clientAddress } from '../security/client-address';

export interface AuthenticatedUser {
  id: string;
  email?: string;
  /** Verified token claims, passed to Postgres as request.jwt.claims (role forced to authenticated). */
  claims: JWTPayload;
}

export type ApiRequest = Request & {
  correlationId?: string;
  user?: AuthenticatedUser;
  organisationId?: string;
  /** Versions a save says it was based on ({ "<table>:<id>": version }), set by VersionInterceptor (docs/edit-conflicts-plan.md). */
  expectedVersions?: Record<string, string>;
};

export interface RequestContext {
  user: AuthenticatedUser;
  correlationId: string;
  /** Optional free-text reason for a change (X-Change-Reason), recorded in the audit trail. */
  reason?: string;
  organisationId?: string;
  /** The person's IANA time zone (X-Time-Zone), validated; "UTC" when absent or unknown. Postgres runs the request in it, so current_date is their today. */
  timeZone?: string;
  /** The caller's address as the API sees it (req.ip behind the trusted proxy hops; docs/security-plan.md S2), or null when it cannot be read. */
  address?: string | null;
  /** Versions this request's save was based on; DatabaseService.asUser hands them to the database (app.expected_versions). */
  expectedVersions?: Record<string, string>;
}

export const CORRELATION_HEADER = 'x-correlation-id';
const CORRELATION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const REASON_MAX = 500;
const ZONE_PATTERN = /^[A-Za-z0-9_+\-/]{1,64}$/;

/** A time zone name the runtime knows, else UTC. Never throws: a bad header must not break a request. */
export function validTimeZone(value: unknown): string {
  const zone = Array.isArray(value) ? value[0] : value;
  if (typeof zone !== 'string' || !ZONE_PATTERN.test(zone)) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

/** Accepts a well-formed X-Correlation-Id or generates one; idempotent per request; echoes it back. */
export function resolveCorrelationId(req: ApiRequest, res?: Response): string {
  if (!req.correlationId) {
    const incoming = req.headers[CORRELATION_HEADER];
    const value = Array.isArray(incoming) ? incoming[0] : incoming;
    req.correlationId = value && CORRELATION_PATTERN.test(value) ? value : randomUUID();
  }
  if (res && !res.headersSent) res.setHeader('X-Correlation-Id', req.correlationId);
  return req.correlationId;
}

export function contextFrom(req: ApiRequest): RequestContext {
  if (!req.user) throw new Error('contextFrom() used on an unauthenticated route');
  const rawReason = req.headers['x-change-reason'];
  const reason = (Array.isArray(rawReason) ? rawReason[0] : rawReason)?.trim().slice(0, REASON_MAX);
  return {
    user: req.user,
    correlationId: resolveCorrelationId(req),
    reason: reason || undefined,
    organisationId: req.organisationId,
    timeZone: validTimeZone(req.headers['x-time-zone']),
    address: clientAddress(req.ip),
    expectedVersions: req.expectedVersions,
  };
}

/** Injects the RequestContext of an authenticated request into a controller method. */
export const Ctx = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestContext =>
  contextFrom(ctx.switchToHttp().getRequest<ApiRequest>()),
);
