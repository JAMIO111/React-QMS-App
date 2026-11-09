import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  CreateCertificationBody, CreateDocumentBody, ReasonBody, RenewCertificationBody, SupplierCertification, SupplierDocument, UpdateCertificationBody, UpdateDocumentBody, VerifyBody,
  Watchlist, WatchlistQuery,
} from './supplier-qualification.schemas';
import { SupplierQualificationService } from './supplier-qualification.service';

const READ = 'supplier_quality.read';
const MANAGE = 'supplier_quality.manage';

/**
 * Supplier qualification records (SQ2a): documents (one stored file each, replaced by new versions) and certifications (renewed, never edited once verified),
 * and the expiry watchlist. Expiry is shown, never acted on.
 */
@ApiTags('supplier-quality')
@ApiBearerAuth()
@Controller('supplier-quality')
export class SupplierQualificationController {
  constructor(private readonly service: SupplierQualificationService) {}

  @Get('expiry-watchlist')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Current certifications and documents that have expired or expire soon, soonest first', schema: openApiSchema(Watchlist) })
  watchlist(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.watchlist(ctx, parse(WatchlistQuery, query));
  }

  // ---- documents

  @Get('suppliers/:id/documents')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Every document of the supplier: current first, then superseded and removed ones', schema: openApiSchema(z.object({ data: z.array(SupplierDocument) })) })
  documents(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.documents(ctx, parse(Uuid, id));
  }

  @Post('suppliers/:id/documents')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateDocumentBody) })
  @ApiCreatedResponse({ description: 'Records an uploaded file as a document (or as a new version of a current one)', schema: openApiSchema(SupplierDocument) })
  createDocument(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createDocument(ctx, parse(Uuid, id), parse(CreateDocumentBody, body));
  }

  @Patch('supplier-documents/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateDocumentBody) })
  @ApiOkResponse({ description: 'Edits the details of a document nobody has verified yet', schema: openApiSchema(SupplierDocument) })
  updateDocument(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateDocument(ctx, parse(Uuid, id), parse(UpdateDocumentBody, body));
  }

  @Post('supplier-documents/:id/verify')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(VerifyBody) })
  @ApiOkResponse({ description: 'Records who checked the document and when', schema: openApiSchema(SupplierDocument) })
  verifyDocument(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.verifyDocument(ctx, parse(Uuid, id), parse(VerifyBody, body ?? {}));
  }

  @Post('supplier-documents/:id/remove')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Removes the document from use with a reason; the record and file are kept', schema: openApiSchema(SupplierDocument) })
  removeDocument(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.removeDocument(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }

  // ---- certifications

  @Get('suppliers/:id/certifications')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Every certification of the supplier with its expiry state: current first, then superseded and withdrawn ones', schema: openApiSchema(z.object({ data: z.array(SupplierCertification) })) })
  certifications(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.certifications(ctx, parse(Uuid, id));
  }

  @Post('suppliers/:id/certifications')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateCertificationBody) })
  @ApiCreatedResponse({ description: 'Adds a certification', schema: openApiSchema(SupplierCertification) })
  createCertification(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createCertification(ctx, parse(Uuid, id), parse(CreateCertificationBody, body));
  }

  @Patch('supplier-certifications/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateCertificationBody) })
  @ApiOkResponse({ description: 'Edits a certification nobody has verified yet', schema: openApiSchema(SupplierCertification) })
  updateCertification(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateCertification(ctx, parse(Uuid, id), parse(UpdateCertificationBody, body));
  }

  @Post('supplier-certifications/:id/renew')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(RenewCertificationBody) })
  @ApiCreatedResponse({ description: 'Records the renewed certificate as a new one; the old one is superseded', schema: openApiSchema(SupplierCertification) })
  renewCertification(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.renewCertification(ctx, parse(Uuid, id), parse(RenewCertificationBody, body));
  }

  @Post('supplier-certifications/:id/verify')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(VerifyBody) })
  @ApiOkResponse({ description: 'Records who checked the certification and when', schema: openApiSchema(SupplierCertification) })
  verifyCertification(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.verifyCertification(ctx, parse(Uuid, id), parse(VerifyBody, body ?? {}));
  }

  @Post('supplier-certifications/:id/withdraw')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Withdraws a certification with a reason; the record is kept', schema: openApiSchema(SupplierCertification) })
  withdrawCertification(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.withdrawCertification(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }
}
