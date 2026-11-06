import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { z } from 'zod';
import { AcknowledgeAlertBody, AlertOut, AlertsOut, AlertsQuery, Analysis, AnalysisQuery, Baseline, BaselineQuery, CharacteristicOption, CharacteristicsQuery, Chart, ChartQuery, CreateBaselineBody } from './spc.schemas';
import { SpcService } from './spc.service';

const READ = 'spc.read';
const MANAGE = 'spc.manage';

/** SPC control charts: read live from the inspection measurements, never copied. */
@ApiTags('spc')
@ApiBearerAuth()
@Controller('spc')
export class SpcController {
  constructor(private readonly service: SpcService) {}

  /** Characteristics of a part with numeric readings that the control plan marks for SPC. */
  @Get('characteristics')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'partId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'partFamilyId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'all', required: false, schema: { type: 'string', enum: ['true', 'false'] } })
  @ApiOkResponse({ schema: openApiSchema(z.array(CharacteristicOption)) })
  characteristics(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.characteristics(ctx, parse(CharacteristicsQuery, query));
  }

  /** One control chart: points, limits (saved baseline or trial), signals, what was left out and why. */
  @Get('chart')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'partId', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'characteristicKey', required: true, schema: { type: 'string' } })
  @ApiQuery({ name: 'operationCode', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'from', required: false, schema: { type: 'string', format: 'date-time' } })
  @ApiQuery({ name: 'to', required: false, schema: { type: 'string', format: 'date-time' } })
  @ApiQuery({ name: 'machineId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'lot', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'rules', required: false, schema: { type: 'string' }, description: 'Comma-separated: we1,we2,we3,we4' })
  @ApiOkResponse({ schema: openApiSchema(Chart) })
  chart(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.chart(ctx, parse(ChartQuery, query));
  }

  /**
   * Compares one characteristic between machines (for a part or a whole family) or between the parts of a family:
   * readings, mean and spread, position in the tolerance, Pp/Ppk, failure rate or defects per unit, and which groups
   * are clearly different from the rest.
   */
  @Get('analysis')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'groupBy', required: true, schema: { type: 'string', enum: ['machine', 'part'] } })
  @ApiQuery({ name: 'partId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'partFamilyId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'characteristicKey', required: true, schema: { type: 'string' } })
  @ApiQuery({ name: 'operationCode', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'from', required: false, schema: { type: 'string', format: 'date-time' } })
  @ApiQuery({ name: 'to', required: false, schema: { type: 'string', format: 'date-time' } })
  @ApiOkResponse({ schema: openApiSchema(Analysis) })
  analysis(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.analysis(ctx, parse(AnalysisQuery, query));
  }

  /** Alerts raised by control-chart signals on newly recorded points, newest first, with the number still open. */
  @Get('alerts')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'status', required: false, schema: { type: 'string', enum: ['open', 'acknowledged', 'all'] } })
  @ApiQuery({ name: 'partId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer' } })
  @ApiOkResponse({ schema: openApiSchema(AlertsOut) })
  alerts(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.alerts(ctx, parse(AlertsQuery, query));
  }

  /** Records that somebody looked into an alert and what was done (once; needs spc.manage). */
  @Post('alerts/:id/acknowledge')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(AcknowledgeAlertBody) })
  @ApiOkResponse({ schema: openApiSchema(AlertOut) })
  acknowledgeAlert(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.acknowledgeAlert(ctx, parse(z.string().uuid(), id), parse(AcknowledgeAlertBody, body));
  }

  /** Baseline history for a characteristic, newest first (superseded ones stay visible). */
  @Get('baselines')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'partId', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'characteristicKey', required: true, schema: { type: 'string' } })
  @ApiQuery({ name: 'operationCode', required: false, schema: { type: 'string' } })
  @ApiOkResponse({ schema: openApiSchema(z.array(Baseline)) })
  baselines(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.baselines(ctx, parse(BaselineQuery, query));
  }

  /** Calculates control limits from the chosen window and saves them; the previous baseline is superseded, not deleted. */
  @Post('baselines')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateBaselineBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Baseline) })
  createBaseline(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createBaseline(ctx, parse(CreateBaselineBody, body));
  }
}
