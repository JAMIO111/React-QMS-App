import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { Overview, OverviewQuery, PlatformMe } from './platform.schemas';
import { PlatformService } from './platform.service';

/**
 * The operator's area. Deliberately not organisation-scoped (it spans organisations) and read-only: it reads the platform's own tables through admin-only
 * database functions and never any organisation's business data. Access = on the platform allow-list AND an MFA session, enforced in the database.
 */
@ApiTags('platform')
@ApiBearerAuth()
@Controller('platform')
export class PlatformController {
  constructor(private readonly service: PlatformService) {}

  @Get('me')
  @ApiOkResponse({ description: 'Whether the caller may use the platform area', schema: openApiSchema(PlatformMe) })
  me(@Ctx() ctx: RequestContext) {
    return this.service.me(ctx);
  }

  @Get('overview')
  @ApiQuery({ name: 'days', required: false, schema: { type: 'integer', minimum: 1, maximum: 365 } })
  @ApiOkResponse({ description: 'The sign-up funnel for the period and the latest sign-ups (404 for non-operators, 403 mfa_required without MFA)', schema: openApiSchema(Overview) })
  overview(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.overview(ctx, parse(OverviewQuery, query));
  }
}
