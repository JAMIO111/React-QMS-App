import { Injectable, SetMetadata } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { resolveCorrelationId, type ApiRequest } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { clientAddress } from '../security/client-address';
import { hashReportKey, looksLikeReportKey } from './report-key';

const REPORTING_ROUTE = 'qms:reporting-route';
/**
 * Marks a route a reporting key may call (docs/reporting-api-plan.md R5). Used only on GET routes under /reporting/v1. A key sent to any other route is refused,
 * so a leaked key can never write, make more keys or read the rest of the API.
 */
export const ReportingRoute = () => SetMetadata(REPORTING_ROUTE, true);
export const REPORTING_ROUTE_KEY = REPORTING_ROUTE;

const WINDOW_MS = 60_000;
const MAX_FAILURES = 30;

/**
 * Turns a reporting key into the person who made it, before the ordinary guards run: it sets `req.user` (their id and email, role "authenticated", `aal2` because
 * making a key needed a two-factor session, and no `amr`, so single sign-on and session-age rules do not apply to it; its own expiry does) and puts the key's
 * organisation in the organisation header. Every other check then runs unchanged: active membership, seat, network rule, permission, row-level security.
 * Failed attempts are limited by address, before any database work.
 */
@Injectable()
export class ReportKeyAuth {
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly database: DatabaseService) {}

  async authenticate(req: ApiRequest, secret: string): Promise<void> {
    const address = clientAddress(req.ip) ?? 'unknown';
    if (this.blocked(address)) throw new ApiError(429, 'report_key_too_many_failures', 'Too many wrong reporting keys from this address; wait a minute');
    if (!looksLikeReportKey(secret)) return this.refuse(address);
    const who = await this.database.asApi(
      async (c) =>
        (await c.query('select app.system_report_key_lookup($1, $2) as r', [hashReportKey(secret), address === 'unknown' ? null : address])).rows[0]?.r as
          | { keyId: string; organisationId: string; userId: string; email: string | null }
          | null,
      resolveCorrelationId(req),
      'reporting',
    );
    if (!who) return this.refuse(address);
    req.user = {
      id: who.userId,
      email: who.email ?? undefined,
      claims: { sub: who.userId, email: who.email ?? undefined, role: 'authenticated', aal: 'aal2', report_key: who.keyId },
    };
    req.reportKey = { keyId: who.keyId, organisationId: who.organisationId };
    req.headers['x-organisation-id'] = who.organisationId;
  }

  private refuse(address: string): never {
    const now = Date.now();
    const list = (this.failures.get(address) ?? []).filter((t) => now - t < WINDOW_MS);
    list.push(now);
    this.failures.set(address, list);
    if (this.failures.size > 5_000) this.failures.clear();
    throw new ApiError(401, 'report_key_invalid', 'This reporting key is not valid. It may have expired, been revoked, or its owner may no longer have access.');
  }

  private blocked(address: string): boolean {
    const now = Date.now();
    const list = (this.failures.get(address) ?? []).filter((t) => now - t < WINDOW_MS);
    return list.length >= MAX_FAILURES;
  }
}
