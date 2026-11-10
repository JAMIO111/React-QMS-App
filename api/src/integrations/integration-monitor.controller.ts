import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { AttentionList, AttentionQuery, DecideMissingBody, Health, IgnoreRowsBody, MissingListQuery, MissingPage, RestoreRowsBody, RowsChanged } from './integration-monitor.schemas';
import { IntegrationMonitorService } from './integration-monitor.service';

/**
 * Keeping imports healthy (IN8): health per connection and kind of record, records a full read no longer contained, and rows that need a person.
 * Reading needs `integrations.read`; deciding and ignoring need `integrations.run` (deciding on records also the permission to edit them).
 */
@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations')
export class IntegrationMonitorController {
  constructor(private readonly service: IntegrationMonitorService) {}

  @Get('health')
  @OrganisationScoped('integrations.read')
  @ApiOkResponse({ description: 'Every connection and kind of record: schedule, last run, last success, failures in a row and what waits for a person', schema: openApiSchema(Health) })
  health(@Ctx() ctx: RequestContext) {
    return this.service.health(ctx);
  }

  @Get('missing-records')
  @OrganisationScoped('integrations.read')
  @ApiOkResponse({ description: 'Records a full read no longer contained: open (listed or held) by default, decided, or all', schema: openApiSchema(MissingPage) })
  missing(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.missing(ctx, parse(MissingListQuery, query));
  }

  @Post('missing-records/decide')
  @HttpCode(200)
  @OrganisationScoped('integrations.run')
  @ApiBody({ schema: openApiSchema(DecideMissingBody) })
  @ApiOkResponse({ description: 'Makes the records inactive, or keeps them active with a reason. A decision is final.' })
  decide(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.decideMissing(ctx, parse(DecideMissingBody, body));
  }

  @Get('connections/:id/attention')
  @OrganisationScoped('integrations.read')
  @ApiOkResponse({ description: 'The newest copy of each source record that was rejected or failed and not since imported, or the ignored ones', schema: openApiSchema(AttentionList) })
  attention(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return this.service.attention(ctx, parse(Uuid, id), parse(AttentionQuery, query));
  }

  @Post('connections/:id/rows/ignore')
  @HttpCode(200)
  @OrganisationScoped('integrations.run')
  @ApiBody({ schema: openApiSchema(IgnoreRowsBody) })
  @ApiOkResponse({ description: 'Ignores rejected or failed rows with a reason; they stop needing a person', schema: openApiSchema(RowsChanged) })
  ignore(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.ignore(ctx, parse(Uuid, id), parse(IgnoreRowsBody, body));
  }

  @Post('connections/:id/rows/restore')
  @HttpCode(200)
  @OrganisationScoped('integrations.run')
  @ApiBody({ schema: openApiSchema(RestoreRowsBody) })
  @ApiOkResponse({ description: 'Brings ignored rows back as they were', schema: openApiSchema(RowsChanged) })
  restore(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.restore(ctx, parse(Uuid, id), parse(RestoreRowsBody, body));
  }
}
