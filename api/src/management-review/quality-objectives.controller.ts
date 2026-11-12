import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { CreateObjectiveBody, ObjectiveListQuery, ObjectiveQuery, RecordValueBody, UpdateObjectiveBody } from './quality-objectives.schemas';
import { QualityObjectivesService } from './quality-objectives.service';

const MANAGE = 'management_review.manage';
const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

/**
 * Quality objectives (MR1). Reading needs management_review.read, except that the owner of an objective reads it (RLS decides what is listed, so these routes
 * need membership only); the owner records the values of a manual objective, and so does a manager. Defining, changing and retiring need management_review.manage.
 */
@ApiTags('management review')
@ApiBearerAuth()
@Controller()
export class QualityObjectivesController {
  constructor(private readonly service: QualityObjectivesService) {}

  @Get('quality-objective-measures')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'The fixed list of measures: entered by hand, or worked out by the system (with whether the caller may read what it counts)' })
  measures(@Ctx() ctx: RequestContext) {
    return this.service.measures(ctx);
  }

  @Get('quality-objectives')
  @OrganisationScoped()
  @ApiQuery({ name: 'all', required: false, schema: { type: 'string', enum: ['true', 'false'] }, description: 'Include retired objectives' })
  @ApiOkResponse({ description: 'The objectives the caller may read, each with its last six periods, the latest value and whether it is on target' })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(ObjectiveListQuery, query).all === 'true');
  }

  @Post('quality-objectives')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateObjectiveBody) })
  @ApiCreatedResponse({ description: 'Defines an objective (QO-001 …); a system measure brings its own unit and direction' })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateObjectiveBody, body));
  }

  @Get('quality-objectives/:id')
  @OrganisationScoped()
  @ApiQuery({ name: 'periods', required: false, schema: { type: 'integer', minimum: 1, maximum: 60 } })
  @ApiOkResponse({ description: 'One objective with its periods (oldest first, the current one last), values, corrections and standing against the target' })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return this.service.get(ctx, parse(Uuid, id), parse(ObjectiveQuery, query).periods);
  }

  @Patch('quality-objectives/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateObjectiveBody) })
  @ApiOkResponse({ description: 'Changes the title, description, owner, target (and the unit and direction of a manual objective); the measure and frequency are fixed' })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateObjectiveBody, body));
  }

  @Post('quality-objectives/:id/retire')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Retires the objective with a reason (nothing is deleted)' })
  retire(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.retire(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('quality-objectives/:id/reactivate')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Brings a retired objective back' })
  reactivate(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.reactivate(ctx, parse(Uuid, id));
  }

  @Post('quality-objectives/:id/values')
  @HttpCode(201)
  @OrganisationScoped()
  @ApiBody({ schema: openApiSchema(RecordValueBody) })
  @ApiOkResponse({ description: 'Records the value of a manual objective for the period a day falls in (its owner or a manager); a second value for a period is a correction and needs a note' })
  recordValue(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.recordValue(ctx, parse(Uuid, id), parse(RecordValueBody, body));
  }
}
