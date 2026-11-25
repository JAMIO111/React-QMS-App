import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '../common/api-error';
import type { ApiRequest } from '../common/request-context';
import { REPORTING_ROUTE_KEY, ReportKeyAuth } from '../reporting/report-key-auth';
import { reportKeyFrom } from '../reporting/report-key';
import { JwtVerifier } from './jwt-verifier.service';

const PUBLIC = 'qms:public';
/** Marks a route as reachable without a token (e.g. health). Everything else requires sign-in. */
export const Public = () => SetMetadata(PUBLIC, true);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: JwtVerifier,
    private readonly reportKeys: ReportKeyAuth,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const req = context.switchToHttp().getRequest<ApiRequest>();
    const header = req.headers.authorization;
    // A reporting key (docs/reporting-api-plan.md): read-only, and only on the routes marked for it.
    const reportKey = reportKeyFrom(header);
    if (reportKey) {
      if (!this.reflector.getAllAndOverride<boolean>(REPORTING_ROUTE_KEY, [context.getHandler(), context.getClass()])) {
        throw new ApiError(403, 'report_key_scope', 'A reporting key can only read the reporting datasets (GET /api/v1/reporting/v1/...)');
      }
      await this.reportKeys.authenticate(req, reportKey);
      return true;
    }
    const match = header?.match(/^Bearer\s+(\S+)$/i);
    if (!match) throw ApiError.unauthenticated();
    req.user = await this.verifier.verify(match[1]);
    return true;
  }
}
