import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import { DatabaseService } from '../database/database.service';

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
}
