import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { pageSchema } from '../common/pagination';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  CreateDepartmentBody,
  CreateSiteBody,
  Department,
  DepartmentListQuery,
  Site,
  SiteListQuery,
  UpdateDepartmentBody,
  UpdateSiteBody,
} from './structure.schemas';
import { StructureService } from './structure.service';

const listQueries = [
  ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }),
  ApiQuery({ name: 'cursor', required: false, schema: { type: 'string' } }),
  ApiQuery({ name: 'includeInactive', required: false, schema: { type: 'boolean', default: false } }),
];
const apply = (decorators: MethodDecorator[]): MethodDecorator => (target, key, desc) => {
  decorators.forEach((d) => d(target, key, desc));
};

@ApiTags('sites')
@ApiBearerAuth()
@Controller('sites')
export class SitesController {
  constructor(private readonly structure: StructureService) {}

  @Get()
  @OrganisationScoped()
  @apply(listQueries)
  @ApiOkResponse({ schema: openApiSchema(pageSchema(Site)) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.structure.listSites(ctx, parse(SiteListQuery, query));
  }

  @Post()
  @HttpCode(201)
  @OrganisationScoped('organisation.manage')
  @ApiBody({ schema: openApiSchema(CreateSiteBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Site) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.structure.createSite(ctx, parse(CreateSiteBody, body));
  }

  @Patch(':id')
  @OrganisationScoped('organisation.manage')
  @ApiBody({ schema: openApiSchema(UpdateSiteBody) })
  @ApiOkResponse({ schema: openApiSchema(Site) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.structure.updateSite(ctx, parse(Uuid, id), parse(UpdateSiteBody, body));
  }
}

@ApiTags('departments')
@ApiBearerAuth()
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly structure: StructureService) {}

  @Get()
  @OrganisationScoped()
  @apply([...listQueries, ApiQuery({ name: 'siteId', required: false, schema: { type: 'string', format: 'uuid' } })])
  @ApiOkResponse({ schema: openApiSchema(pageSchema(Department)) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.structure.listDepartments(ctx, parse(DepartmentListQuery, query));
  }

  @Post()
  @HttpCode(201)
  @OrganisationScoped('organisation.manage')
  @ApiBody({ schema: openApiSchema(CreateDepartmentBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Department) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.structure.createDepartment(ctx, parse(CreateDepartmentBody, body));
  }

  @Patch(':id')
  @OrganisationScoped('organisation.manage')
  @ApiBody({ schema: openApiSchema(UpdateDepartmentBody) })
  @ApiOkResponse({ schema: openApiSchema(Department) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.structure.updateDepartment(ctx, parse(Uuid, id), parse(UpdateDepartmentBody, body));
  }
}
