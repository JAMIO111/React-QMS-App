import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { Schedule, ScheduleItem, ScheduleQuery, SCHEDULE_STATES } from './audit-schedule.schemas';
import { AuditScheduleService } from './audit-schedule.service';
import { ReasonBody } from './audits.schemas';

const READ = 'audits.read';
const MANAGE = 'audits.manage';

/** The audit schedule: what is coming up, overdue and missed. Slots are made when it is read. */
@ApiTags('audits')
@ApiBearerAuth()
@Controller()
export class AuditScheduleController {
  constructor(private readonly service: AuditScheduleService) {}

  @Get('audit-schedule')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'from', required: false, schema: { type: 'string', format: 'date' }, description: 'Default: 30 days ago' })
  @ApiQuery({ name: 'to', required: false, schema: { type: 'string', format: 'date' }, description: 'Default: 30 days ahead' })
  @ApiQuery({ name: 'state', required: false, schema: { type: 'string' }, description: `Comma-separated: ${SCHEDULE_STATES.join(', ')}` })
  @ApiQuery({ name: 'auditId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'machineId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'operationCode', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'departmentId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ schema: openApiSchema(Schedule) })
  schedule(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.schedule(ctx, parse(ScheduleQuery, query));
  }

  /** Skip a slot (machine down, shutdown) with a reason; it then does not count as missed. */
  @Post('audit-occurrences/:id/skip')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ schema: openApiSchema(ScheduleItem) })
  skip(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.skip(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('audit-occurrences/:id/unskip')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ schema: openApiSchema(ScheduleItem) })
  unskip(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.unskip(ctx, parse(Uuid, id));
  }
}
