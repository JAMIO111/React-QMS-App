import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { pageSchema } from '../common/pagination';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  ControlPlanDetail,
  ControlPlanListQuery,
  ControlPlanSummary,
  CreateApplicabilityBody,
  CreateControlPlanBody,
  CreateMachineBody,
  CreatePartFamilyBody,
  CreatePlanRevisionBody,
  CreateSpecValueBody,
  HistoryEntry,
  Machine,
  MachineListQuery,
  PartFamily,
  PartFamilyDetail,
  PartFamilyListQuery,
  PlanRevision,
  PlanRevisionTransitionBody,
  SpecValue,
  UpdateControlPlanBody,
  UpdateMachineBody,
  UpdatePartFamilyBody,
  UpdatePlanRevisionBody,
  UpdateSpecValueBody,
} from './process-control.schemas';
import { ProcessControlService } from './process-control.service';

const MD_READ = 'master_data.read';
const MD_MANAGE = 'master_data.manage';
const PC_READ = 'process_control.read';
const PC_MANAGE = 'process_control.manage';

const listQueries = (extra: MethodDecorator[] = []): MethodDecorator => (target, key, desc) => {
  [
    ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }),
    ApiQuery({ name: 'cursor', required: false, schema: { type: 'string' } }),
    ApiQuery({ name: 'q', required: false, schema: { type: 'string' } }),
    ApiQuery({ name: 'includeInactive', required: false, schema: { type: 'boolean', default: false } }),
    ...extra,
  ].forEach((d) => d(target, key, desc));
};

@ApiTags('machines')
@ApiBearerAuth()
@Controller('machines')
export class MachinesController {
  constructor(private readonly service: ProcessControlService) {}

  @Get()
  @OrganisationScoped(MD_READ)
  @listQueries([ApiQuery({ name: 'siteId', required: false, schema: { type: 'string', format: 'uuid' } })])
  @ApiOkResponse({ schema: openApiSchema(pageSchema(Machine)) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.listMachines(ctx, parse(MachineListQuery, query));
  }

  @Post()
  @HttpCode(201)
  @OrganisationScoped(MD_MANAGE)
  @ApiBody({ schema: openApiSchema(CreateMachineBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Machine) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createMachine(ctx, parse(CreateMachineBody, body));
  }

  @Patch(':id')
  @OrganisationScoped(MD_MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateMachineBody) })
  @ApiOkResponse({ schema: openApiSchema(Machine) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateMachine(ctx, parse(Uuid, id), parse(UpdateMachineBody, body));
  }
}

@ApiTags('part-families')
@ApiBearerAuth()
@Controller('part-families')
export class PartFamiliesController {
  constructor(private readonly service: ProcessControlService) {}

  @Get()
  @OrganisationScoped(MD_READ)
  @listQueries()
  @ApiOkResponse({ schema: openApiSchema(pageSchema(PartFamily)) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.listFamilies(ctx, parse(PartFamilyListQuery, query));
  }

  @Post()
  @HttpCode(201)
  @OrganisationScoped(MD_MANAGE)
  @ApiBody({ schema: openApiSchema(CreatePartFamilyBody) })
  @ApiCreatedResponse({ schema: openApiSchema(PartFamilyDetail) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createFamily(ctx, parse(CreatePartFamilyBody, body));
  }

  @Get(':id')
  @OrganisationScoped(MD_READ)
  @ApiOkResponse({ schema: openApiSchema(PartFamilyDetail) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.getFamily(ctx, parse(Uuid, id));
  }

  @Patch(':id')
  @OrganisationScoped(MD_MANAGE)
  @ApiBody({ schema: openApiSchema(UpdatePartFamilyBody) })
  @ApiOkResponse({ schema: openApiSchema(PartFamilyDetail) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateFamily(ctx, parse(Uuid, id), parse(UpdatePartFamilyBody, body));
  }
}

/** Part-specific characteristic values of a part revision (editable while the revision is a draft). */
@ApiTags('parts')
@ApiBearerAuth()
@Controller()
export class SpecValuesController {
  constructor(private readonly service: ProcessControlService) {}

  @Get('part-revisions/:id/characteristics')
  @OrganisationScoped(MD_READ)
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(SpecValue) })) })
  async list(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return { data: await this.service.listSpecValues(ctx, parse(Uuid, id)) };
  }

  @Post('part-revisions/:id/characteristics')
  @HttpCode(201)
  @OrganisationScoped(MD_MANAGE)
  @ApiBody({ schema: openApiSchema(CreateSpecValueBody) })
  @ApiCreatedResponse({ schema: openApiSchema(SpecValue) })
  create(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createSpecValue(ctx, parse(Uuid, id), parse(CreateSpecValueBody, body));
  }

