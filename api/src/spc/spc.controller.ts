import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { z } from 'zod';
import { Baseline, BaselineQuery, CharacteristicOption, CharacteristicsQuery, Chart, ChartQuery, CreateBaselineBody } from './spc.schemas';
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
  @ApiQuery({ name: 'partId', required: true, schema: { type: 'string', format: 'uuid' } })
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
