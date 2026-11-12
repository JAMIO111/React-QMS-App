import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  AddAffectedLotBody,
  AffectedLot,
  AffectedLots,
  ApproveBody,
  CompleteContainmentBody,
  Containment,
  ContainmentAction,
  ContainmentReasonBody,
  CreateContainmentBody,
  CreateDispositionBody,
  GenerateRmaBody,
  Disposition,
  Dispositions,
  Gates,
  ReasonBody,
  UpdateAffectedLotBody,
  UpdateContainmentBody,
  UpdateDispositionBody,
} from './ncr-workflow.schemas';
import { NcrWorkflowService } from './ncr-workflow.service';

// Site-scoped role assignments count; RLS then limits rows to the NC's site.
const SITE_SCOPED = { anyScope: true };

@ApiTags('ncrs')
@ApiBearerAuth()
@Controller('ncrs')
export class NcrWorkflowController {
  constructor(private readonly service: NcrWorkflowService) {}

  @Get(':id/containment')
  @OrganisationScoped('ncr.read', SITE_SCOPED)
  @ApiOkResponse({ schema: openApiSchema(Containment) })
  containment(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.containment(ctx, parse(Uuid, id));
  }

  /** Add a containment action (what is being done to stop suspect product going on). */
  @Post(':id/containment-actions')
  @HttpCode(201)
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(CreateContainmentBody) })
  @ApiCreatedResponse({ schema: openApiSchema(ContainmentAction) })
  createAction(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createAction(ctx, parse(Uuid, id), parse(CreateContainmentBody, body));
  }

  /** Say why no containment is needed (reason), or clear it (null). */
  @Put(':id/containment-reason')
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(ContainmentReasonBody) })
  @ApiOkResponse({ schema: openApiSchema(Containment) })
  setReason(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setNotNeededReason(ctx, parse(Uuid, id), parse(ContainmentReasonBody, body).reason);
  }

  @Get(':id/dispositions')
  @OrganisationScoped('ncr.read', SITE_SCOPED)
  @ApiOkResponse({ schema: openApiSchema(Dispositions) })
  dispositions(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.dispositions(ctx, parse(Uuid, id));
  }

  /** Propose a disposition for some of the affected items; it takes effect when an approver approves it. */
  @Post(':id/dispositions')
  @HttpCode(201)
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(CreateDispositionBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Disposition) })
  createDisposition(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createDisposition(ctx, parse(Uuid, id), parse(CreateDispositionBody, body));
  }

  /** Generate an RMA number for all or part of the quantity of a customer non-conformance: it becomes a proposed "customer return" disposition. */
  @Post(':id/rma')
  @HttpCode(201)
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(GenerateRmaBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Disposition) })
  generateRma(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.generateRma(ctx, parse(Uuid, id), parse(GenerateRmaBody, body));
  }

  @Get(':id/affected-lots')
  @OrganisationScoped('ncr.read', SITE_SCOPED)
  @ApiOkResponse({ schema: openApiSchema(AffectedLots) })
  affectedLots(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.affectedLots(ctx, parse(Uuid, id));
  }

  /** Name a lot of the NC's part that the non-conformance touches, and how many of its items. */
  @Post(':id/affected-lots')
  @HttpCode(201)
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(AddAffectedLotBody) })
  @ApiCreatedResponse({ schema: openApiSchema(AffectedLot) })
  addAffectedLot(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addAffectedLot(ctx, parse(Uuid, id), parse(AddAffectedLotBody, body));
  }

  /** What is still needed to reach each later stage. */
  @Get(':id/gates')
  @OrganisationScoped('ncr.read', SITE_SCOPED)
  @ApiOkResponse({ schema: openApiSchema(Gates) })
  gates(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.gates(ctx, parse(Uuid, id));
  }
}

@ApiTags('ncrs')
@ApiBearerAuth()
@Controller('ncr-containment-actions')
export class NcrContainmentActionsController {
  constructor(private readonly service: NcrWorkflowService) {}

  @Patch(':id')
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(UpdateContainmentBody) })
  @ApiOkResponse({ schema: openApiSchema(ContainmentAction) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateAction(ctx, parse(Uuid, id), parse(UpdateContainmentBody, body));
  }

  /** Mark it done: say what was done and found. */
  @Post(':id/complete')
  @HttpCode(200)
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(CompleteContainmentBody) })
  @ApiOkResponse({ schema: openApiSchema(ContainmentAction) })
  complete(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.completeAction(ctx, parse(Uuid, id), parse(CompleteContainmentBody, body));
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiOkResponse({ schema: openApiSchema(ContainmentAction) })
  reopen(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.reopenAction(ctx, parse(Uuid, id));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ schema: openApiSchema(ContainmentAction) })
  cancel(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.cancelAction(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }
}

@ApiTags('ncrs')
@ApiBearerAuth()
@Controller('ncr-dispositions')
export class NcrDispositionsController {
  constructor(private readonly service: NcrWorkflowService) {}

  /** Change a proposed disposition (an approved one is frozen: cancel it and propose another). */
  @Patch(':id')
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(UpdateDispositionBody) })
  @ApiOkResponse({ schema: openApiSchema(Disposition) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateDisposition(ctx, parse(Uuid, id), parse(UpdateDispositionBody, body));
  }

  /** Approve a proposed disposition (needs ncr.approve_disposition; the preparer may approve their own). */
  @Post(':id/approve')
  @HttpCode(200)
  @OrganisationScoped('ncr.approve_disposition', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(ApproveBody) })
  @ApiOkResponse({ schema: openApiSchema(Disposition) })
  approve(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.approveDisposition(ctx, parse(Uuid, id), parse(ApproveBody, body ?? {}).note);
  }

  /** Cancel a disposition with a reason; cancelling an approved one needs ncr.approve_disposition. */
  @Post(':id/cancel')
  @HttpCode(200)
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ schema: openApiSchema(Disposition) })
  cancel(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.cancelDisposition(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }
}

@ApiTags('ncrs')
@ApiBearerAuth()
@Controller('ncr-affected-lots')
export class NcrAffectedLotsController {
  constructor(private readonly service: NcrWorkflowService) {}

  @Patch(':id')
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(UpdateAffectedLotBody) })
  @ApiOkResponse({ schema: openApiSchema(AffectedLot) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateAffectedLot(ctx, parse(Uuid, id), parse(UpdateAffectedLotBody, body));
  }

  /** Take the lot off the NC, with a reason (nothing is deleted); refused while a disposition or containment action still names it. */
  @Post(':id/remove')
  @HttpCode(200)
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ schema: openApiSchema(AffectedLot) })
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.removeAffectedLot(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiOkResponse({ schema: openApiSchema(AffectedLot) })
  restore(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.restoreAffectedLot(ctx, parse(Uuid, id));
  }
}
