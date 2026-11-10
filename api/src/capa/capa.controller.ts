import { pickCustomFilters } from '../custom-fields/custom-values';
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { Attachment, CreateAttachmentBody, DeleteBody, DeletedQuery } from '../calibration/calibration.schemas';
import { z } from 'zod';
import { AddTeamBody, CapaDetail, CapaList, CloseCapaBody, MyActionList, MyActionsQuery, CompleteActionBody, CompleteStepBody, CreateActionBody, CreateAnalysisBody, CreateCapaBody, CreateRootCauseBody, CreateVerificationBody, LinkNcrBody, UpdateRootCauseBody, UpdateActionBody, UpdateAnalysisBody, ListQuery, NcrCapaList, PeopleList, PeopleQuery, ReasonBody, ReopenStepBody, UpdateCapaBody, UpdateTeamBody } from './capa.schemas';
import { CapaService } from './capa.service';

const READ = 'capa.read';
const MANAGE = 'capa.manage';

/** Corrective actions (CAPA, method 8D). */
@ApiTags('capa')
@ApiBearerAuth()
@Controller('capas')
export class CapasController {
  constructor(private readonly service: CapaService) {}

  @Get()
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'stage', required: false, schema: { type: 'string', enum: ['running', 'open', 'actions_in_progress', 'awaiting_verification', 'verified_effective', 'closed', 'cancelled', 'all'] } })
  @ApiQuery({ name: 'ncrId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'owner', required: false, schema: { type: 'string', enum: ['me'] } })
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string' } })
  @ApiOkResponse({ schema: openApiSchema(CapaList) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(ListQuery, query), pickCustomFilters(query));
  }

  /** Active members for the team and owner pickers. Declared before ':id' so it is not read as an id. */
  @Get('people')
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ schema: openApiSchema(PeopleList) })
  people(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.people(ctx, parse(PeopleQuery, query));
  }

  @Post()
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateCapaBody) })
  @ApiCreatedResponse({ description: 'Starts an 8D, from a non-conformance (linked, and filling what is left blank) or on its own', schema: openApiSchema(CapaDetail) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateCapaBody, body));
  }

  @Get(':id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(CapaDetail) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Patch(':id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateCapaBody) })
  @ApiOkResponse({ description: 'Edits the header (title, problem statement, source, severity, reference, owner, due date) until the 8D is closed or cancelled', schema: openApiSchema(CapaDetail) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateCapaBody, body));
  }

  @Post(':id/complete-step')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CompleteStepBody) })
  @ApiOkResponse({ description: 'Completes a step, in order, when nothing is still needed for it', schema: openApiSchema(CapaDetail) })
  completeStep(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.completeStep(ctx, parse(Uuid, id), parse(CompleteStepBody, body));
  }

  @Post(':id/reopen-step')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReopenStepBody) })
  @ApiOkResponse({ description: 'Reopens a step and every later complete step, with a reason', schema: openApiSchema(CapaDetail) })
  reopenStep(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.reopenStep(ctx, parse(Uuid, id), parse(ReopenStepBody, body));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ schema: openApiSchema(CapaDetail) })
  cancel(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.cancel(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }

  @Post(':id/close')
  @HttpCode(200)
  @OrganisationScoped('capa.verify')
  @ApiBody({ schema: openApiSchema(CloseCapaBody) })
  @ApiOkResponse({ description: 'Closes the 8D at D8: needs capa.verify, D0 to D7 complete and the actions verified effective', schema: openApiSchema(CapaDetail) })
  close(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.close(ctx, parse(Uuid, id), parse(CloseCapaBody, body ?? {}));
  }

  @Get(':id/attachments')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'deleted', required: false, schema: { type: 'string', enum: ['exclude', 'include', 'only'] } })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(Attachment) })) })
  async attachments(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return { data: await this.service.listAttachments(ctx, parse(Uuid, id), parse(DeletedQuery, query)) };
  }

  @Post(':id/attachments')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateAttachmentBody) })
  @ApiCreatedResponse({ description: 'Records a file already uploaded to the 8D’s folder (running 8Ds only)', schema: openApiSchema(Attachment) })
  createAttachment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createAttachment(ctx, parse(Uuid, id), parse(CreateAttachmentBody, body));
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ schema: openApiSchema(CapaDetail) })
  reopen(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.reopen(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }

  @Post(':id/team')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(AddTeamBody) })
  @ApiCreatedResponse({ description: 'Adds an organisation member or an external contact to the team', schema: openApiSchema(CapaDetail) })
  addTeam(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addTeamMember(ctx, parse(Uuid, id), parse(AddTeamBody, body));
  }

  @Post(':id/analyses')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateAnalysisBody) })
  @ApiCreatedResponse({ description: 'Saves an analysis made with a tool (Is / Is-Not now); its data is checked against the kind', schema: openApiSchema(CapaDetail) })
  addAnalysis(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addAnalysis(ctx, parse(Uuid, id), parse(CreateAnalysisBody, body));
  }

  @Post(':id/root-causes')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateRootCauseBody) })
  @ApiCreatedResponse({ description: 'Records a root cause (occurrence, escape or systemic), optionally from an analysis of this 8D; it starts unverified', schema: openApiSchema(CapaDetail) })
  addRootCause(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addRootCause(ctx, parse(Uuid, id), parse(CreateRootCauseBody, body));
  }

  @Post(':id/verifications')
  @HttpCode(201)
  @OrganisationScoped('capa.verify')
  @ApiBody({ schema: openApiSchema(CreateVerificationBody) })
  @ApiCreatedResponse({ description: 'Records whether the corrective actions worked. Needs capa.verify, nothing open, one action done; a failed verification needs a note and reopens D5 and D6.', schema: openApiSchema(CapaDetail) })
  addVerification(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addVerification(ctx, parse(Uuid, id), parse(CreateVerificationBody, body));
  }

  @Post(':id/actions')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateActionBody) })
  @ApiCreatedResponse({ description: 'Adds an action (interim containment now); the owner must be on the team', schema: openApiSchema(CapaDetail) })
  addAction(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addAction(ctx, parse(Uuid, id), parse(CreateActionBody, body));
  }

  @Post(':id/ncrs')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(LinkNcrBody) })
  @ApiCreatedResponse({ description: 'Links a non-conformance to this 8D', schema: openApiSchema(CapaDetail) })
  linkNcr(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.linkNcr(ctx, parse(Uuid, id), parse(LinkNcrBody, body));
  }
}

