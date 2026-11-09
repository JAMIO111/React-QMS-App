import { z } from 'zod';
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  Classification,
  ClassificationListQuery,
  CloseFindingBody,
  CreateClassificationBody,
  CreatedNcr,
  CreateFindingAttachmentBody,
  CreateFindingBody,
  CreateNcrBody,
  Finding,
  FINDING_KINDS,
  FINDING_SORTABLE,
  FINDING_STATUSES,
  FindingAttachment,
  FindingAttachmentListQuery,
  FindingListQuery,
  FindingPage,
  NcrAuditSource,
  RemoveFindingAttachmentBody,
  ReopenFindingBody,
  UpdateClassificationBody,
  UpdateFindingBody,
  WithdrawFindingBody,
} from './audit-findings.schemas';
import { AuditFindingsService } from './audit-findings.service';

const READ = 'audits.read';
const PERFORM = 'audits.perform';
const MANAGE = 'audits.manage';

/** The organisation's finding classifications (major / minor non-conformity, observation, opportunity for improvement, …). */
@ApiTags('audits')
@ApiBearerAuth()
@Controller('audit-finding-classifications')
export class AuditFindingClassificationsController {
  constructor(private readonly service: AuditFindingsService) {}

  @Get()
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'all', required: false, schema: { type: 'string', enum: ['true', 'false'] }, description: 'true: include the ones switched off' })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(Classification) })) })
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return { data: await this.service.listClassifications(ctx, parse(ClassificationListQuery, query).all === 'true') };
  }

  @Post()
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateClassificationBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Classification) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createClassification(ctx, parse(CreateClassificationBody, body));
  }

  /** Rename, set the default severity, reorder or switch off. The key and kind never change; nothing is deleted. */
  @Patch(':id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateClassificationBody) })
  @ApiOkResponse({ schema: openApiSchema(Classification) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateClassification(ctx, parse(Uuid, id), parse(UpdateClassificationBody, body));
  }
}

/** Findings of an audit record: list them, add one (from an answer or standalone). */
@ApiTags('audits')
@ApiBearerAuth()
@Controller('audit-records')
export class AuditRecordFindingsController {
  constructor(private readonly service: AuditFindingsService) {}

  @Get(':id/findings')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(Finding) })) })
  async list(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return { data: await this.service.listForRecord(ctx, parse(Uuid, id)) };
  }

  /** Needs audits.perform; allowed on an in-progress or completed record, not an abandoned one. */
  @Post(':id/findings')
  @HttpCode(201)
  @OrganisationScoped(PERFORM)
  @ApiBody({ schema: openApiSchema(CreateFindingBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Finding) })
  create(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.create(ctx, parse(Uuid, id), parse(CreateFindingBody, body));
  }
}

/** Audit findings: the register, one finding, editing, withdrawing, closing, reopening, raising a non-conformance, and evidence files. */
@ApiTags('audits')
@ApiBearerAuth()
@Controller('audit-findings')
export class AuditFindingsController {
  constructor(private readonly service: AuditFindingsService) {}

  @Get()
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string' }, description: 'Reference, title, description, audit record or audit title' })
  @ApiQuery({ name: 'recordId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'supplierId', required: false, schema: { type: 'string', format: 'uuid' }, description: 'Only findings from records carried out on this supplier' })
  @ApiQuery({ name: 'auditId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'classificationId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'kind', required: false, schema: { type: 'string' }, description: `Comma-separated: ${FINDING_KINDS.join(', ')}` })
  @ApiQuery({ name: 'status', required: false, schema: { type: 'string' }, description: `Comma-separated: ${FINDING_STATUSES.join(', ')}` })
  @ApiQuery({ name: 'ownerId', required: false, schema: { type: 'string', format: 'uuid' }, description: 'An employee' })
  @ApiQuery({ name: 'overdue', required: false, schema: { type: 'string', enum: ['true', 'false'] } })
  @ApiQuery({ name: 'from', required: false, schema: { type: 'string', format: 'date' }, description: 'The audit was carried out on or after' })
  @ApiQuery({ name: 'to', required: false, schema: { type: 'string', format: 'date' }, description: 'The audit was carried out on or before' })
  @ApiQuery({ name: 'sort', required: false, schema: { type: 'string', enum: [...FINDING_SORTABLE], default: 'createdAt' } })
  @ApiQuery({ name: 'order', required: false, schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1, default: 1 } })
  @ApiQuery({ name: 'pageSize', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 } })
  @ApiOkResponse({ schema: openApiSchema(FindingPage) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(FindingListQuery, query));
  }

