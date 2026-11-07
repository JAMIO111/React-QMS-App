import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { InspectionDetail, InspectionPage } from '../inspection/inspection.schemas';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { JobDetailsBody, JobNcrs, JobPreview, JobQuery, JobRevisions, RecentQuery, StartJobBody } from './jobs.schemas';
import { JobsService } from './jobs.service';

const RECORD = 'inspection.record';

/** Operator jobs: a streamlined way to start and run an in-process inspection (docs/operator-hub-plan.md). */
@ApiTags('jobs')
@ApiBearerAuth()
@Controller('jobs')
export class JobsController {
  constructor(private readonly service: JobsService) {}

  /** What starting a job on this machine with this part would do (site, operation, whether anything blocks it). */
  @Get('preview')
  @OrganisationScoped(RECORD)
  @ApiQuery({ name: 'machineId', schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'partId', schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'operationCode', required: false, schema: { type: 'string' } })
  @ApiOkResponse({ schema: openApiSchema(JobPreview) })
  preview(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.preview(ctx, parse(JobQuery, query));
  }

  /** The caller's running jobs. */
  @Get('mine')
  @OrganisationScoped(RECORD)
  @ApiOkResponse({ schema: openApiSchema(InspectionPage) })
  mine(@Ctx() ctx: RequestContext) {
    return this.service.mine(ctx);
  }

  /** Start a job from a machine and a part; the site, operation, start time and operator are worked out. Answers with the inspection record. */
  @Post()
  @HttpCode(201)
  @OrganisationScoped(RECORD)
  @ApiBody({ schema: openApiSchema(StartJobBody) })
  @ApiCreatedResponse({ schema: openApiSchema(InspectionDetail) })
  start(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.start(ctx, parse(StartJobBody, body));
  }

  /** Fill in or correct the work order, lot, quantity and serial while the job runs. */
  @Patch(':id')
  @OrganisationScoped(RECORD)
  @ApiBody({ schema: openApiSchema(JobDetailsBody) })
  @ApiOkResponse({ schema: openApiSchema(InspectionDetail) })
  details(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.details(ctx, parse(Uuid, id), parse(JobDetailsBody, body));
  }

  @Get(':id/recent-ncrs')
  @OrganisationScoped(RECORD)
  @ApiQuery({ name: 'days', required: false, schema: { type: 'integer', minimum: 1, maximum: 365, default: 90 } })
  @ApiOkResponse({ schema: openApiSchema(JobNcrs) })
  recentNcrs(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return this.service.recentNcrs(ctx, parse(Uuid, id), parse(RecentQuery, query));
  }

  @Get(':id/revisions')
  @OrganisationScoped(RECORD)
  @ApiQuery({ name: 'days', required: false, schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 } })
  @ApiOkResponse({ schema: openApiSchema(JobRevisions) })
  revisions(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return this.service.revisions(ctx, parse(Uuid, id), parse(RecentQuery.extend({ days: RecentQuery.shape.days.default(30) }), query));
  }
}
