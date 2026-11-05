import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { pageSchema } from '../common/pagination';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  AbandonBody,
  AddSampleBody,
  CorrectionBody,
  InspectionDetail,
  InspectionListQuery,
  InspectionSummary,
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
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } })
  @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string' }, description: 'Reference, part number, work order, lot or serial' })
  @ApiQuery({ name: 'status', required: false, schema: { type: 'string', enum: ['in_progress', 'completed', 'abandoned'] } })
  @ApiQuery({ name: 'result', required: false, schema: { type: 'string', enum: ['pass', 'fail'] } })
  @ApiQuery({ name: 'partId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ schema: openApiSchema(pageSchema(InspectionSummary)) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(InspectionListQuery, query));
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
