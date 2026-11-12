import { Controller, Get, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { z } from 'zod';
import { Public } from '../auth/auth.guard';
import { ApiRequest, resolveCorrelationId } from '../common/request-context';
import { parse } from '../common/validation';
import { CronGuard } from '../cron/cron.guard';
import { WorkerService } from './worker.service';

const TickQuery = z.object({
  source: z.enum(['pg_cron', 'vercel', 'manual']).default('manual'),
  budgetMs: z.coerce.number().int().min(1_000).max(50_000).default(45_000),
});

/**
 * The worker's tick (WK1). pg_cron in Supabase calls `POST /internal/worker/tick?source=pg_cron` every minute through pg_net; it can also be called by
 * hand with curl. The shared cron secret is the authentication (`Authorization: Bearer <CRON_SECRET>`). Not in the OpenAPI document.
 */
@ApiExcludeController()
@Controller('internal/worker')
@Public()
@SkipThrottle()
@UseGuards(CronGuard)
export class WorkerController {
  constructor(private readonly worker: WorkerService) {}

  @Post('tick')
  @HttpCode(200)
  tickPost(@Req() req: ApiRequest, @Query() query: unknown) {
    const q = parse(TickQuery, query);
    return this.worker.tick({ source: q.source, budgetMs: q.budgetMs, correlationId: resolveCorrelationId(req) });
  }

  @Get('tick')
  tickGet(@Req() req: ApiRequest, @Query() query: unknown) {
    const q = parse(TickQuery, query);
    return this.worker.tick({ source: q.source, budgetMs: q.budgetMs, correlationId: resolveCorrelationId(req) });
  }
}
