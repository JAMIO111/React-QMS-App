import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  ChangeStatusBody, Classification, ClassificationsQuery, CreateClassificationBody, CreateContactBody, CreateProductBody, CreateSupplierBody, SetClassificationsBody, StatusHistoryItem,
  SupplierDetail, SupplierListQuery, SupplierPage, UpdateClassificationBody, UpdateContactBody, UpdateProductBody, UpdateSupplierBody,
} from './supplier-quality.schemas';
import { SupplierQualityService } from './supplier-quality.service';

const READ = 'supplier_quality.read';
const MANAGE = 'supplier_quality.manage';
const APPROVE = 'supplier_quality.approve';
const CONFIGURE = 'supplier_quality.configure';

/** Supplier quality (SQ1): the supplier register and profile, approval status with history, classifications, contacts and the products and services a supplier supplies. */
@ApiTags('supplier-quality')
@ApiBearerAuth()
@Controller('supplier-quality')
export class SupplierQualityController {
  constructor(private readonly service: SupplierQualityService) {}

  @Get('suppliers')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'status', required: false, description: 'Comma-separated approval statuses' })
  @ApiQuery({ name: 'type', required: false, description: 'Comma-separated supplier types' })
  @ApiQuery({ name: 'classificationId', required: false, description: 'Comma-separated classification ids' })
  @ApiQuery({ name: 'risk', required: false, description: 'Comma-separated risk ratings' })
  @ApiQuery({ name: 'active', required: false, schema: { type: 'string', enum: ['active', 'inactive', 'all'] } })
  @ApiQuery({ name: 'q', required: false })
  @ApiOkResponse({ description: 'The register, page-based, with search, filters and sorting', schema: openApiSchema(SupplierPage) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(SupplierListQuery, query));
  }

  @Post('suppliers')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateSupplierBody) })
  @ApiCreatedResponse({ description: 'Adds a supplier. It starts Pending Approval, whatever is sent.', schema: openApiSchema(SupplierDetail) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateSupplierBody, body));
  }

  @Get('classifications')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'all', required: false, schema: { type: 'string', enum: ['true', 'false'] } })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(Classification) })) })
  classifications(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.classifications(ctx, parse(ClassificationsQuery, query));
  }

  @Post('classifications')
  @HttpCode(201)
  @OrganisationScoped(CONFIGURE)
  @ApiBody({ schema: openApiSchema(CreateClassificationBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Classification) })
  createClassification(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createClassification(ctx, parse(CreateClassificationBody, body));
  }

  @Patch('classifications/:id')
  @OrganisationScoped(CONFIGURE)
  @ApiBody({ schema: openApiSchema(UpdateClassificationBody) })
  @ApiOkResponse({ description: 'Renames, describes, reorders or switches a classification off (nothing is deleted)', schema: openApiSchema(Classification) })
  updateClassification(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateClassification(ctx, parse(Uuid, id), parse(UpdateClassificationBody, body));
  }

  @Get('suppliers/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The supplier profile: details, classifications, contacts, products and counts', schema: openApiSchema(SupplierDetail) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Patch('suppliers/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateSupplierBody) })
  @ApiOkResponse({ description: 'Edits the supplier. The approval status is not changed here.', schema: openApiSchema(SupplierDetail) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateSupplierBody, body));
  }

  @Post('suppliers/:id/status')
  @HttpCode(200)
  @OrganisationScoped(APPROVE)
  @ApiBody({ schema: openApiSchema(ChangeStatusBody) })
  @ApiOkResponse({ description: 'Moves the approval status (allowed transitions only, with a reason; conditional needs conditions). 409 supplier_rule otherwise.', schema: openApiSchema(SupplierDetail) })
  changeStatus(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.changeStatus(ctx, parse(Uuid, id), parse(ChangeStatusBody, body));
  }

  @Get('suppliers/:id/history')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Every approval status change, newest first', schema: openApiSchema(z.object({ data: z.array(StatusHistoryItem) })) })
  history(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.history(ctx, parse(Uuid, id));
  }

  @Put('suppliers/:id/classifications')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(SetClassificationsBody) })
  @ApiOkResponse({ description: 'Replaces the supplier\'s classifications as a whole', schema: openApiSchema(SupplierDetail) })
  setClassifications(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setClassifications(ctx, parse(Uuid, id), parse(SetClassificationsBody, body));
  }

  @Post('suppliers/:id/contacts')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateContactBody) })
  @ApiCreatedResponse({ description: 'Adds a contact (a new primary contact replaces the old one)', schema: openApiSchema(SupplierDetail) })
  createContact(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createContact(ctx, parse(Uuid, id), parse(CreateContactBody, body));
  }

  @Patch('supplier-contacts/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateContactBody) })
  @ApiOkResponse({ description: 'Edits or deactivates a contact (never deleted)', schema: openApiSchema(SupplierDetail) })
  updateContact(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateContact(ctx, parse(Uuid, id), parse(UpdateContactBody, body));
  }

  @Post('suppliers/:id/products')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateProductBody) })
  @ApiCreatedResponse({ description: 'Links a part, or describes a material or service, that the supplier supplies', schema: openApiSchema(SupplierDetail) })
  createProduct(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createProduct(ctx, parse(Uuid, id), parse(CreateProductBody, body));
  }

  @Patch('supplier-products/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateProductBody) })
  @ApiOkResponse({ description: 'Edits the supplier\'s own part number or notes, or ends the link (what is supplied cannot change)', schema: openApiSchema(SupplierDetail) })
  updateProduct(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateProduct(ctx, parse(Uuid, id), parse(UpdateProductBody, body));
  }
}
