import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  AcceptanceBody, AllQuery, AssessBody, CloseBody, CreateActionBody, CreateCategoryBody, CreateRiskBody, DecideBody, DraftQuery, LinkedQuery, LinksBody, NoteBody, ReasonBody,
  ReviewBody, RiskCategory,
  RiskListQuery, SaveModelBody, ScoreQuery, TreatmentBody, UpdateActionBody, UpdateCategoryBody, UpdateRiskBody,
} from './risk.schemas';
import { RiskService } from './risk.service';

const READ = 'risk.read';
const MANAGE = 'risk.manage';
const APPROVE = 'risk.approve';

/** Risk register (RK1, RK2): the 5 x 5 scoring matrix (versions), categories, risks and opportunities, their assessments, treatment, actions, acceptance and reviews. */
@ApiTags('risk')
@ApiBearerAuth()
@Controller()
export class RiskController {
  constructor(private readonly service: RiskService) {}

  // ---- the matrix ----------------------------------------------------------------------------------

  @Get('risk-model')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The current matrix (labels, the band of each cell, the acceptable level, review intervals) and its versions' })
  model(@Ctx() ctx: RequestContext) {
    return this.service.model(ctx);
  }

  @Put('risk-model')
  @OrganisationScoped(APPROVE)
  @ApiBody({ schema: openApiSchema(SaveModelBody) })
  @ApiOkResponse({ description: 'Saves a new version of the matrix with a reason. Existing assessments keep the version they were scored with.' })
  saveModel(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.saveModel(ctx, parse(SaveModelBody, body));
  }

