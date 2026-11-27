import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  AgreedDateBody, CreateCustomerOrderBody, CustomerOrderDetail, CustomerOrderListQuery, CustomerOrderPage, OrderLookup, OrderLookupQuery, ReasonBody, RecordShipmentBody, ShipmentDetail, ShipmentListQuery,
  ShipmentPage,
} from './shipping.schemas';
import { ShippingService } from './shipping.service';

const READ = 'shipping.read';
const MANAGE = 'shipping.manage';
const RECORD = 'shipping.record';

/** Customer orders and shipments (docs/order-fulfilment-plan.md): what a customer asked for, and what left. A shipment never makes a lot; it may name one that exists. */
@ApiTags('shipping')
@ApiBearerAuth()
@Controller()
export class ShippingController {
  constructor(private readonly service: ShippingService) {}

  // ---- customer orders

  @Get('customer-orders')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Customer orders, page by page (open by default; `late=true` lists those with a line past its date and not fully shipped)', schema: openApiSchema(CustomerOrderPage) })
  listOrders(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.listOrders(ctx, parse(CustomerOrderListQuery, query));
  }

  @Get('customer-orders/lookup')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Open orders for a picker', schema: openApiSchema(OrderLookup) })
  lookupOrders(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.lookupOrders(ctx, parse(OrderLookupQuery, query));
  }

  @Post('customer-orders')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateCustomerOrderBody) })
  @ApiCreatedResponse({ schema: openApiSchema(CustomerOrderDetail) })
  createOrder(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createOrder(ctx, parse(CreateCustomerOrderBody, body));
  }

  @Get('customer-orders/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The order with each line\'s quantity shipped, outstanding, over and whether it is late, and its shipments', schema: openApiSchema(CustomerOrderDetail) })
  getOrder(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.getOrder(ctx, parse(Uuid, id));
  }

  @Post('customer-orders/:id/close')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Nothing more is expected on this order', schema: openApiSchema(CustomerOrderDetail) })
  closeOrder(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.closeOrder(ctx, parse(Uuid, id));
  }

  @Post('customer-orders/:id/cancel')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Cancels an open order with a reason; it is kept', schema: openApiSchema(CustomerOrderDetail) })
  cancelOrder(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.cancelOrder(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }

  @Patch('customer-order-lines/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(AgreedDateBody) })
  @ApiOkResponse({ description: 'Sets the latest agreed date of an open line (the requested date never changes)', schema: openApiSchema(CustomerOrderDetail) })
  setAgreedDate(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setAgreedDate(ctx, parse(Uuid, id), parse(AgreedDateBody, body));
  }

  // ---- shipments

  @Get('shipments')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Shipments, page by page', schema: openApiSchema(ShipmentPage) })
  listShipments(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.listShipments(ctx, parse(ShipmentListQuery, query));
  }

  @Post('shipments')
  @HttpCode(201)
  @OrganisationScoped(RECORD)
  @ApiBody({ schema: openApiSchema(RecordShipmentBody) })
  @ApiCreatedResponse({ description: 'Records what shipped. A line may name an existing lot (never makes one). A retry with the same clientKey returns the same shipment.', schema: openApiSchema(ShipmentDetail) })
  recordShipment(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.recordShipment(ctx, parse(RecordShipmentBody, body));
  }

  @Get('shipments/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(ShipmentDetail) })
  getShipment(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.getShipment(ctx, parse(Uuid, id));
  }

  @Post('shipments/:id/cancel')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Cancels a shipment with a reason; it is kept', schema: openApiSchema(ShipmentDetail) })
  cancelShipment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.cancelShipment(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }
}
