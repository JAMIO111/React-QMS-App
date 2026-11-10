import { pickCustomFilters } from '../custom-fields/custom-values';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  AbandonBody,
  AcknowledgeBody,
  AddSampleBody,
  AddToNcrBody,
  CorrectionBody,
  DraftQuery,
  GaugeUsage,
  InspectionDetail,
  INSPECTION_SORTABLE,
  InspectionListQuery,
  InspectionPage,
  InspectionSummary,
  NcDraft,
  NcrInspectionSource,
  RaiseNcrBody,
  RaisedNcr,
  StartInspectionBody,
} from './inspection.schemas';
import { InspectionService } from './inspection.service';

const READ = 'inspection.read';
const RECORD = 'inspection.record';

@ApiTags('inspections')
@ApiBearerAuth()
@Controller('inspections')
export class InspectionsController {
  constructor(private readonly service: InspectionService) {}

  @Get()
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string' }, description: 'Reference, part number, work order, lot or serial' })
  @ApiQuery({ name: 'status', required: false, schema: { type: 'string' }, description: 'Comma-separated: in_progress, completed, abandoned' })
  @ApiQuery({ name: 'result', required: false, schema: { type: 'string' }, description: 'Comma-separated: pass, fail' })
  @ApiQuery({ name: 'trigger', required: false, schema: { type: 'string' }, description: 'Comma-separated sampling triggers' })
  @ApiQuery({ name: 'partId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'siteId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'machineId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'productionOrderId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'lotId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'serialId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'from', required: false, schema: { type: 'string' }, description: 'Started on or after (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: false, schema: { type: 'string' }, description: 'Started on or before (YYYY-MM-DD)' })
  @ApiQuery({ name: 'sort', required: false, schema: { type: 'string', enum: [...INSPECTION_SORTABLE], default: 'startedAt' } })
  @ApiQuery({ name: 'order', required: false, schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1, default: 1 } })
  @ApiQuery({ name: 'pageSize', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 } })
  @ApiOkResponse({ schema: openApiSchema(InspectionPage) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(InspectionListQuery, query), pickCustomFilters(query));
  }

  /** Start an inspection: resolves and freezes the requirements, or refuses (409 inspection_rule) with the reasons. */
  @Post()
  @HttpCode(201)
  @OrganisationScoped(RECORD)
  @ApiBody({ schema: openApiSchema(StartInspectionBody) })
  @ApiCreatedResponse({ schema: openApiSchema(InspectionDetail) })
  start(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.start(ctx, parse(StartInspectionBody, body));
  }

  @Get(':id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(InspectionDetail) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  /** Add a sample with its readings (all or nothing). */
  @Post(':id/samples')
  @HttpCode(201)
  @OrganisationScoped(RECORD)
  @ApiBody({ schema: openApiSchema(AddSampleBody) })
  @ApiCreatedResponse({ schema: openApiSchema(InspectionDetail) })
  addSample(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addSample(ctx, parse(Uuid, id), parse(AddSampleBody, body));
  }

  /** Complete: every applicable check must have a reading; the result is worked out by the database. */
  @Post(':id/complete')
  @HttpCode(200)
  @OrganisationScoped(RECORD)
  @ApiOkResponse({ schema: openApiSchema(InspectionDetail) })
  complete(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.complete(ctx, parse(Uuid, id));
  }

  /** The suggested NC for failed readings (default: current failures without an NC): pre-filled text, severity, quantity, containment window. */
  @Get(':id/ncr-draft')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'measurementIds', required: false, schema: { type: 'string' }, description: 'Comma-separated failed readings' })
  @ApiOkResponse({ schema: openApiSchema(NcDraft) })
  ncrDraft(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return this.service.ncrDraft(ctx, parse(Uuid, id), parse(DraftQuery, query));
  }

  /** Raise an NC (source internal) for failed readings — or for the inspection as a whole — linked permanently. */
  @Post(':id/raise-ncr')
  @HttpCode(201)
  @OrganisationScoped('ncr.create')
  @ApiBody({ schema: openApiSchema(RaiseNcrBody) })
  @ApiCreatedResponse({ schema: openApiSchema(RaisedNcr) })
  raiseNcr(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.raiseNcr(ctx, parse(Uuid, id), parse(RaiseNcrBody, body));
  }

  /** Add later failed readings to an NC already raised from this inspection (draft … awaiting closure; refused when closed or cancelled). */
  @Post(':id/add-to-ncr')
  @HttpCode(200)
  @OrganisationScoped('ncr.update')
  @ApiBody({ schema: openApiSchema(AddToNcrBody) })
  @ApiOkResponse({ schema: openApiSchema(InspectionDetail) })
  addToNcr(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addToNcr(ctx, parse(Uuid, id), parse(AddToNcrBody, body));
  }

  @Post(':id/abandon')
  @HttpCode(200)
  @OrganisationScoped(RECORD)
  @ApiBody({ schema: openApiSchema(AbandonBody) })
  @ApiOkResponse({ schema: openApiSchema(InspectionDetail) })
  abandon(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.abandon(ctx, parse(Uuid, id), parse(AbandonBody, body));
  }
}

@ApiTags('inspections')
@ApiBearerAuth()
@Controller('inspection-measurements')
export class InspectionMeasurementsController {
  constructor(private readonly service: InspectionService) {}

  /** A person has seen this failed reading and says what is being done (a note is required). */
  @Post(':id/acknowledge')
  @HttpCode(201)
  @OrganisationScoped(RECORD)
  @ApiBody({ schema: openApiSchema(AcknowledgeBody) })
  @ApiCreatedResponse({ schema: openApiSchema(InspectionDetail) })
  acknowledge(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.acknowledge(ctx, parse(Uuid, id), parse(AcknowledgeBody, body));
  }

  /** Correct a reading: a new reading with a reason replaces it; the original is kept (needs inspection.correct). */
  @Post(':id/correction')
  @HttpCode(201)
  @OrganisationScoped(RECORD)
  @ApiBody({ schema: openApiSchema(CorrectionBody) })
  @ApiCreatedResponse({ schema: openApiSchema(InspectionDetail) })
  correct(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.correct(ctx, parse(Uuid, id), parse(CorrectionBody, body));
  }
}

/** The inspection behind a non-conformance raised from an inspection. */
@ApiTags('inspections')
@ApiBearerAuth()
@Controller('ncrs')
export class NcrInspectionSourceController {
  constructor(private readonly service: InspectionService) {}

  @Get(':id/inspection-source')
  @OrganisationScoped('ncr.read')
  @ApiOkResponse({ schema: openApiSchema(NcrInspectionSource) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.ncrSource(ctx, parse(Uuid, id));
  }
}

/** Impact assessment for a calibration found out of tolerance. */
@ApiTags('inspections')
@ApiBearerAuth()
@Controller('calibrations')
export class GaugeUsageController {
  constructor(private readonly service: InspectionService) {}

  /** Inspections that used the gauge since its previous calibration. Reads only. */
  @Get(':id/gauge-usage')
  @OrganisationScoped('calibration.read')
  @ApiOkResponse({ schema: openApiSchema(GaugeUsage) })
  usage(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.gaugeUsage(ctx, parse(Uuid, id));
  }
}