  @Patch('part-revision-characteristics/:id')
  @OrganisationScoped(MD_MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateSpecValueBody) })
  @ApiOkResponse({ schema: openApiSchema(SpecValue) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateSpecValue(ctx, parse(Uuid, id), parse(UpdateSpecValueBody, body));
  }

  @Delete('part-revision-characteristics/:id')
  @HttpCode(204)
  @OrganisationScoped(MD_MANAGE)
  @ApiNoContentResponse()
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.service.deleteSpecValue(ctx, parse(Uuid, id));
  }
}

@ApiTags('control-plans')
@ApiBearerAuth()
@Controller('control-plans')
export class ControlPlansController {
  constructor(private readonly service: ProcessControlService) {}

  @Get()
  @OrganisationScoped(PC_READ)
  @listQueries([
    ApiQuery({ name: 'partFamilyId', required: false, schema: { type: 'string', format: 'uuid' } }),
    ApiQuery({ name: 'status', required: false, schema: { type: 'string', enum: ['effective', 'no_effective', 'pending_approval'] } }),
  ])
  @ApiOkResponse({ schema: openApiSchema(pageSchema(ControlPlanSummary)) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.listPlans(ctx, parse(ControlPlanListQuery, query));
  }

  /** Creates the plan with a first draft revision (and optionally a first scope entry). */
  @Post()
  @HttpCode(201)
  @OrganisationScoped(PC_MANAGE)
  @ApiBody({ schema: openApiSchema(CreateControlPlanBody) })
  @ApiCreatedResponse({ schema: openApiSchema(ControlPlanDetail) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createPlan(ctx, parse(CreateControlPlanBody, body));
  }

  @Get(':id')
  @OrganisationScoped(PC_READ)
  @ApiOkResponse({ schema: openApiSchema(ControlPlanDetail) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.getPlan(ctx, parse(Uuid, id));
  }

  @Patch(':id')
  @OrganisationScoped(PC_MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateControlPlanBody) })
  @ApiOkResponse({ schema: openApiSchema(ControlPlanDetail) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updatePlan(ctx, parse(Uuid, id), parse(UpdateControlPlanBody, body));
  }

  @Get(':id/history')
  @OrganisationScoped(PC_READ)
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(HistoryEntry) })) })
  async history(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return { data: await this.service.history(ctx, parse(Uuid, id)) };
  }

  @Post(':id/applicability')
  @HttpCode(201)
  @OrganisationScoped(PC_MANAGE)
  @ApiBody({ schema: openApiSchema(CreateApplicabilityBody) })
  @ApiCreatedResponse({ schema: openApiSchema(ControlPlanDetail) })
  addApplicability(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addApplicability(ctx, parse(Uuid, id), parse(CreateApplicabilityBody, body));
  }

  /** A new draft revision (only one working copy per plan at a time). */
  @Post(':id/revisions')
  @HttpCode(201)
  @OrganisationScoped(PC_MANAGE)
  @ApiBody({ schema: openApiSchema(CreatePlanRevisionBody) })
  @ApiCreatedResponse({ schema: openApiSchema(PlanRevision) })
  createRevision(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createRevision(ctx, parse(Uuid, id), parse(CreatePlanRevisionBody, body));
  }
}

@ApiTags('control-plans')
@ApiBearerAuth()
@Controller()
export class ControlPlanRevisionsController {
  constructor(private readonly service: ProcessControlService) {}

  @Delete('control-plan-applicability/:id')
  @OrganisationScoped(PC_MANAGE)
  @ApiOkResponse({ schema: openApiSchema(ControlPlanDetail) })
  removeApplicability(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.removeApplicability(ctx, parse(Uuid, id));
  }

  /** Edit a draft revision (others are locked). */
  @Patch('control-plan-revisions/:id')
  @OrganisationScoped(PC_MANAGE)
  @ApiBody({ schema: openApiSchema(UpdatePlanRevisionBody) })
  @ApiOkResponse({ schema: openApiSchema(PlanRevision) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateRevision(ctx, parse(Uuid, id), parse(UpdatePlanRevisionBody, body));
  }

  /**
   * Lifecycle: submit, withdraw, send_back (with a comment), approve (makes it effective now unless
   * it is dated later or makeEffective is false), make_effective, obsolete (with a reason). Readers
   * may call it; the database refuses what the caller's permissions do not allow.
   */
  @Post('control-plan-revisions/:id/transitions')
  @HttpCode(200)
  @OrganisationScoped(PC_READ)
  @ApiBody({ schema: openApiSchema(PlanRevisionTransitionBody) })
  @ApiOkResponse({ schema: openApiSchema(PlanRevision) })
  transition(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.transitionRevision(ctx, parse(Uuid, id), parse(PlanRevisionTransitionBody, body));
  }
}
