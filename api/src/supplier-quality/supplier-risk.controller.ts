import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { RecordRiskAssessmentBody, RiskAssessment, RiskModel, RiskScoresBody, RiskScoring, SaveRiskModelBody } from './supplier-risk.schemas';
import { SupplierRiskService } from './supplier-risk.service';

const READ = 'supplier_quality.read';
const MANAGE = 'supplier_quality.manage';
const CONFIGURE = 'supplier_quality.configure';

/** Supplier risk (SQ2b): the organisation's risk model (versioned) and each supplier's risk assessments. The database works out the rating. */
@ApiTags('supplier-quality')
@ApiBearerAuth()
@Controller('supplier-quality')
export class SupplierRiskController {
  constructor(private readonly service: SupplierRiskService) {}

  @Get('risk-model')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The current risk model (factors, weights, bands, review interval) and the list of versions', schema: openApiSchema(RiskModel) })
  model(@Ctx() ctx: RequestContext) {
    return this.service.model(ctx);
  }

  @Put('risk-model')
  @OrganisationScoped(CONFIGURE)
  @ApiBody({ schema: openApiSchema(SaveRiskModelBody) })
  @ApiOkResponse({ description: 'Saves a new version of the model with a reason; earlier versions and the assessments that used them are untouched', schema: openApiSchema(RiskModel) })
  saveModel(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.saveModel(ctx, parse(SaveRiskModelBody, body));
  }

  @Get('suppliers/:id/risk-assessments')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The supplier\'s risk assessments, the current one first', schema: openApiSchema(z.object({ data: z.array(RiskAssessment) })) })
  assessments(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.assessments(ctx, parse(Uuid, id));
  }

  @Post('suppliers/:id/risk-assessments/preview')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(RiskScoresBody) })
  @ApiOkResponse({ description: 'What these scores would give under the current model; nothing is saved', schema: openApiSchema(RiskScoring) })
  preview(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.preview(ctx, parse(Uuid, id), parse(RiskScoresBody, body));
  }

  @Post('suppliers/:id/risk-assessments')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(RecordRiskAssessmentBody) })
  @ApiCreatedResponse({ description: 'Records an assessment: the database works out the rating, supersedes the previous assessment and sets the supplier\'s risk rating', schema: openApiSchema(RiskAssessment) })
  record(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.record(ctx, parse(Uuid, id), parse(RecordRiskAssessmentBody, body));
  }
}
