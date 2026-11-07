import { Controller, Get, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { z } from 'zod';
import { Public } from '../auth/auth.guard';
import { ApiRequest, resolveCorrelationId } from '../common/request-context';
import { parse } from '../common/validation';
import { CronGuard } from './cron.guard';
import { CronService } from './cron.service';

const ReconcileQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  staleMinutes: z.coerce.number().int().min(1).max(10080).default(60),
});
const ArchiveQuery = z.object({
  /** Defaults to true: a call without dryRun=false only reports. The schedule asks for dryRun=false. */
  dryRun: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  unpaidDays: z.coerce.number().int().min(7).max(365).default(14),
  lapsedDays: z.coerce.number().int().min(30).max(730).default(90),
});

/**
 * Scheduled jobs for Vercel Cron (which calls with GET) or by hand with curl (GET or POST). No sign-in and no organisation: the shared secret is the authentication.
 * Not in the OpenAPI document.
 */
@ApiExcludeController()
@Controller('internal/cron')
@Public()
@SkipThrottle()
@UseGuards(CronGuard)
export class CronController {
  constructor(private readonly cron: CronService) {}

  @Get('reconcile')
  reconcileGet(@Req() req: ApiRequest, @Query() query: unknown) {
    return this.reconcile(req, query);
  }

  @Post('reconcile')
  @HttpCode(200)
  reconcilePost(@Req() req: ApiRequest, @Query() query: unknown) {
    return this.reconcile(req, query);
  }

  @Get('abandoned-setups')
  archiveGet(@Req() req: ApiRequest, @Query() query: unknown) {
    return this.archive(req, query);
  }

  @Post('abandoned-setups')
  @HttpCode(200)
  archivePost(@Req() req: ApiRequest, @Query() query: unknown) {
    return this.archive(req, query);
  }

  private reconcile(req: ApiRequest, query: unknown) {
    const q = parse(ReconcileQuery, query);
    return this.cron.reconcile(q.limit, q.staleMinutes, resolveCorrelationId(req));
  }

  private archive(req: ApiRequest, query: unknown) {
    const q = parse(ArchiveQuery, query);
    return this.cron.archiveStale(q.unpaidDays, q.lapsedDays, q.dryRun, resolveCorrelationId(req));
  }
}
