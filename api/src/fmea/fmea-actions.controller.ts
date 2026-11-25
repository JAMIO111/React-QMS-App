import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { FmeaActionsService } from './fmea-actions.service';
import { CompareQuery, CompleteActionBody, CreateActionBody, MyActionsQuery, ReasonBody, UpdateActionBody } from './fmea.schemas';

const READ = 'fmea.read';
const MANAGE = 'fmea.manage';

/** FMEA (FM4): actions on causes, My actions, and comparing revisions. */
@ApiTags('fmea')
@ApiBearerAuth()
@Controller()
export class FmeaActionsController {
  constructor(private readonly service: FmeaActionsService) {}

  @Post('fmea-causes/:id/actions')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateActionBody) })
  @ApiCreatedResponse({ description: 'Gives an action to a member or an employee, on a cause of a draft or of the revision in force. Answers with the whole revision' })
  add(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addAction(ctx, parse(Uuid, id), parse(CreateActionBody, body));
  }

  @Get('fmea-actions/mine')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The actions given to the caller (`status` open (default) | done | all): `{ data, openCount, overdueCount }`' })
  mine(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.mine(ctx, parse(MyActionsQuery, query));
  }

  @Patch('fmea-actions/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateActionBody) })
  @ApiOkResponse({ description: 'Changes an open action (what, who, when). Answers with the action' })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateAction(ctx, parse(Uuid, id), parse(UpdateActionBody, body));
  }

  @Post('fmea-actions/:id/complete')
  @HttpCode(200)
  @OrganisationScoped(READ)
  @ApiBody({ schema: openApiSchema(CompleteActionBody) })
  @ApiOkResponse({ description: 'Finishes an action with what was found and, optionally, the occurrence and detection it comes to now. A manager, or the person it is given to (the database decides)' })
  complete(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.completeAction(ctx, parse(Uuid, id), parse(CompleteActionBody, body));
  }

  @Post('fmea-actions/:id/cancel')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Cancels an open action, with a reason' })
  cancel(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.cancelAction(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('fmea-actions/:id/reopen')
  @HttpCode(200)
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Reopens a finished action that has not been adopted into a revision (a manager, or the person it is given to)' })
  reopen(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.reopenAction(ctx, parse(Uuid, id));
  }

  @Get('fmea-revisions/:id/compare')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'What changed since the revision before it (or since `with`): rows added, removed and changed, matched by lineage' })
  compare(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return this.service.compare(ctx, parse(Uuid, id), parse(CompareQuery, query).with);
  }

  @Get('fmea-revisions/:id/base-changes')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'For an FMEA started from a base: what has changed in the base since it was copied. Nothing is changed' })
  baseChanges(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.baseChanges(ctx, parse(Uuid, id));
  }
}
