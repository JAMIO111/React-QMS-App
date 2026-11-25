import { Versioned } from '../common/versioned';
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { CancelBody, CompleteBody, CoverageQuery, CreateStudyBody, DesignBody, ListQuery, ParseBody, RecordBody } from './msa.schemas';
import { MsaService } from './msa.service';

// Site-scoped role assignments count: row-level security then shows only the studies of gauges at the person's sites.
const SITE_SCOPED = { anyScope: true };
const READ = 'calibration.read';
const RECORD = 'calibration.record';
const MANAGE = 'calibration.manage';

/**
 * Gauge R&R and the other measurement system studies (docs/gauge-rr-plan.md). Reading needs calibration.read, entering readings calibration.record, and designing,
 * starting, completing, cancelling and repeating calibration.manage, all at the gauge's site (the database decides). Information only: nothing here changes a gauge.
 */
@ApiTags('measurement system analysis')
@ApiBearerAuth()
@Controller()
export class MsaController {
  constructor(private readonly service: MsaService) {}

  @Get('msa/studies')
  @OrganisationScoped(READ, SITE_SCOPED)
  @ApiOkResponse({ description: 'Studies the caller may read, page-based: { data, page, pageSize, total }; each with its progress, verdict, headline figure and validity' })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(ListQuery, query));
  }

  @Get('msa/coverage')
  @OrganisationScoped(READ, SITE_SCOPED)
  @ApiOkResponse({ description: 'Coverage: each critical or major characteristic of an effective control plan against the gauges that measured it in the last 12 months, with the state of the latest study; { available, reason, counts, rows }' })
  coverage(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.coverage(ctx, parse(CoverageQuery, query));
  }

  @Post('msa/studies')
  @HttpCode(201)
  @OrganisationScoped(MANAGE, SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(CreateStudyBody) })
  @ApiCreatedResponse({ description: 'Makes a draft study (MSA-YY-NNNN); the characteristic of a part\'s released revision can bring its name, unit and limits' })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateStudyBody, body));
  }

  @Versioned('msa_studies')
  @Get('msa/studies/:id')
  @OrganisationScoped(READ, SITE_SCOPED)
  @ApiOkResponse({ description: 'One study: design, appraisers, parts, the run sheet cells, progress, validity and what the caller may do' })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Versioned('msa_studies')
  @Patch('msa/studies/:id')
  @OrganisationScoped(MANAGE, SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(DesignBody) })
  @ApiOkResponse({ description: 'Changes the design of a draft study (counts, appraisers, parts, limits, options); locked once collecting' })
  updateDesign(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateDesign(ctx, parse(Uuid, id), parse(DesignBody, body));
  }

  @Post('msa/studies/:id/start')
  @HttpCode(200)
  @OrganisationScoped(MANAGE, SITE_SCOPED)
  @ApiOkResponse({ description: 'Starts collecting: makes every empty cell with a repeatable random run order and locks the design' })
  start(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.start(ctx, parse(Uuid, id));
  }

  @Put('msa/studies/:id/measurements')
  @OrganisationScoped(RECORD, SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(RecordBody) })
  @ApiOkResponse({ description: 'Enters readings (grid cells or pasted rows) while the study is collecting; a cell can be overwritten (audited). { recorded, progress }' })
  record(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.record(ctx, parse(Uuid, id), parse(RecordBody, body));
  }

  @Post('msa/studies/:id/measurements/parse')
  @HttpCode(200)
  @OrganisationScoped(RECORD, SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(ParseBody) })
  @ApiOkResponse({ description: 'Turns pasted text or CSV into cells without saving, with the rows that cannot be placed and why: { ok, cells, problems, rows }' })
  parse(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.parse(ctx, parse(Uuid, id), parse(ParseBody, body));
  }

  @Get('msa/studies/:id/analysis')
  @OrganisationScoped(READ, SITE_SCOPED)
  @ApiOkResponse({ description: 'The analysis: worked out from the readings stored now while collecting, the frozen result once completed' })
  analysis(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.analysis(ctx, parse(Uuid, id));
  }

  @Post('msa/studies/:id/complete')
  @HttpCode(200)
  @OrganisationScoped(MANAGE, SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(CompleteBody) })
  @ApiOkResponse({ description: 'Completes the study: every reading must be in; the result is worked out from the stored data, frozen with a hash of it, and the study is locked' })
  complete(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.complete(ctx, parse(Uuid, id), parse(CompleteBody, body));
  }

  @Post('msa/studies/:id/cancel')
  @HttpCode(200)
  @OrganisationScoped(MANAGE, SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(CancelBody) })
  @ApiOkResponse({ description: 'Cancels a draft or collecting study with a reason' })
  cancel(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.cancel(ctx, parse(Uuid, id), parse(CancelBody, body));
  }

  @Post('msa/studies/:id/repeat')
  @HttpCode(201)
  @OrganisationScoped(MANAGE, SITE_SCOPED)
  @ApiCreatedResponse({ description: 'A new draft with the design of a completed study (appraisers and parts copied, no readings)' })
  repeat(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.repeat(ctx, parse(Uuid, id));
  }

  @Get('msa/studies/:id/report')
  @OrganisationScoped(READ, SITE_SCOPED)
  @ApiOkResponse({ description: 'A completed study as a document: design, readings, the frozen result, and whether the stored readings still match its hash' })
  report(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.report(ctx, parse(Uuid, id));
  }

  @Get('gauges/:id/msa')
  @OrganisationScoped(READ, SITE_SCOPED)
  @ApiOkResponse({ description: 'The studies of one gauge: { current (latest completed per characteristic), open, earlier }' })
  gauge(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.gauge(ctx, parse(Uuid, id));
  }
}
