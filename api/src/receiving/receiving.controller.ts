import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  AgreedDateBody, CreatePurchaseOrderBody, PoLookup, PoLookupQuery, PurchaseOrderDetail, PurchaseOrderListQuery, PurchaseOrderPage, ReasonBody, ReceiptDetail, ReceiptListQuery, ReceiptPage, RecordReceiptBody,
} from './receiving.schemas';
import { ReceivingService } from './receiving.service';

const READ = 'receiving.read';
const MANAGE = 'receiving.manage';

/** Minimal purchasing and goods receiving (SQ4a): what was ordered from a supplier, and what arrived. A receipt line that names a lot number makes the received lot. */
@ApiTags('receiving')
@ApiBearerAuth()
@Controller()
export class ReceivingController {
  constructor(private readonly service: ReceivingService) {}

  // ---- purchase orders

  @Get('purchase-orders')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Purchase orders, page by page (open by default; `late=true` lists those with a line past its date and not fully received)', schema: openApiSchema(PurchaseOrderPage) })
  listOrders(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.listOrders(ctx, parse(PurchaseOrderListQuery, query));
  }

  @Get('purchase-orders/lookup')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Open orders for a picker', schema: openApiSchema(PoLookup) })
  lookupOrders(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.lookupOrders(ctx, parse(PoLookupQuery, query));
  }

  @Post('purchase-orders')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreatePurchaseOrderBody) })
  @ApiCreatedResponse({ schema: openApiSchema(PurchaseOrderDetail) })
  createOrder(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createOrder(ctx, parse(CreatePurchaseOrderBody, body));
  }

  @Get('purchase-orders/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The order with each line\'s quantity received, outstanding and whether it is late, and its receipts', schema: openApiSchema(PurchaseOrderDetail) })
  getOrder(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.getOrder(ctx, parse(Uuid, id));
  }

  @Post('purchase-orders/:id/close')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Nothing more is expected on this order', schema: openApiSchema(PurchaseOrderDetail) })
  closeOrder(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.closeOrder(ctx, parse(Uuid, id));
  }

  @Post('purchase-orders/:id/cancel')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Cancels an open order with a reason; it is kept', schema: openApiSchema(PurchaseOrderDetail) })
  cancelOrder(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.cancelOrder(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }

  @Patch('purchase-order-lines/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(AgreedDateBody) })
  @ApiOkResponse({ description: 'Sets the latest agreed date of an open line (the requested date never changes)', schema: openApiSchema(PurchaseOrderDetail) })
  setAgreedDate(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setAgreedDate(ctx, parse(Uuid, id), parse(AgreedDateBody, body));
  }

  // ---- goods receipts

  @Get('goods-receipts')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Goods receipts, page by page', schema: openApiSchema(ReceiptPage) })
  listReceipts(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.listReceipts(ctx, parse(ReceiptListQuery, query));
  }

  @Post('goods-receipts')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(RecordReceiptBody) })
  @ApiCreatedResponse({ description: 'Records what arrived. A line with a lot number makes the received lot. A retry with the same clientKey returns the same receipt.', schema: openApiSchema(ReceiptDetail) })
  recordReceipt(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.recordReceipt(ctx, parse(RecordReceiptBody, body));
  }

  @Get('goods-receipts/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(ReceiptDetail) })
  getReceipt(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.getReceipt(ctx, parse(Uuid, id));
  }

  @Post('goods-receipts/:id/cancel')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Cancels a receipt with a reason; it and the lots it made are kept', schema: openApiSchema(ReceiptDetail) })
  cancelReceipt(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.cancelReceipt(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }
}
