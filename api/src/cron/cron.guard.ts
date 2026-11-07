import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { ApiError } from '../common/api-error';
import { ENV, Env } from '../config/env';

/**
 * Protects the scheduled jobs. Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when the project has a CRON_SECRET variable.
 * Without a secret configured the jobs answer 503 (never open); a wrong or missing one answers 401. The comparison takes the same time whatever is sent.
 */
@Injectable()
export class CronGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const secret = this.env.CRON_SECRET;
    if (!secret) throw new ApiError(503, 'cron_unavailable', 'Scheduled jobs are not set up on this server (CRON_SECRET is not set)');
    const header = context.switchToHttp().getRequest<Request>().headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = Buffer.from(given);
    const b = Buffer.from(secret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw ApiError.unauthenticated('Invalid or missing cron credentials');
    return true;
  }
}