@ApiTags('capa')
@ApiBearerAuth()
@Controller('capa-team')
export class CapaTeamController {
  constructor(private readonly service: CapaService) {}

  @Patch(':id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateTeamBody) })
  @ApiOkResponse({ description: 'Changes a team member’s role or contact details, or ends their place on the team (the record stays)', schema: openApiSchema(CapaDetail) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateTeamMember(ctx, parse(Uuid, id), parse(UpdateTeamBody, body));
  }
}

@ApiTags('capa')
@ApiBearerAuth()
@Controller('capa-ncr-links')
export class CapaNcrLinksController {
  constructor(private readonly service: CapaService) {}

  @Post(':id/unlink')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Ends the link with a reason (the record of it stays)', schema: openApiSchema(CapaDetail) })
  unlink(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.unlinkNcr(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }
}

@ApiTags('capa')
@ApiBearerAuth()
@Controller('ncrs')
export class NcrCapasController {
  constructor(private readonly service: CapaService) {}

  @Get(':id/capas')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The 8Ds this non-conformance is linked to', schema: openApiSchema(NcrCapaList) })
  forNcr(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.forNcr(ctx, parse(Uuid, id));
  }
}

@ApiTags('capa')
@ApiBearerAuth()
@Controller('capa-analyses')
export class CapaAnalysesController {
  constructor(private readonly service: CapaService) {}

  @Patch(':id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateAnalysisBody) })
  @ApiOkResponse({ schema: openApiSchema(CapaDetail) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateAnalysis(ctx, parse(Uuid, id), parse(UpdateAnalysisBody, body));
  }

  @Delete(':id')
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Marks the analysis removed (the record stays); answers with the 8D', schema: openApiSchema(CapaDetail) })
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.removeAnalysis(ctx, parse(Uuid, id));
  }
}

@ApiTags('capa')
@ApiBearerAuth()
@Controller('capa-actions')
export class CapaActionsController {
  constructor(private readonly service: CapaService) {}

  /** The caller's own actions across running 8Ds. */
  @Get('mine')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'status', required: false, schema: { type: 'string', enum: ['open', 'done', 'all'] } })
  @ApiOkResponse({ schema: openApiSchema(MyActionList) })
  mine(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.myActions(ctx, parse(MyActionsQuery, query));
  }

  // The actionee (capa.read) may update the findings and close or reopen their own action; the database refuses anything else to anyone who is neither
  // the actionee nor able to manage 8Ds, and refuses a non-manager any change to what the action is, who has it or when it is due.
  @Patch(':id')
  @OrganisationScoped(READ)
  @ApiBody({ schema: openApiSchema(UpdateActionBody) })
  @ApiOkResponse({ schema: openApiSchema(CapaDetail) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateAction(ctx, parse(Uuid, id), parse(UpdateActionBody, body));
  }

  @Post(':id/complete')
  @HttpCode(200)
  @OrganisationScoped(READ)
  @ApiBody({ schema: openApiSchema(CompleteActionBody) })
  @ApiOkResponse({ description: 'Marks the action done (stamped by the database). The findings must be written, now or before', schema: openApiSchema(CapaDetail) })
  complete(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.completeAction(ctx, parse(Uuid, id), parse(CompleteActionBody, body ?? {}));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ schema: openApiSchema(CapaDetail) })
  cancel(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.cancelAction(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Puts a done action back to open (the actionee), or a cancelled one (managers)', schema: openApiSchema(CapaDetail) })
  reopen(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.reopenAction(ctx, parse(Uuid, id));
  }
}

@ApiTags('capa')
@ApiBearerAuth()
@Controller('capa-root-causes')
export class CapaRootCausesController {
  constructor(private readonly service: CapaService) {}

  @Patch(':id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateRootCauseBody) })
  @ApiOkResponse({ description: 'Edits a root cause or verifies it (needs a method). Changing the words or kind of a verified cause withdraws its verification.', schema: openApiSchema(CapaDetail) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateRootCause(ctx, parse(Uuid, id), parse(UpdateRootCauseBody, body));
  }

  @Delete(':id')
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Marks the root cause removed (the record stays); answers with the 8D', schema: openApiSchema(CapaDetail) })
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.removeRootCause(ctx, parse(Uuid, id));
  }
}

@ApiTags('capa')
@ApiBearerAuth()
@Controller('capa-attachments')
export class CapaAttachmentsController {
  constructor(private readonly service: CapaService) {}

  @Post(':id/delete')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(DeleteBody) })
  @ApiOkResponse({ description: 'Takes a file off a running 8D with a reason; the stored file is kept', schema: openApiSchema(Attachment) })
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.removeAttachment(ctx, parse(Uuid, id), parse(DeleteBody, body).reason);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ schema: openApiSchema(Attachment) })
  restore(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.restoreAttachment(ctx, parse(Uuid, id));
  }
}
