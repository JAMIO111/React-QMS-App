import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  Classification,
  ClassificationQuery,
  CreateClassificationBody,
  CreateNcrBody,
  DeleteBody,
  HistoryEntry,
  NcrDetail,
  NcrListQuery,
  NcrRanges,
  NcrRangesQuery,
  NcrPage,
  SORTABLE,
  TransitionBody,
  UpdateClassificationBody,
  UpdateNcrBody,
} from './ncr.schemas';
import { NcrService } from './ncr.service';

// Site-scoped role assignments count: RLS then shows only the sites the user is assigned to.
const SITE_SCOPED = { anyScope: true };

@ApiTags('ncrs')
@ApiBearerAuth()
@Controller('ncrs')
export class NcrController {
  constructor(private readonly service: NcrService) {}

  @Get()
  @OrganisationScoped('ncr.read', SITE_SCOPED)
  @ApiQuery({ name: 'source', required: false, enum: ['internal', 'customer', 'supplier'] })
  @ApiQuery({ name: 'stage', required: false, description: 'Comma-separated stages' })
  @ApiQuery({ name: 'q', required: false, description: 'Search reference, title, description, orders, part, customer, supplier, failure mode' })
  @ApiQuery({ name: 'deleted', required: false, enum: ['exclude', 'include', 'only'] })
  @ApiQuery({ name: 'failureModeId', required: false })
  @ApiQuery({ name: 'subFailureModeId', required: false })
  @ApiQuery({ name: 'partId', required: false })
  @ApiQuery({ name: 'customerId', required: false })
  @ApiQuery({ name: 'productionOrderId', required: false })
  @ApiQuery({ name: 'lotId', required: false })
  @ApiQuery({ name: 'supplierId', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'Detected on or after (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: false, description: 'Detected on or before (YYYY-MM-DD)' })
  @ApiQuery({ name: 'severity', required: false, description: 'Comma-separated severities' })
  @ApiQuery({ name: 'costMin', required: false, description: 'Total cost (base currency, gross) at least' })
  @ApiQuery({ name: 'costMax', required: false, description: 'Total cost (base currency, gross) at most' })
  @ApiQuery({ name: 'qtyMin', required: false, description: 'Quantity affected at least' })
  @ApiQuery({ name: 'qtyMax', required: false, description: 'Quantity affected at most' })
  @ApiQuery({ name: 'sort', required: false, enum: [...SORTABLE] })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'pageSize', required: false })
  @ApiOkResponse({ schema: openApiSchema(NcrPage) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(NcrListQuery, query));
  }

  /** Highest total cost and quantity in the register (for filter sliders). Declared before :id. */
  @Get('ranges')
  @OrganisationScoped('ncr.read', SITE_SCOPED)
  @ApiQuery({ name: 'source', required: false, enum: ['internal', 'customer', 'supplier'] })
  @ApiOkResponse({ schema: openApiSchema(NcrRanges) })
  ranges(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.ranges(ctx, parse(NcrRangesQuery, query));
  }

  @Post()
  @HttpCode(201)
  @OrganisationScoped('ncr.create', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(CreateNcrBody) })
  @ApiCreatedResponse({ schema: openApiSchema(NcrDetail) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateNcrBody, body));
  }

  @Get(':id')
  @OrganisationScoped('ncr.read', SITE_SCOPED)
  @ApiOkResponse({ schema: openApiSchema(NcrDetail) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Patch(':id')
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(UpdateNcrBody) })
  @ApiOkResponse({ schema: openApiSchema(NcrDetail) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateNcrBody, body));
  }

  /** Move to another stage (open, forward, cancel with reason, reopen with reason). */
  @Post(':id/transitions')
  @HttpCode(200)
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(TransitionBody) })
  @ApiOkResponse({ schema: openApiSchema(NcrDetail) })
  transition(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.transition(ctx, parse(Uuid, id), parse(TransitionBody, body));
  }

  /** Soft delete (kept for the record, hidden from registers). */
  @Post(':id/delete')
  @HttpCode(200)
  @OrganisationScoped('ncr.delete', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(DeleteBody) })
  @ApiOkResponse({ schema: openApiSchema(NcrDetail) })
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.remove(ctx, parse(Uuid, id), parse(DeleteBody, body).reason);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @OrganisationScoped('ncr.delete', SITE_SCOPED)
  @ApiOkResponse({ schema: openApiSchema(NcrDetail) })
  restore(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.restore(ctx, parse(Uuid, id));
  }

  @Get(':id/history')
  @OrganisationScoped('ncr.read', SITE_SCOPED)
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(HistoryEntry) })) })
  async history(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return { data: await this.service.history(ctx, parse(Uuid, id)) };
  }
}

@ApiTags('ncrs')
@ApiBearerAuth()
@Controller('ncr-classifications')
export class NcrClassificationsController {
  constructor(private readonly service: NcrService) {}

  @Get()
  @OrganisationScoped()
  @ApiQuery({ name: 'kind', required: false, enum: ['failure_mode', 'sub_failure_mode', 'process'] })
  @ApiQuery({ name: 'includeInactive', required: false, schema: { type: 'boolean' } })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(Classification) })) })
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return { data: await this.service.listClassifications(ctx, parse(ClassificationQuery, query)) };
  }

  @Post()
  @HttpCode(201)
  @OrganisationScoped('lookups.manage')
  @ApiBody({ schema: openApiSchema(CreateClassificationBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Classification) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createClassification(ctx, parse(CreateClassificationBody, body));
  }

  @Patch(':id')
  @OrganisationScoped('lookups.manage')
  @ApiBody({ schema: openApiSchema(UpdateClassificationBody) })
  @ApiOkResponse({ schema: openApiSchema(Classification) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateClassification(ctx, parse(Uuid, id), parse(UpdateClassificationBody, body));
  }
}
