import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { CreateEmployeeBody, Employee, EMPLOYEE_SORTABLE, EmployeeListQuery, EmployeeOption, EmployeePage, LinkLoginBody, LoginCandidates, UpdateEmployeeBody } from './employees.schemas';
import { EmployeesService } from './employees.service';

const READ = 'master_data.read';
const MANAGE = 'master_data.manage';

/** The employees register (master data): personnel, not necessarily system users. */
@ApiTags('employees')
@ApiBearerAuth()
@Controller('employees')
export class EmployeesController {
  constructor(private readonly service: EmployeesService) {}

  @Get()
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string' }, description: 'Name, job title, employee number or email' })
  @ApiQuery({ name: 'status', required: false, schema: { type: 'string' }, description: 'Comma-separated: active, inactive' })
  @ApiQuery({ name: 'siteId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'departmentId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'sort', required: false, schema: { type: 'string', enum: [...EMPLOYEE_SORTABLE], default: 'name' } })
  @ApiQuery({ name: 'order', required: false, schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' } })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1, default: 1 } })
  @ApiQuery({ name: 'pageSize', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 } })
  @ApiOkResponse({ schema: openApiSchema(EmployeePage) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(EmployeeListQuery, query));
  }

  /** Everyone, active or not, for pickers (e.g. the responsible employee on a non-conformance). Declared before `:id`. */
  @Get('lookup')
  @OrganisationScoped()
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(EmployeeOption) })) })
  async lookup(@Ctx() ctx: RequestContext) {
    return { data: await this.service.lookup(ctx) };
  }

  /** Members who could be linked to an employee, and whether the caller may link (a Controller seat). Declared before `:id`. */
  @Get('login-candidates')
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ schema: openApiSchema(LoginCandidates) })
  loginCandidates(@Ctx() ctx: RequestContext) {
    return this.service.loginCandidates(ctx);
  }

  @Post()
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateEmployeeBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Employee) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateEmployeeBody, body));
  }

  @Get(':id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(Employee) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  /** Change details, or deactivate / reactivate with `active`. Nobody is deleted. */
  @Patch(':id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateEmployeeBody) })
  @ApiOkResponse({ schema: openApiSchema(Employee) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateEmployeeBody, body));
  }

  /** Link the employee to a member's sign-in, or remove the link (`userId: null`). Needs master_data.manage **and** a Controller seat (409 employee_rule otherwise). */
  @Put(':id/login')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(LinkLoginBody) })
  @ApiOkResponse({ schema: openApiSchema(Employee) })
  linkLogin(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.linkLogin(ctx, parse(Uuid, id), parse(LinkLoginBody, body));
  }
}
