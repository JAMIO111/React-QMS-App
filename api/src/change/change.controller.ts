import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { Versioned } from '../common/versioned';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  AllQuery, Attachment, BoardBody, ChangeListQuery, CompleteTaskBody, CreateAttachmentBody, CreateTaskBody, CustomerApprovalBody, CutInBody, DecideBody, ImpactBody, CreateChangeBody, CreateFunctionBody,
  CreateTypeBody, DeleteBody, DeletedQuery, LinksBody, LinkTaskBody, ListItem, ReasonBody, ReviewBody, StartRevisionBody, UpdateAreaBody, UpdateChangeBody, UpdateFunctionBody, UpdateTaskBody, UpdateTypeBody,
} from './change.schemas';
import { ChangeService } from './change.service';

const READ = 'change.read';
const MANAGE = 'change.manage';
const APPROVE = 'change.approve';

/** Change management (CH1): types, functions and impact areas, and changes (ECR-YY-NNNN) with their scope and files. */
@ApiTags('change')
@ApiBearerAuth()
@Controller()
export class ChangeController {
  constructor(private readonly service: ChangeService) {}

  // ---- the lists ----------------------------------------------------------------------------------

  @Get('change-types')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'all', required: false, schema: { type: 'string', enum: ['true', 'false'] }, description: 'Include switched-off types' })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(ListItem) })) })
  types(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.types(ctx, parse(AllQuery, query));
  }

  @Post('change-types')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateTypeBody) })
  @ApiCreatedResponse({ schema: openApiSchema(ListItem) })
  createType(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createType(ctx, parse(CreateTypeBody, body));
  }

  @Patch('change-types/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateTypeBody) })
  @ApiOkResponse({ description: 'Renames, describes, reorders, switches off or on, or sets whether the customer must approve (nothing is deleted)', schema: openApiSchema(ListItem) })
  updateType(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateType(ctx, parse(Uuid, id), parse(UpdateTypeBody, body));
  }

  @Get('change-functions')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'all', required: false, schema: { type: 'string', enum: ['true', 'false'] } })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(ListItem) })) })
  functions(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.functions(ctx, parse(AllQuery, query));
  }

  @Post('change-functions')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateFunctionBody) })
  @ApiCreatedResponse({ schema: openApiSchema(ListItem) })
  createFunction(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createFunction(ctx, parse(CreateFunctionBody, body));
  }

  @Patch('change-functions/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateFunctionBody) })
  @ApiOkResponse({ schema: openApiSchema(ListItem) })
  updateFunction(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateFunction(ctx, parse(Uuid, id), parse(UpdateFunctionBody, body));
  }

  @Get('change-areas')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'all', required: false, schema: { type: 'string', enum: ['true', 'false'] } })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(ListItem) })) })
  areas(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.areas(ctx, parse(AllQuery, query));
  }

  @Patch('change-areas/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateAreaBody) })
  @ApiOkResponse({ description: 'Switches an impact area off or on (the list itself is fixed)', schema: openApiSchema(ListItem) })
  updateArea(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateArea(ctx, parse(Uuid, id), parse(UpdateAreaBody, body));
  }

  // ---- changes ------------------------------------------------------------------------------------

  @Get('change-signers')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Active members who could be put on a change board, and whether each can sign (the approve right and a package that includes it)' })
  signers(@Ctx() ctx: RequestContext) {
    return this.service.signers(ctx);
  }

  @Get('changes/mine')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'What is waiting for the caller: sign-offs for them, open tasks given to them, and the changes they raised that are still going (declared before `changes/{id}`)' })
  mine(@Ctx() ctx: RequestContext) {
    return this.service.mine(ctx);
  }

  @Get('changes/mine/count')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The menu badge: `{ signoffs, tasks, overdue, total }`' })
  mineCount(@Ctx() ctx: RequestContext) {
    return this.service.mineCount(ctx);
  }

  @Get('changes')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The register, page-based (`q`, `stage` (default open), `typeId`, `urgency`, `owner=me`, `originKind`, `partId|partFamilyId|machineId|supplierId|customerId`, `sort`, `order`, `page`, `pageSize`)' })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(ChangeListQuery, query));
  }

  @Post('changes')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateChangeBody) })
  @ApiCreatedResponse({ description: 'Raises a change as a draft (ECR-YY-NNNN), optionally from a non-conformance, an 8D, an audit finding, a risk or a document change request (`origin`) and with what it covers (`links`)' })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateChangeBody, body));
  }

  @Versioned('change_requests')
  @Get('changes/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'A change with its scope, origin and files' })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Versioned('change_requests')
  @Patch('changes/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateChangeBody) })
  @ApiOkResponse({ description: 'Changes the title, what, why, type or urgency of a draft' })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateChangeBody, body));
  }

  @Put('changes/:id/links')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(LinksBody) })
  @ApiOkResponse({ description: 'Replaces everything the change covers (parts, families, machines, suppliers, customers, orders, operations); a draft only' })
  setLinks(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setLinks(ctx, parse(Uuid, id), parse(LinksBody, body).links);
  }

  @Post('changes/:id/submit')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Draft to assessment: needs what, why and what it covers; makes a row for every active impact area' })
  submit(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.submit(ctx, parse(Uuid, id));
  }

  @Put('changes/:id/impacts')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ImpactBody) })
  @ApiOkResponse({ description: 'Answers one impact area while the change is in assessment: affected (a note says how), not affected, or not assessed' })
  setImpact(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setImpact(ctx, parse(Uuid, id), parse(ImpactBody, body));
  }

  @Put('changes/:id/board')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(BoardBody) })
  @ApiOkResponse({ description: 'Chooses the board (replaces it): the functions that must sign and who signs for each' })
  setBoard(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setBoard(ctx, parse(Uuid, id), parse(BoardBody, body));
  }

  @Post('changes/:id/send-to-board')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Assessment to approval: starts a new review round with a pending sign-off per function' })
  sendToBoard(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.sendToBoard(ctx, parse(Uuid, id));
  }

  @Post('changes/:id/recall')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Takes the change back from the board to assessment with a reason; the pending sign-offs are superseded' })
  recall(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.recall(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('change-signoffs/:id/decide')
  @HttpCode(200)
  @OrganisationScoped(APPROVE)
  @ApiBody({ schema: openApiSchema(DecideBody) })
  @ApiOkResponse({ description: 'The named signer approves, or rejects with a comment (which returns the change to assessment). The last approval approves the change.' })
  decide(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.decide(ctx, parse(Uuid, id), parse(DecideBody, body));
  }

  @Put('changes/:id/cut-in')
  @OrganisationScoped(READ)
  @ApiBody({ schema: openApiSchema(CutInBody) })
  @ApiOkResponse({ description: 'Sets the cut-in point (none, a date, an order, a lot or a serial number) and what happens to existing stock. A manager, or a signer of the current round (the database decides).' })
  setCutIn(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setCutIn(ctx, parse(Uuid, id), parse(CutInBody, body));
  }

  @Put('changes/:id/customer-approval')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CustomerApprovalBody) })
  @ApiOkResponse({ description: 'Records the customer\'s approval: not needed, required, requested, approved, rejected or waived (with a reason)' })
  setCustomerApproval(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setCustomerApproval(ctx, parse(Uuid, id), parse(CustomerApprovalBody, body));
  }

  @Post('changes/:id/tasks')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateTaskBody) })
  @ApiCreatedResponse({ description: 'Adds a task to an approved change (what, who, by when, the impact area, and optionally the record it changes). Answers with the whole change; the stage follows the tasks.' })
  addTask(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addTask(ctx, parse(Uuid, id), parse(CreateTaskBody, body));
  }

  @Patch('change-tasks/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateTaskBody) })
  @ApiOkResponse({ description: 'Changes an open task (wording, who, due date, impact area); answers with the whole change' })
  updateTask(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateTask(ctx, parse(Uuid, id), parse(UpdateTaskBody, body));
  }

  @Put('change-tasks/:id/link')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(LinkTaskBody) })
  @ApiOkResponse({ description: 'Points an open task at the record it changes (or null to take the link away)' })
  linkTask(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.linkTask(ctx, parse(Uuid, id), parse(LinkTaskBody, body));
  }

  @Post('change-tasks/:id/complete')
  @HttpCode(200)
  @OrganisationScoped(READ)
  @ApiBody({ schema: openApiSchema(CompleteTaskBody) })
  @ApiOkResponse({ description: 'Finishes a task: a manager, or the person it was given to (the database decides). A task that changes a revision needs that revision in force.' })
  completeTask(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.completeTask(ctx, parse(Uuid, id), parse(CompleteTaskBody, body));
  }

  @Post('change-tasks/:id/cancel')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Cancels an open task with a reason (never deleted)' })
  cancelTask(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.cancelTask(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('change-tasks/:id/reopen')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Reopens a done task with a reason' })
  reopenTask(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.reopenTask(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('change-tasks/:id/start-revision')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(StartRevisionBody) })
  @ApiOkResponse({ description: 'Starts the next revision of a part, a control plan or a document as the caller and points the task at it; answers with the whole change and `started`' })
  startRevision(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.startRevision(ctx, parse(Uuid, id), parse(StartRevisionBody, body));
  }

  @Post('changes/:id/reviews')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReviewBody) })
  @ApiOkResponse({ description: 'The effectiveness check once every task is done: effective closes the change, not effective sends it back to implementing. A note is always needed.' })
  review(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.review(ctx, parse(Uuid, id), parse(ReviewBody, body));
  }

  @Post('changes/:id/cancel')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Cancels a change with a reason (never deleted)' })
  cancel(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.cancel(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Get('changes/:id/attachments')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'deleted', required: false, schema: { type: 'string', enum: ['exclude', 'include', 'only'] } })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(Attachment) })) })
  async attachments(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return { data: await this.service.listAttachments(ctx, parse(Uuid, id), parse(DeletedQuery, query)) };
  }

  @Post('changes/:id/attachments')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateAttachmentBody) })
  @ApiCreatedResponse({ description: 'Records a file already uploaded to the change’s folder (not once closed, rejected or cancelled)', schema: openApiSchema(Attachment) })
  createAttachment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createAttachment(ctx, parse(Uuid, id), parse(CreateAttachmentBody, body));
  }

  @Post('change-attachments/:id/delete')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(DeleteBody) })
  @ApiOkResponse({ description: 'Takes a file off the change with a reason; the stored file is kept', schema: openApiSchema(Attachment) })
  removeAttachment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.removeAttachment(ctx, parse(Uuid, id), parse(DeleteBody, body).reason);
  }

  @Post('change-attachments/:id/restore')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ schema: openApiSchema(Attachment) })
  restoreAttachment(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.restoreAttachment(ctx, parse(Uuid, id));
  }
}
