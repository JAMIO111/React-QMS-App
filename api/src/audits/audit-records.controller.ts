import { z } from 'zod';
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  AbandonBody,
  AttachmentListQuery,
  AuditAttachment,
  AuditRecord,
  CreateAuditAttachmentBody,
  RemoveAttachmentBody,
  RECORD_RESULTS,
  RECORD_SORTABLE,
  RECORD_STATUSES,
  RecordListQuery,
  RecordPage,
  ResponseBody,
  SetTargetsBody,
  StartAuditBody,
  UpdateRecordBody,
} from './audit-records.schemas';
import { AuditRecordsService } from './audit-records.service';
import { AUDIT_TYPES } from './audits.schemas';

const READ = 'audits.read';
const PERFORM = 'audits.perform';

/** Audit records: audits carried out, with the answer to every question and the result (Documentation → Audits → Audit records). */
@ApiTags('audits')
@ApiBearerAuth()
@Controller('audit-records')
export class AuditRecordsController {
  constructor(private readonly service: AuditRecordsService) {}

  @Get()
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string' }, description: 'Reference or audit title / number' })
  @ApiQuery({ name: 'auditId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'status', required: false, schema: { type: 'string' }, description: `Comma-separated: ${RECORD_STATUSES.join(', ')}` })
  @ApiQuery({ name: 'result', required: false, schema: { type: 'string' }, description: `Comma-separated: ${RECORD_RESULTS.join(', ')}` })
  @ApiQuery({ name: 'type', required: false, schema: { type: 'string' }, description: `Comma-separated: ${AUDIT_TYPES.join(', ')}` })
  @ApiQuery({ name: 'machineId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'operationCode', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'departmentId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'performedBy', required: false, schema: { type: 'string', format: 'uuid' }, description: 'The user who completed it, else who started it' })
  @ApiQuery({ name: 'mine', required: false, schema: { type: 'string', enum: ['true', 'false'] } })
  @ApiQuery({ name: 'from', required: false, schema: { type: 'string', format: 'date' }, description: 'Performed on or after' })
  @ApiQuery({ name: 'to', required: false, schema: { type: 'string', format: 'date' }, description: 'Performed on or before' })
  @ApiQuery({ name: 'sort', required: false, schema: { type: 'string', enum: [...RECORD_SORTABLE], default: 'performedOn' } })
  @ApiQuery({ name: 'order', required: false, schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1, default: 1 } })
  @ApiQuery({ name: 'pageSize', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 } })
  @ApiOkResponse({ schema: openApiSchema(RecordPage) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(RecordListQuery, query));
  }

  /** Start an audit (audits.perform): from a scheduled slot, or on its own. The audit's questions are copied into the record. */
  @Post()
  @HttpCode(201)
  @OrganisationScoped(PERFORM)
  @ApiBody({ schema: openApiSchema(StartAuditBody) })
  @ApiCreatedResponse({ schema: openApiSchema(AuditRecord) })
  start(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.start(ctx, parse(StartAuditBody, body));
  }

  @Get(':id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(AuditRecord) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  /** The audit's notes and the date it was carried out (while in progress). */
  @Patch(':id')
  @OrganisationScoped(PERFORM)
  @ApiBody({ schema: openApiSchema(UpdateRecordBody) })
  @ApiOkResponse({ schema: openApiSchema(AuditRecord) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateRecordBody, body));
  }

  /** Which of the audit's machines, operations and departments it was carried out on (replaces the list). */
  @Put(':id/targets')
  @OrganisationScoped(PERFORM)
  @ApiBody({ schema: openApiSchema(SetTargetsBody) })
  @ApiOkResponse({ schema: openApiSchema(AuditRecord) })
  setTargets(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setTargets(ctx, parse(Uuid, id), parse(SetTargetsBody, body));
  }

  /** Answer one question (or clear the answer). The database works out whether the answer passes. */
  @Put(':id/responses')
  @OrganisationScoped(PERFORM)
  @ApiBody({ schema: openApiSchema(ResponseBody) })
  @ApiOkResponse({ schema: openApiSchema(AuditRecord) })
  respond(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.respond(ctx, parse(Uuid, id), parse(ResponseBody, body));
  }

  /** Complete: everything answered, a note on every failure, the "carried out on" chosen. Works out the score and the result; the record is then frozen. */
  @Post(':id/complete')
  @HttpCode(200)
  @OrganisationScoped(PERFORM)
  @ApiOkResponse({ schema: openApiSchema(AuditRecord) })
  complete(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.complete(ctx, parse(Uuid, id));
  }

  @Post(':id/abandon')
  @HttpCode(200)
  @OrganisationScoped(PERFORM)
  @ApiBody({ schema: openApiSchema(AbandonBody) })
  @ApiOkResponse({ schema: openApiSchema(AuditRecord) })
  abandon(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.abandon(ctx, parse(Uuid, id), parse(AbandonBody, body));
  }

  @Get(':id/attachments')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'questionId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'deleted', required: false, schema: { type: 'string', enum: ['exclude', 'include', 'only'] } })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(AuditAttachment) })) })
  async attachments(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return { data: await this.service.listAttachments(ctx, parse(Uuid, id), parse(AttachmentListQuery, query)) };
  }

  /** Records a file already uploaded to the record's folder against an evidence question (in-progress records only). */
  @Post(':id/attachments')
  @HttpCode(201)
  @OrganisationScoped(PERFORM)
  @ApiBody({ schema: openApiSchema(CreateAuditAttachmentBody) })
  @ApiCreatedResponse({ schema: openApiSchema(AuditAttachment) })
  createAttachment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createAttachment(ctx, parse(Uuid, id), parse(CreateAuditAttachmentBody, body));
  }
}

/** Evidence files: take one off an in-progress record with a reason (the stored file is kept), or put it back. */
@ApiTags('audits')
@ApiBearerAuth()
@Controller('audit-attachments')
export class AuditAttachmentsController {
  constructor(private readonly service: AuditRecordsService) {}

  @Post(':id/delete')
  @HttpCode(200)
  @OrganisationScoped(PERFORM)
  @ApiBody({ schema: openApiSchema(RemoveAttachmentBody) })
  @ApiOkResponse({ schema: openApiSchema(AuditAttachment) })
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.removeAttachment(ctx, parse(Uuid, id), parse(RemoveAttachmentBody, body).reason);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @OrganisationScoped(PERFORM)
  @ApiOkResponse({ schema: openApiSchema(AuditAttachment) })
  restore(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.restoreAttachment(ctx, parse(Uuid, id));
  }
}
