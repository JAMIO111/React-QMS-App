import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { ExternalRecordPage, ExternalRecordQuery, InboxRowPage, RequestRunBody, RetryBody, RowListQuery, RunDetail, RunListQuery, RunPage } from './integration-runs.schemas';
import { IntegrationRunsService } from './integration-runs.service';
import { EmptyBody, ReasonBody } from './integrations.schemas';

const READ = 'integrations.read';
const RUN = 'integrations.run';

/**
 * Import runs (IN2): previews, full and incremental imports, retries of failed rows, their rows and the map of source records to QMS records.
 * Asking for a run works it for up to about 20 seconds in the same request; `drain.state` says whether it finished or needs `continue`.
 */
@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations')
export class IntegrationRunsController {
  constructor(private readonly service: IntegrationRunsService) {}

  @Get('runs')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Import runs, newest first (filter by connection and status)', schema: openApiSchema(RunPage) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(RunListQuery, query));
  }

  @Get('runs/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'One run: counts, run-level errors and its rows by status now', schema: openApiSchema(RunDetail) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Get('runs/:id/rows')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The rows a run staged or worked on, with their errors and payloads (cleared after the retention period)', schema: openApiSchema(InboxRowPage) })
  rows(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return this.service.rows(ctx, parse(Uuid, id), parse(RowListQuery, query));
  }

  @Post('runs/:id/continue')
  @HttpCode(200)
  @OrganisationScoped(RUN)
  @ApiBody({ schema: openApiSchema(EmptyBody) })
  @ApiOkResponse({ description: 'Works an unfinished run for a while longer', schema: openApiSchema(RunDetail) })
  continue(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    parse(EmptyBody, body ?? {});
    return this.service.continue(ctx, parse(Uuid, id));
  }

  @Post('runs/:id/cancel')
  @HttpCode(200)
  @OrganisationScoped(RUN)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Cancels a queued or running import; what it applied stays', schema: openApiSchema(RunDetail) })
  cancel(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.cancel(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }

  @Post('connections/:id/runs')
  @HttpCode(201)
  @OrganisationScoped(RUN)
  @ApiBody({ schema: openApiSchema(RequestRunBody) })
  @ApiCreatedResponse({ description: 'Starts a preview (nothing written; before activation too), a full or an incremental import, and works it for a while', schema: openApiSchema(RunDetail) })
  request(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.request(ctx, parse(Uuid, id), parse(RequestRunBody, body));
  }

  @Post('connections/:id/retry')
  @HttpCode(201)
  @OrganisationScoped(RUN)
  @ApiBody({ schema: openApiSchema(RetryBody) })
  @ApiCreatedResponse({ description: 'Retries failed rows of a kind of record (all, or the ones named) against the current map', schema: openApiSchema(RunDetail) })
  retry(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.retry(ctx, parse(Uuid, id), parse(RetryBody, body));
  }

  @Get('connections/:id/external-records')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Which QMS record each source record became', schema: openApiSchema(ExternalRecordPage) })
  externalRecords(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return this.service.externalRecords(ctx, parse(Uuid, id), parse(ExternalRecordQuery, query));
  }
}
