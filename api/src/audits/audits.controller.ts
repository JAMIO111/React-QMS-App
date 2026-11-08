import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { Audit, AUDIT_SORTABLE, AUDIT_TYPES, AuditListQuery, AuditPage, CreateAuditBody, ReasonBody, UpdateAuditBody } from './audits.schemas';
import { AuditsService } from './audits.service';

const READ = 'audits.read';
const MANAGE = 'audits.manage';

/** Audit definitions: the procedure, checklist, what the audit is relevant to, how often and who does it (Documentation → Audits). */
@ApiTags('audits')
@ApiBearerAuth()
@Controller('audits')
export class AuditsController {
  constructor(private readonly service: AuditsService) {}

  @Get()
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string' }, description: 'Title, number or purpose' })
  @ApiQuery({ name: 'status', required: false, schema: { type: 'string' }, description: 'Comma-separated: active, retired' })
  @ApiQuery({ name: 'type', required: false, schema: { type: 'string' }, description: `Comma-separated: ${AUDIT_TYPES.join(', ')}` })
  @ApiQuery({ name: 'machineId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'operationCode', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'departmentId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'sort', required: false, schema: { type: 'string', enum: [...AUDIT_SORTABLE], default: 'reference' } })
  @ApiQuery({ name: 'order', required: false, schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' } })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1, default: 1 } })
  @ApiQuery({ name: 'pageSize', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 } })
  @ApiOkResponse({ schema: openApiSchema(AuditPage) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(AuditListQuery, query));
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

  /** Change any part of the audit; `frequency`, `auditor`, `questions` and `targets` replace the whole of that part. Records already made keep the questions they were done against. */
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