  @Get(':id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(Finding) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  /** Edit an open finding (audits.perform). */
  @Patch(':id')
  @OrganisationScoped(PERFORM)
  @ApiBody({ schema: openApiSchema(UpdateFindingBody) })
  @ApiOkResponse({ schema: openApiSchema(Finding) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateFindingBody, body));
  }

  /** A finding raised in error. Needs a reason; not once it has a live non-conformance. */
  @Post(':id/withdraw')
  @HttpCode(200)
  @OrganisationScoped(PERFORM)
  @ApiBody({ schema: openApiSchema(WithdrawFindingBody) })
  @ApiOkResponse({ schema: openApiSchema(Finding) })
  withdraw(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.withdraw(ctx, parse(Uuid, id), parse(WithdrawFindingBody, body).reason);
  }

  /** Close with a note (audits.manage). A finding with a live non-conformance closes only once that is closed. */
  @Post(':id/close')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CloseFindingBody) })
  @ApiOkResponse({ schema: openApiSchema(Finding) })
  close(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.close(ctx, parse(Uuid, id), parse(CloseFindingBody, body).note);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReopenFindingBody) })
  @ApiOkResponse({ schema: openApiSchema(Finding) })
  reopen(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.reopen(ctx, parse(Uuid, id), parse(ReopenFindingBody, body).reason);
  }

  /** Raise a draft internal non-conformance from a finding classified as a non-conformity (needs ncr.create), on request only. Asking again returns the same one (`created: false`). */
  @Post(':id/create-ncr')
  @HttpCode(200)
  @OrganisationScoped(READ)
  @ApiBody({ schema: openApiSchema(CreateNcrBody) })
  @ApiOkResponse({ schema: openApiSchema(CreatedNcr) })
  createNcr(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createNcr(ctx, parse(Uuid, id), parse(CreateNcrBody, body ?? {}));
  }

  @Get(':id/attachments')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'deleted', required: false, schema: { type: 'string', enum: ['exclude', 'include', 'only'] } })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(FindingAttachment) })) })
  async attachments(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return { data: await this.service.listAttachments(ctx, parse(Uuid, id), parse(FindingAttachmentListQuery, query)) };
  }

  /** Records a file already uploaded to the finding's folder (open findings only). */
  @Post(':id/attachments')
  @HttpCode(201)
  @OrganisationScoped(PERFORM)
  @ApiBody({ schema: openApiSchema(CreateFindingAttachmentBody) })
  @ApiCreatedResponse({ schema: openApiSchema(FindingAttachment) })
  createAttachment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createAttachment(ctx, parse(Uuid, id), parse(CreateFindingAttachmentBody, body));
  }
}

/** Evidence files of a finding: take one off with a reason (the stored file is kept), or put it back. */
@ApiTags('audits')
@ApiBearerAuth()
@Controller('audit-finding-attachments')
export class AuditFindingAttachmentsController {
  constructor(private readonly service: AuditFindingsService) {}

  @Post(':id/delete')
  @HttpCode(200)
  @OrganisationScoped(PERFORM)
  @ApiBody({ schema: openApiSchema(RemoveFindingAttachmentBody) })
  @ApiOkResponse({ schema: openApiSchema(FindingAttachment) })
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.removeAttachment(ctx, parse(Uuid, id), parse(RemoveFindingAttachmentBody, body).reason);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @OrganisationScoped(PERFORM)
  @ApiOkResponse({ schema: openApiSchema(FindingAttachment) })
  restore(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.restoreAttachment(ctx, parse(Uuid, id));
  }
}

/** The audit, finding and evidence behind a non-conformance raised from an audit. */
@ApiTags('audits')
@ApiBearerAuth()
@Controller('ncrs')
export class NcrAuditSourceController {
  constructor(private readonly service: AuditFindingsService) {}

  @Get(':id/audit-source')
  @OrganisationScoped('ncr.read')
  @ApiOkResponse({ schema: openApiSchema(NcrAuditSource) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.ncrSource(ctx, parse(Uuid, id));
  }
}