  @Get('risk-score')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'likelihood', required: true, schema: { type: 'integer', minimum: 1, maximum: 5 } })
  @ApiQuery({ name: 'consequence', required: true, schema: { type: 'integer', minimum: 1, maximum: 5 } })
  @ApiOkResponse({ description: 'What a likelihood and a consequence come to on the current matrix: score, band, whether it is acceptable. Nothing is saved.' })
  score(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.score(ctx, parse(ScoreQuery, query));
  }

  // ---- categories ----------------------------------------------------------------------------------

  @Get('risk-categories')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'all', required: false, schema: { type: 'string', enum: ['true', 'false'] }, description: 'Include switched-off categories' })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(RiskCategory) })) })
  categories(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.categories(ctx, parse(AllQuery, query));
  }

  @Post('risk-categories')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateCategoryBody) })
  @ApiCreatedResponse({ schema: openApiSchema(RiskCategory) })
  createCategory(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createCategory(ctx, parse(CreateCategoryBody, body));
  }

  @Patch('risk-categories/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateCategoryBody) })
  @ApiOkResponse({ description: 'Renames, describes, reorders or switches a category off (nothing is deleted)', schema: openApiSchema(RiskCategory) })
  updateCategory(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateCategory(ctx, parse(Uuid, id), parse(UpdateCategoryBody, body));
  }

  // ---- risks ---------------------------------------------------------------------------------------

  @Get('risks')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The register, page-based (`q`, `kind`, `status` (default live = not retired), `band` incl. `unassessed`, `categoryId`, `owner=me`, `sort`, `order`, `page`, `pageSize`)' })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(RiskListQuery, query));
  }

  @Get('risks/linked')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'kind', required: true, schema: { type: 'string', enum: ['ncr', 'capa', 'audit_finding', 'supplier', 'part', 'part_family', 'machine', 'document'] } })
  @ApiQuery({ name: 'id', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ description: 'Risks linked to one record (not retired; closed ones last), and whether the caller may raise one' })
  linked(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.linked(ctx, parse(LinkedQuery, query));
  }

  @Get('risk-draft')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'kind', required: true, schema: { type: 'string', enum: ['ncr', 'capa', 'audit_finding'] } })
  @ApiQuery({ name: 'id', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ description: 'What a risk raised from a non-conformance, an 8D or an audit finding would start with: fields and suggested links. Nothing is saved.' })
  draft(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.draft(ctx, parse(DraftQuery, query));
  }

  @Post('risks')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateRiskBody) })
  @ApiCreatedResponse({ description: 'Raises a risk or an opportunity as a draft (RSK-001 …), optionally from a non-conformance, an 8D or an audit finding (`raisedFrom`) and with links; the first assessment opens it' })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateRiskBody, body));
  }

  @Get('risks/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'A risk with every assessment, newest first' })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Patch('risks/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateRiskBody) })
  @ApiOkResponse({ description: 'Changes the details (the kind only while it is a draft; nothing once closed or retired)' })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateRiskBody, body));
  }

  @Post('risks/:id/assessments')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(AssessBody) })
  @ApiOkResponse({ description: 'Assesses the risk before treatment, or (`phase: residual`) what is left after it. The database works out the score and band; the earlier assessment is kept as superseded and the review date moves.' })
  assess(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.assess(ctx, parse(Uuid, id), parse(AssessBody, body));
  }

  @Post('risks/:id/retire')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Retires the risk with a reason (never deleted)' })
  retire(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.retire(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('risks/:id/reactivate')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Brings a retired risk back (open when it has been assessed, else a draft)' })
  reactivate(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.reactivate(ctx, parse(Uuid, id));
  }

  // ---- treatment, actions, acceptance, reviews, closing (RK2); every command answers with the whole risk ----

  @Put('risks/:id/treatment')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(TreatmentBody) })
  @ApiOkResponse({ description: 'What will be done about it (mitigate / avoid / transfer / accept; exploit or accept for an opportunity) and the plan in words' })
  setTreatment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setTreatment(ctx, parse(Uuid, id), parse(TreatmentBody, body));
  }

  @Post('risks/:id/actions')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateActionBody) })
  @ApiCreatedResponse({ description: 'Adds an action, given to an active member (default: the risk\'s owner)' })
  addAction(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addAction(ctx, parse(Uuid, id), parse(CreateActionBody, body));
  }

  @Patch('risk-actions/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateActionBody) })
  @ApiOkResponse({ description: 'Changes an open action' })
  updateAction(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateAction(ctx, parse(Uuid, id), parse(UpdateActionBody, body));
  }

  @Post('risk-actions/:id/complete')
  @HttpCode(200)
  @OrganisationScoped(READ)
  @ApiBody({ schema: openApiSchema(NoteBody) })
  @ApiOkResponse({ description: 'Done, with what was done: by someone who manages risks or the person the action was given to (the database decides)' })
  completeAction(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.completeAction(ctx, parse(Uuid, id), parse(NoteBody, body).note);
  }

  @Post('risk-actions/:id/cancel')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Cancels an open action with a reason (never deleted)' })
  cancelAction(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.cancelAction(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('risk-actions/:id/reopen')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Reopens a done or cancelled action' })
  reopenAction(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.reopenAction(ctx, parse(Uuid, id));
  }

  @Post('risks/:id/acceptances')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(AcceptanceBody) })
  @ApiCreatedResponse({ description: 'Proposes accepting a risk that sits above the acceptable level as it stands; an approver other than the proposer decides' })
  proposeAcceptance(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.proposeAcceptance(ctx, parse(Uuid, id), parse(AcceptanceBody, body).rationale);
  }

  @Post('risk-acceptances/:id/decide')
  @HttpCode(200)
  @OrganisationScoped(APPROVE)
  @ApiBody({ schema: openApiSchema(DecideBody) })
  @ApiOkResponse({ description: 'Approves or rejects a proposed acceptance, with a note (never the person who proposed it)' })
  decideAcceptance(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.decideAcceptance(ctx, parse(Uuid, id), parse(DecideBody, body));
  }

  @Post('risk-acceptances/:id/withdraw')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Withdraws a proposed acceptance (the person who proposed it, or an approver)' })
  withdrawAcceptance(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.withdrawAcceptance(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('risks/:id/reviews')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReviewBody) })
  @ApiCreatedResponse({ description: 'Records a review that found nothing changed, with a note; the next review date moves on (default: the months of its band)' })
  review(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.review(ctx, parse(Uuid, id), parse(ReviewBody, body));
  }

  @Post('risks/:id/close')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CloseBody) })
  @ApiOkResponse({ description: 'Closes the risk as treated, accepted or no longer applies, with a note; open actions are cancelled' })
  close(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.close(ctx, parse(Uuid, id), parse(CloseBody, body));
  }

  @Post('risks/:id/reopen')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Reopens a closed risk with a reason; its status is worked out again and it is due for review today' })
  reopen(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.reopen(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Put('risks/:id/links')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(LinksBody) })
  @ApiOkResponse({ description: 'Replaces everything the risk is linked to (the record it was raised from stays)' })
  setLinks(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setLinks(ctx, parse(Uuid, id), parse(LinksBody, body).links);
  }
}
