import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBasicAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { ReportingRoute } from './report-key-auth';
import { CreatedReportKey, CreateReportKeyBody, DatasetInfo, DatasetQuery, ReportKey, RevokeReportKeyBody } from './reporting.schemas';
import { ReportingService } from './reporting.service';

/**
 * Data for reporting tools such as Power BI (docs/reporting-api-plan.md). The datasets can be read with a person's sign-in or with a reporting key
 * (`Authorization: Bearer fqr_…`, or Basic with the key as the password); a key can call nothing else. The key routes need a person's sign-in.
 */
@ApiTags('reporting')
@ApiBearerAuth()
@ApiBasicAuth()
@Controller('reporting')
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  /** The same list at the address a reporting tool is pointed at, so a connection test against it succeeds with a valid key. */
  @Get('v1')
  @OrganisationScoped()
  @ReportingRoute()
  @ApiOkResponse({ description: 'The datasets and their columns (same as /v1/datasets)' })
  index() {
    return this.reporting.catalogue();
  }

  @Get('v1/datasets')
  @OrganisationScoped()
  @ReportingRoute()
  @ApiOkResponse({ description: 'The datasets and their columns', schema: { type: 'object', properties: { datasets: { type: 'array', items: openApiSchema(DatasetInfo) } } } })
  datasets() {
    return this.reporting.catalogue();
  }

  @Get('v1/:dataset')
  @OrganisationScoped()
  @ReportingRoute()
  @ApiParam({ name: 'dataset', description: 'A dataset key from GET /reporting/v1/datasets' })
  @ApiOkResponse({ description: '{ dataset, asOf, count, nextCursor, data }: up to `limit` rows, oldest change first; pass nextCursor as `after` for the next page' })
  page(@Ctx() ctx: RequestContext, @Param('dataset') dataset: string, @Query() query: unknown) {
    return this.reporting.page(ctx, dataset, parse(DatasetQuery, query));
  }

  @Get('keys')
  @OrganisationScoped('integrations.read')
  @ApiOkResponse({ description: 'The organisation’s reporting keys, newest first (never the keys themselves)', schema: { type: 'object', properties: { data: { type: 'array', items: openApiSchema(ReportKey) } } } })
  keys(@Ctx() ctx: RequestContext) {
    return this.reporting.listKeys(ctx);
  }

  @Post('keys')
  @OrganisationScoped('integrations.manage')
  @ApiBody({ schema: openApiSchema(CreateReportKeyBody) })
  @ApiCreatedResponse({ description: 'Makes a key that stands for the caller. The key is in `secret` and is shown only this once.', schema: openApiSchema(CreatedReportKey) })
  createKey(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.reporting.createKey(ctx, parse(CreateReportKeyBody, body));
  }

  @Post('keys/:id/revoke')
  @OrganisationScoped('integrations.manage')
  @ApiBody({ schema: openApiSchema(RevokeReportKeyBody) })
  @ApiOkResponse({ description: 'Revokes a key at once; it keeps its record', schema: openApiSchema(ReportKey) })
  revokeKey(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.reporting.revokeKey(ctx, parse(Uuid, id), parse(RevokeReportKeyBody, body));
  }
}
