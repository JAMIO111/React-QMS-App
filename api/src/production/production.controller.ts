import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  CreateLotBody,
  CreateOperationBody,
  CreateOrderBody,
  CreateSerialsBody,
  BackfillBody,
  BackfillReport,
  InlineOrderBody,
  Lot,
  LOT_SORTABLE,
  LotListQuery,
  LotLookupQuery,
  LotOption,
  LotPage,
  ORDER_SORTABLE,
  OrderListQuery,
  OrderLookupQuery,
  OrderOption,
  OrderPage,
  ProductionOrderDetail,
  Serial,
  SERIAL_SORTABLE,
  SerialListQuery,
  SerialLookupQuery,
  SerialOption,
  SerialPage,
  UpdateLotBody,
  UpdateOperationBody,
  UpdateOrderBody,
  UpdateSerialBody,
} from './production.schemas';
import { ProductionService } from './production.service';

const READ = 'production.read';
const MANAGE = 'production.manage';

/** Production orders and their operations. Declared lookups come before `:id`. */
@ApiTags('production')
@ApiBearerAuth()
@Controller()
export class ProductionController {
  constructor(private readonly service: ProductionService) {}

  // ------------------------------------------------------------------------------------------------------------------------ Orders
  @Get('production-orders')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string' }, description: 'Order number, part number or name, customer' })
  @ApiQuery({ name: 'status', required: false, schema: { type: 'string' }, description: 'Comma-separated statuses' })
  @ApiQuery({ name: 'partId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'customerId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'siteId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'sort', required: false, schema: { type: 'string', enum: [...ORDER_SORTABLE] } })
  @ApiQuery({ name: 'order', required: false, schema: { type: 'string', enum: ['asc', 'desc'] } })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({ name: 'pageSize', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } })
  @ApiOkResponse({ schema: openApiSchema(OrderPage) })
  listOrders(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.listOrders(ctx, parse(OrderListQuery, query));
  }

  /** Open orders for pickers (closed and cancelled only with includeClosed=true). */
  @Get('production-orders/lookup')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'partId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'includeClosed', required: false, schema: { type: 'string', enum: ['true', 'false'] } })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(OrderOption) })) })
  async lookupOrders(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return { data: await this.service.lookupOrders(ctx, parse(OrderLookupQuery, query)) };
  }

  @Post('production-orders')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateOrderBody) })
  @ApiCreatedResponse({ schema: openApiSchema(ProductionOrderDetail) })
  createOrder(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createOrder(ctx, parse(CreateOrderBody, body));
  }

  /**
   * Make an order from a job's order picker (an operator who types the work order at the machine). Needs production.manage, or inspection.record when the organisation
   * allows it (`allowInlineOrders`); the database answers 403 otherwise. Orders only: lots and serial numbers are never made this way.
   */
  @Post('production-orders/inline')
  @HttpCode(201)
  @OrganisationScoped(READ)
  @ApiBody({ schema: openApiSchema(InlineOrderBody) })
  @ApiCreatedResponse({ schema: openApiSchema(ProductionOrderDetail) })
  createInlineOrder(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createInlineOrder(ctx, parse(InlineOrderBody, body));
  }

  /**
   * Turn the work orders, lots and serial numbers typed on existing inspections and non-conformances into production records and link the records to them, leaving the typed text
   * as it was. A dry run (the default) reports what it would do; send `dryRun: false` to do it. Needs organisation.manage.
   */
  @Post('production/backfill')
  @HttpCode(200)
  @OrganisationScoped('organisation.manage')
  @ApiBody({ schema: openApiSchema(BackfillBody) })
  @ApiOkResponse({ schema: openApiSchema(BackfillReport) })
  backfill(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.backfill(ctx, parse(BackfillBody, body ?? {}), ctx.correlationId ?? '');
  }

  @Get('production-orders/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(ProductionOrderDetail) })
  getOrder(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.getOrder(ctx, parse(Uuid, id));
  }

  /** Change details or move the order on with `status` (the database decides which moves are allowed; cancelling needs `statusReason`). */
  @Patch('production-orders/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateOrderBody) })
  @ApiOkResponse({ schema: openApiSchema(ProductionOrderDetail) })
  updateOrder(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateOrder(ctx, parse(Uuid, id), parse(UpdateOrderBody, body));
  }

  @Post('production-orders/:id/operations')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateOperationBody) })
  @ApiCreatedResponse({ schema: openApiSchema(ProductionOrderDetail) })
  createOperation(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createOperation(ctx, parse(Uuid, id), parse(CreateOperationBody, body));
  }

  @Patch('production-operations/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateOperationBody) })
  @ApiOkResponse({ schema: openApiSchema(ProductionOrderDetail) })
  updateOperation(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateOperation(ctx, parse(Uuid, id), parse(UpdateOperationBody, body));
  }

  // ------------------------------------------------------------------------------------------------------------------------ Lots
  @Get('lots')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string' }, description: 'Lot number, part number or name' })
  @ApiQuery({ name: 'status', required: false, schema: { type: 'string' }, description: 'Comma-separated statuses' })
  @ApiQuery({ name: 'origin', required: false, schema: { type: 'string', enum: ['produced', 'received'] } })
  @ApiQuery({ name: 'partId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'supplierId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'productionOrderId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'siteId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'sort', required: false, schema: { type: 'string', enum: [...LOT_SORTABLE] } })
  @ApiQuery({ name: 'order', required: false, schema: { type: 'string', enum: ['asc', 'desc'] } })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({ name: 'pageSize', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } })
  @ApiOkResponse({ schema: openApiSchema(LotPage) })
  listLots(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.listLots(ctx, parse(LotListQuery, query));
  }

  @Get('lots/lookup')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'partId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'productionOrderId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'includeClosed', required: false, schema: { type: 'string', enum: ['true', 'false'] } })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(LotOption) })) })
  async lookupLots(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return { data: await this.service.lookupLots(ctx, parse(LotLookupQuery, query)) };
  }

  @Post('lots')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateLotBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Lot) })
  createLot(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createLot(ctx, parse(CreateLotBody, body));
  }

  @Get('lots/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(Lot) })
  getLot(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.getLot(ctx, parse(Uuid, id));
  }

  /** Change details or move the lot on with `status` (a hold needs `statusReason`; a closed lot is frozen). */
  @Patch('lots/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateLotBody) })
  @ApiOkResponse({ schema: openApiSchema(Lot) })
  updateLot(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateLot(ctx, parse(Uuid, id), parse(UpdateLotBody, body));
  }

  // ------------------------------------------------------------------------------------------------------------------------ Serial numbers
  @Get('serial-numbers')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string' }, description: 'Serial number, part number or lot number' })
  @ApiQuery({ name: 'status', required: false, schema: { type: 'string' }, description: 'Comma-separated statuses' })
  @ApiQuery({ name: 'partId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'lotId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'productionOrderId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'sort', required: false, schema: { type: 'string', enum: [...SERIAL_SORTABLE] } })
  @ApiQuery({ name: 'order', required: false, schema: { type: 'string', enum: ['asc', 'desc'] } })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({ name: 'pageSize', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } })
  @ApiOkResponse({ schema: openApiSchema(SerialPage) })
  listSerials(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.listSerials(ctx, parse(SerialListQuery, query));
  }

  @Get('serial-numbers/lookup')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'partId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'lotId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'productionOrderId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'includeClosed', required: false, schema: { type: 'string', enum: ['true', 'false'] } })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(SerialOption) })) })
  async lookupSerials(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return { data: await this.service.lookupSerials(ctx, parse(SerialLookupQuery, query)) };
  }

  /** One serial number, a list, or a numbered range (all or nothing, at most 500). */
  @Post('serial-numbers')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateSerialsBody) })
  @ApiCreatedResponse({ schema: openApiSchema(z.object({ data: z.array(Serial) })) })
  createSerials(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createSerials(ctx, parse(CreateSerialsBody, body));
  }

  @Get('serial-numbers/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(Serial) })
  getSerial(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.getSerial(ctx, parse(Uuid, id));
  }

  @Patch('serial-numbers/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateSerialBody) })
  @ApiOkResponse({ schema: openApiSchema(Serial) })
  updateSerial(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateSerial(ctx, parse(Uuid, id), parse(UpdateSerialBody, body));
  }
}
