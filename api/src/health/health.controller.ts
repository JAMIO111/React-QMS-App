import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import { DatabaseService } from '../database/database.service';
import { clientAddress } from '../security/client-address';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  @Public()
  @SkipThrottle()
  @ApiOkResponse({ description: 'API and database reachable', schema: { example: { status: 'ok', checks: { database: 'ok' } } } })
  @ApiServiceUnavailableResponse({ description: 'Database unreachable' })
  async health() {
    try {
      await this.db.ping();
    } catch {
      throw ApiError.unavailable('Database unreachable');
    }
    return { status: 'ok', checks: { database: 'ok' } };
  }

  /**
   * TEMPORARY (docs/security-plan.md SE0): what address the API would check for this request, and the raw forwarding headers it received, so
   * the proxy set-up can be confirmed on each deployment (a forged X-Forwarded-For must not change `address`). Removed in SE2, where the
   * signed-in `/security/access-policy` reports the caller's address instead.
   */
  @Get('network')
  @Public()
  @ApiOkResponse({ description: 'The caller\u2019s address as the API sees it (diagnostic, temporary)' })
  network(@Req() req: Request) {
    const h = (name: string) => {
      const v = req.headers[name];
      return Array.isArray(v) ? v.join(', ') : (v ?? null);
    };
    return {
      address: clientAddress(req.ip),
      reqIp: req.ip ?? null,
      reqIps: req.ips,
      socket: req.socket?.remoteAddress ?? null,
      trustProxy: req.app.get('trust proxy') ?? false,
      headers: {
        'x-forwarded-for': h('x-forwarded-for'),
        'x-real-ip': h('x-real-ip'),
        'x-vercel-forwarded-for': h('x-vercel-forwarded-for'),
        forwarded: h('forwarded'),
        'cf-connecting-ip': h('cf-connecting-ip'),
      },
    };
  }
}
