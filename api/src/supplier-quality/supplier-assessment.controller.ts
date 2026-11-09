import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  ApprovalDecision, AssessmentDetail, AssessmentSummary, CompleteAssessmentBody, CreateTemplateBody, DecideApprovalBody, ProposeApprovalBody, ReasonBody, ResponseBody, SaveTemplateVersionBody,
  StartAssessmentBody, Template, UpdateTemplateBody,
} from './supplier-assessment.schemas';
import { SupplierAssessmentService } from './supplier-assessment.service';

const READ = 'supplier_quality.read';
const MANAGE = 'supplier_quality.manage';
const APPROVE = 'supplier_quality.approve';
const CONFIGURE = 'supplier_quality.configure';

/** Supplier qualification (SQ2c): assessment templates, assessments, and approval decisions (proposed by one person, decided by another). */
@ApiTags('supplier-quality')
@ApiBearerAuth()
@Controller('supplier-quality')
export class SupplierAssessmentController {
  constructor(private readonly service: SupplierAssessmentService) {}

  // ---- templates

  @Get('assessment-templates')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The organisation\'s assessment templates with their current version and the list of versions', schema: openApiSchema(z.object({ data: z.array(Template) })) })
  templates(@Ctx() ctx: RequestContext) {
    return this.service.templates(ctx);
  }

  @Post('assessment-templates')
  @HttpCode(201)
  @OrganisationScoped(CONFIGURE)
  @ApiBody({ schema: openApiSchema(CreateTemplateBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Template) })
  createTemplate(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createTemplate(ctx, parse(CreateTemplateBody, body));
  }

  @Patch('assessment-templates/:id')
  @OrganisationScoped(CONFIGURE)
  @ApiBody({ schema: openApiSchema(UpdateTemplateBody) })
  @ApiOkResponse({ description: 'Renames, describes or switches a template on or off', schema: openApiSchema(Template) })
  updateTemplate(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateTemplate(ctx, parse(Uuid, id), parse(UpdateTemplateBody, body));
  }

  @Post('assessment-templates/:id/versions')
  @HttpCode(201)
  @OrganisationScoped(CONFIGURE)
  @ApiBody({ schema: openApiSchema(SaveTemplateVersionBody) })
  @ApiCreatedResponse({ description: 'Saves a new version with a reason; assessments already started keep the version they froze', schema: openApiSchema(Template) })
  saveVersion(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.saveTemplateVersion(ctx, parse(Uuid, id), parse(SaveTemplateVersionBody, body));
  }

  // ---- assessments

  @Get('suppliers/:id/assessments')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(AssessmentSummary) })) })
  assessments(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.assessments(ctx, parse(Uuid, id));
  }

  @Post('suppliers/:id/assessments')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(StartAssessmentBody) })
  @ApiCreatedResponse({ description: 'Starts an assessment from the current version of a template, frozen as it is now', schema: openApiSchema(AssessmentDetail) })
  start(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.startAssessment(ctx, parse(Uuid, id), parse(StartAssessmentBody, body));
  }

  @Get('supplier-assessments/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The assessment with its frozen questions, the answers so far and what is still needed', schema: openApiSchema(AssessmentDetail) })
  assessment(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.assessment(ctx, parse(Uuid, id));
  }

  @Put('supplier-assessments/:id/responses')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ResponseBody) })
  @ApiOkResponse({ description: 'Records or changes one answer; the database works out whether it passes', schema: openApiSchema(AssessmentDetail) })
  respond(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.respond(ctx, parse(Uuid, id), parse(ResponseBody, body));
  }

  @Post('supplier-assessments/:id/complete')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CompleteAssessmentBody) })
  @ApiOkResponse({ description: 'Completes the assessment: the database works out the score and the result, and the assessment is frozen', schema: openApiSchema(AssessmentDetail) })
  complete(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.complete(ctx, parse(Uuid, id), parse(CompleteAssessmentBody, body ?? {}));
  }

  @Post('supplier-assessments/:id/abandon')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ schema: openApiSchema(AssessmentDetail) })
  abandon(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.abandon(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }

  // ---- approval decisions

  @Get('suppliers/:id/approval-decisions')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(ApprovalDecision) })) })
  decisions(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.decisions(ctx, parse(Uuid, id));
  }

  @Post('suppliers/:id/approval-decisions')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ProposeApprovalBody) })
  @ApiCreatedResponse({ description: 'Proposes approving the supplier (or approving it conditionally); someone else with approve rights decides it', schema: openApiSchema(ApprovalDecision) })
  propose(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.propose(ctx, parse(Uuid, id), parse(ProposeApprovalBody, body));
  }

  @Post('supplier-approval-decisions/:id/decide')
  @HttpCode(200)
  @OrganisationScoped(APPROVE)
  @ApiBody({ schema: openApiSchema(DecideApprovalBody) })
  @ApiOkResponse({ description: 'Approves or rejects a proposal; never the person who proposed it. Approving moves the supplier\'s status.', schema: openApiSchema(ApprovalDecision) })
  decide(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.decide(ctx, parse(Uuid, id), parse(DecideApprovalBody, body));
  }

  @Post('supplier-approval-decisions/:id/withdraw')
  @HttpCode(200)
  @OrganisationScoped(READ)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Withdraws a proposal that is waiting; the person who proposed it or an approver may', schema: openApiSchema(ApprovalDecision) })
  withdraw(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.withdraw(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }
}
