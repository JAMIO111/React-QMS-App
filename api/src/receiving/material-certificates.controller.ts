import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { Certificate, CertificateList, CertificateListQuery, RecordCertificateBody, ReviewCertificateBody, UpdateCertificateBody, WithdrawCertificateBody } from './material-certificates.schemas';
import { MaterialCertificatesService } from './material-certificates.service';

/**
 * Material certificates (mill test reports, certificates of conformance or analysis): recorded against a supplier and traced to a receipt line, a lot and/or a heat number.
 * Recording needs receiving.manage; accepting or rejecting one needs supplier_quality.manage and freezes it; a wrong one is withdrawn with a reason. Nothing is deleted.
 */
@ApiTags('receiving')
@ApiBearerAuth()
@Controller()
export class MaterialCertificatesController {
  constructor(private readonly service: MaterialCertificatesService) {}

  @Get('material-certificates')
  @OrganisationScoped('receiving.read')
  @ApiOkResponse({ description: 'The certificates (received and accepted by default), waiting for review first; `reviewCount` is how many wait', schema: openApiSchema(CertificateList) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(CertificateListQuery, query));
  }

  @Post('material-certificates')
  @HttpCode(201)
  @OrganisationScoped('receiving.manage')
  @ApiBody({ schema: openApiSchema(RecordCertificateBody) })
  @ApiCreatedResponse({ description: 'Records a certificate, waiting for review', schema: openApiSchema(Certificate) })
  record(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.record(ctx, parse(RecordCertificateBody, body));
  }

  @Get('material-certificates/:id')
  @OrganisationScoped('receiving.read')
  @ApiOkResponse({ schema: openApiSchema(Certificate) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Patch('material-certificates/:id')
  @OrganisationScoped('receiving.manage')
  @ApiBody({ schema: openApiSchema(UpdateCertificateBody) })
  @ApiOkResponse({ description: 'Edits a certificate that has not been reviewed', schema: openApiSchema(Certificate) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateCertificateBody, body));
  }

  @Post('material-certificates/:id/review')
  @HttpCode(200)
  @OrganisationScoped('supplier_quality.manage')
  @ApiBody({ schema: openApiSchema(ReviewCertificateBody) })
  @ApiOkResponse({ description: 'Accepts or rejects (a rejection needs a note); once, and the certificate is then frozen', schema: openApiSchema(Certificate) })
  review(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.review(ctx, parse(Uuid, id), parse(ReviewCertificateBody, body));
  }

  @Post('material-certificates/:id/withdraw')
  @HttpCode(200)
  @OrganisationScoped('receiving.manage')
  @ApiBody({ schema: openApiSchema(WithdrawCertificateBody) })
  @ApiOkResponse({ description: 'Withdraws a certificate with a reason, whatever its review state; it is kept', schema: openApiSchema(Certificate) })
  withdraw(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.withdraw(ctx, parse(Uuid, id), parse(WithdrawCertificateBody, body));
  }
}
