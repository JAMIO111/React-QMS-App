import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  ApproveRequirementBody, CreateRequirementBody, IncomingPreview, PreviewQuery, ReceiptSource, Requirement, RequirementList, RequirementListQuery, RetireRequirementBody, UpdateRequirementBody,
} from './requirements.schemas';
import { RequirementsService } from './requirements.service';

/**
 * Incoming inspection requirements: rules by supplier, part, part family, classification and risk, written as drafts and approved by a different person. A rule that reduces inspection is
 * never applied to a part with a critical characteristic. The preview says what the approved rules would decide for a delivery.
 */
@ApiTags('receiving')
@ApiBearerAuth()
@Controller()
export class RequirementsController {
  constructor(private readonly service: RequirementsService) {}

  @Get('inspection-requirements')
  @OrganisationScoped('supplier_quality.read')
  @ApiOkResponse({ description: 'The requirements (drafts and approved by default)', schema: openApiSchema(RequirementList) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(RequirementListQuery, query));
  }

  @Post('inspection-requirements')
  @HttpCode(201)
  @OrganisationScoped('supplier_quality.manage')
  @ApiBody({ schema: openApiSchema(CreateRequirementBody) })
  @ApiCreatedResponse({ description: 'A draft requirement. It applies to nothing until a different person with supplier_quality.approve approves it.', schema: openApiSchema(Requirement) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateRequirementBody, body));
  }

  @Get('inspection-requirements/:id')
  @OrganisationScoped('supplier_quality.read')
  @ApiOkResponse({ schema: openApiSchema(Requirement) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Patch('inspection-requirements/:id')
  @OrganisationScoped('supplier_quality.manage')
  @ApiBody({ schema: openApiSchema(UpdateRequirementBody) })
  @ApiOkResponse({ description: 'Edits a draft. An approved requirement is never edited: write a new one that supersedes it.', schema: openApiSchema(Requirement) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateRequirementBody, body));
  }

  @Post('inspection-requirements/:id/approve')
  @HttpCode(200)
  @OrganisationScoped('supplier_quality.approve')
  @ApiBody({ schema: openApiSchema(ApproveRequirementBody) })
  @ApiOkResponse({ description: 'Approves a draft (never the person who wrote or last edited it). A requirement that reduces inspection needs a note of at least 10 characters. A requirement it supersedes is superseded.', schema: openApiSchema(Requirement) })
  approve(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.approve(ctx, parse(Uuid, id), parse(ApproveRequirementBody, body ?? {}));
  }

  @Post('inspection-requirements/:id/retire')
  @HttpCode(200)
  @OrganisationScoped('supplier_quality.manage')
  @ApiBody({ schema: openApiSchema(RetireRequirementBody) })
  @ApiOkResponse({ description: 'Retires a draft or approved requirement, with a reason; it is kept', schema: openApiSchema(Requirement) })
  retire(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.retire(ctx, parse(Uuid, id), parse(RetireRequirementBody, body));
  }

  @Get('incoming-inspection/preview')
  @OrganisationScoped('receiving.read')
  @ApiOkResponse({ description: 'What the approved requirements decide for this supplier, part and quantity (nothing is recorded)', schema: openApiSchema(IncomingPreview) })
  preview(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.preview(ctx, parse(PreviewQuery, query));
  }

  @Get('ncrs/:id/receipt-source')
  @OrganisationScoped('ncr.read')
  @ApiOkResponse({ description: 'The goods receipt line(s) this non-conformance was raised from (`available: false` without receiving.read)', schema: openApiSchema(ReceiptSource) })
  receiptSource(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.receiptSource(ctx, parse(Uuid, id));
  }
}
