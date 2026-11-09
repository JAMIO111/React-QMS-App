import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { z } from 'zod';
import { openApiSchema, parse, Uuid } from '../common/validation';

const VersionNumber = z.coerce.number().int().min(1).max(100000);
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { Audit, AUDIT_SORTABLE, AuditVersion, OperationCodes, AUDIT_TYPES, AuditListQuery, AuditPage, CreateAuditBody, ReasonBody, UpdateAuditBody, VersionList } from './audits.schemas';
import { AuditsService } from './audits.service';
import { AuditVersionsService } from './audit-versions.service';

const READ = 'audits.read';
const MANAGE = 'audits.manage';

/** Audit definitions: the procedure, checklist, what the audit is relevant to, how often and who does it (Documentation → Audits). */
@ApiTags('audits')
@ApiBearerAuth()
@Controller('audits')
export class AuditsController {
  constructor(
    private readonly service: AuditsService,
    private readonly versions: AuditVersionsService,
  ) {}

  @Get()
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string' }, description: 'Title, number or purpose' })
  @ApiQuery({ name: 'status', required: false, schema: { type: 'string' }, description: 'Comma-separated: active, retired' })
  @ApiQuery({ name: 'type', required: false, schema: { type: 'string' }, description: `Comma-separated: ${AUDIT_TYPES.join(', ')}` })
  @ApiQuery({ name: 'machineId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'operationCode', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'departmentId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'supplierId', required: false, schema: { type: 'string', format: 'uuid' }, description: 'Only audits relevant to this supplier' })
  @ApiQuery({ name: 'sort', required: false, schema: { type: 'string', enum: [...AUDIT_SORTABLE], default: 'reference' } })
  @ApiQuery({ name: 'order', required: false, schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' } })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1, default: 1 } })
  @ApiQuery({ name: 'pageSize', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 } })
  @ApiOkResponse({ schema: openApiSchema(AuditPage) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(AuditListQuery, query));
  }

  /** Operation codes to choose from (control plan operations plus those already on an audit). Declared before `:id`. */
  @Get('operation-codes')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(OperationCodes) })
  operationCodes(@Ctx() ctx: RequestContext) {
    return this.service.operationCodes(ctx);
  }

  @Post()
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateAuditBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Audit) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateAuditBody, body));
  }

  @Get(':id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(Audit) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  /** The history of the audit: every version, newest first, with the reason, what changed from the one before and how many records were done against it. */
  @Get(':id/versions')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(VersionList) })
  versionHistory(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.versions.list(ctx, parse(Uuid, id));
  }

  /** One version, whole, with what it changed from the version before. */
  @Get(':id/versions/:version')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(AuditVersion) })
  oneVersion(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('version') version: string) {
    return this.versions.get(ctx, parse(Uuid, id), parse(VersionNumber, version));
  }

  /**
   * Change any part of the audit; `frequency`, `auditor`, `questions` and `targets` replace the whole of that part. A change to what the audit says (title, type, purpose, procedure,
   * pass mark, checklist, what it is relevant to) is saved as a new version and needs `changeReason`; a change to the schedule or the expected auditor does not. Records already made keep the
   * questions they were done against, and the version.
   */
  @Patch(':id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateAuditBody) })
  @ApiOkResponse({ schema: openApiSchema(Audit) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateAuditBody, body));
  }

  /** Stop the audit being scheduled (with a reason); its history stays. */
  @Post(':id/retire')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ schema: openApiSchema(Audit) })
  retire(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.retire(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ schema: openApiSchema(Audit) })
  reactivate(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.reactivate(ctx, parse(Uuid, id));
  }
}
