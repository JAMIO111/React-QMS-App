import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { Attachment, CreateAttachmentBody, DeleteBody, DeletedQuery } from '../calibration/calibration.schemas';
import { ActiveList, ActiveQuery, AcknowledgeBody, AddRecipientBody, AlertDetail, AlertList, CreateAlertBody, ListQuery, MineCount, MineList, ReasonBody, RecipientList, RecipientsPreview, UpdateAlertBody } from './documentation.schemas';
import { DocumentationService } from './documentation.service';

const READ = 'documentation.read';
const MANAGE = 'documentation.manage';
const ISSUE = 'documentation.issue';

/** Quality alerts: controlled communications that need immediate attention (the first controlled document type). */
@ApiTags('documentation')
@ApiBearerAuth()
@Controller('quality-alerts')
export class QualityAlertsController {
  constructor(private readonly service: DocumentationService) {}

  @Get()
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'status', required: false, schema: { type: 'string', enum: ['draft', 'active', 'expired', 'withdrawn', 'superseded', 'all'] } })
  @ApiQuery({ name: 'category', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'severity', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'overdue', required: false, schema: { type: 'string', enum: ['true', 'false'] } })
  @ApiOkResponse({ description: 'The newest revision of each alert (drafts only for people who manage documentation)', schema: openApiSchema(AlertList) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(ListQuery, query));
  }

  /** Alerts addressed to the signed-in person, open first. Declared before ':id' so it is not read as an id. */
  @Get('mine')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(MineList) })
  mine(@Ctx() ctx: RequestContext) {
    return this.service.mine(ctx);
  }

  /** Alerts in force that affect a part, family, machine or operation. Declared before ':id'. */
  @Get('active')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'partId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'partFamilyId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'machineId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'operationCode', required: false, schema: { type: 'string' } })
  @ApiOkResponse({ description: 'Active alerts that affect the given work, most severe first', schema: openApiSchema(ActiveList) })
  active(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.active(ctx, parse(ActiveQuery, query));
  }

  @Get('mine/count')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'How many alerts still need the signed-in person’s acknowledgement, and how many are overdue', schema: openApiSchema(MineCount) })
  mineCount(@Ctx() ctx: RequestContext) {
    return this.service.mineCount(ctx);
  }

  @Post()
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateAlertBody) })
  @ApiCreatedResponse({ description: 'A new draft with the next QA number', schema: openApiSchema(AlertDetail) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateAlertBody, body));
  }

  @Get(':id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(AlertDetail) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Patch(':id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateAlertBody) })
  @ApiOkResponse({ description: 'Edits a draft (content and, if given, its whole scope and targets). An issued alert needs a revision.', schema: openApiSchema(AlertDetail) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateAlertBody, body));
  }

  @Delete(':id')
  @HttpCode(204)
  @OrganisationScoped(MANAGE)
  @ApiNoContentResponse({ description: 'Discards a draft. An issued alert is withdrawn instead.' })
  async discard(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.service.discard(ctx, parse(Uuid, id));
  }

  @Get(':id/recipients-preview')
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'How many people each target reaches, before the alert is issued', schema: openApiSchema(RecipientsPreview) })
  preview(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.preview(ctx, parse(Uuid, id));
  }

  @Get(':id/recipients')
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Who was asked to acknowledge, and who has viewed and acknowledged', schema: openApiSchema(RecipientList) })
  recipients(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.recipients(ctx, parse(Uuid, id));
  }

  @Post(':id/recipients')
  @HttpCode(201)
  @OrganisationScoped(ISSUE)
  @ApiBody({ schema: openApiSchema(AddRecipientBody) })
  @ApiCreatedResponse({ description: 'Adds a person to an active alert; they are notified', schema: openApiSchema(AlertDetail) })
  addRecipient(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addRecipient(ctx, parse(Uuid, id), parse(AddRecipientBody, body));
  }

  @Post(':id/acknowledge')
  @HttpCode(200)
  @OrganisationScoped(READ)
  @ApiBody({ schema: openApiSchema(AcknowledgeBody) })
  @ApiOkResponse({ description: 'The signed-in person acknowledges an alert addressed to them (once, never for someone else)', schema: openApiSchema(AlertDetail) })
  acknowledge(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.acknowledge(ctx, parse(Uuid, id), parse(AcknowledgeBody, body ?? {}));
  }

  @Get(':id/attachments')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(Attachment) })) })
  async attachments(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return { data: await this.service.listAttachments(ctx, parse(Uuid, id), parse(DeletedQuery, query)) };
  }

  @Post(':id/attachments')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateAttachmentBody) })
  @ApiCreatedResponse({ description: 'Records a file already uploaded to the alert’s folder (drafts only)', schema: openApiSchema(Attachment) })
  createAttachment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createAttachment(ctx, parse(Uuid, id), parse(CreateAttachmentBody, body));
  }

  @Post(':id/issue')
  @HttpCode(200)
  @OrganisationScoped(ISSUE)
  @ApiOkResponse({ description: 'Makes the draft active; the revision it replaces becomes superseded', schema: openApiSchema(AlertDetail) })
  issue(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.issue(ctx, parse(Uuid, id));
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @OrganisationScoped(ISSUE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ schema: openApiSchema(AlertDetail) })
  withdraw(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.withdraw(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }

  @Post(':id/revisions')
  @HttpCode(201)
  @OrganisationScoped(ISSUE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiCreatedResponse({ description: 'A draft revision copied from this alert, to edit and issue', schema: openApiSchema(AlertDetail) })
  revise(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.revise(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }
}

@ApiTags('documentation')
@ApiBearerAuth()
@Controller('quality-alert-attachments')
export class QualityAlertAttachmentsController {
  constructor(private readonly service: DocumentationService) {}

  @Post(':id/delete')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(DeleteBody) })
  @ApiOkResponse({ description: 'Takes a file off a draft with a reason; the stored file is kept', schema: openApiSchema(Attachment) })
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
