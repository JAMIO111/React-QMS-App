import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  ActionBody, AttendeesBody, CompleteBody, DecisionBody, GatherBody, InputBody, MinutesBody, NoteBody, PlanReviewBody, ReasonBody, ReviewListQuery, UpdateActionBody, UpdateReviewBody,
} from './management-reviews.schemas';
import { ManagementReviewsService } from './management-reviews.service';

const READ = 'management_review.read';
const MANAGE = 'management_review.manage';

/**
 * Management reviews (MR2). Reading needs management_review.read; everything else management_review.manage, except closing an action, which its owner may do
 * without either (the database decides). Every command answers with the whole review.
 */
@ApiTags('management review')
@ApiBearerAuth()
@Controller()
export class ManagementReviewsController {
  constructor(private readonly service: ManagementReviewsService) {}

  @Get('management-reviews')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'status', required: false, description: 'Comma-separated: planned, in_progress, completed, cancelled' })
  @ApiOkResponse({ description: 'The reviews, those still to hold first, then the latest period first' })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(ReviewListQuery, query).status);
  }

  @Post('management-reviews')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(PlanReviewBody) })
  @ApiCreatedResponse({ description: 'Plans a review (MR-YY-NN) for a period, with its twelve input sections' })
  plan(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.plan(ctx, parse(PlanReviewBody, body));
  }

  @Get('management-reviews/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The review with its inputs (snapshots, commentary), attendees, minutes, decisions, actions and what is still needed to complete it' })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Patch('management-reviews/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateReviewBody) })
  @ApiOkResponse({ description: 'Changes the title, planned date, chair, the period (before it starts) or the day it was held (once started)' })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateReviewBody, body));
  }

  @Post('management-reviews/:id/start')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Starts the review and gathers every data section for its period, as the caller (a section they may not read is "not available")' })
  start(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.start(ctx, parse(Uuid, id));
  }

  @Post('management-reviews/:id/gather')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(GatherBody) })
  @ApiOkResponse({ description: 'Gathers the figures again (all data sections, or those named); each gathered section is to be reviewed again' })
  gather(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.gather(ctx, parse(Uuid, id), parse(GatherBody, body ?? {}).sections);
  }

  @Patch('management-review-inputs/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(InputBody) })
  @ApiOkResponse({ description: 'Commentary on one input section and whether it was reviewed' })
  setInput(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(InputBody, body);
    return this.service.setInput(ctx, parse(Uuid, id), b.commentary, b.reviewed);
  }

  @Put('management-reviews/:id/attendees')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(AttendeesBody) })
  @ApiOkResponse({ description: 'Replaces the attendees: members or named outsiders, a role, invited / present / apologies' })
  setAttendees(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setAttendees(ctx, parse(Uuid, id), parse(AttendeesBody, body));
  }

  @Put('management-reviews/:id/minutes')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(MinutesBody) })
  @ApiOkResponse({ description: 'Saves the minutes (a TipTap document) while the review is held' })
  setMinutes(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setMinutes(ctx, parse(Uuid, id), parse(MinutesBody, body).minutes);
  }

  @Post('management-reviews/:id/decisions')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(DecisionBody) })
  @ApiCreatedResponse({ description: 'Records a decision while the review is held' })
  addDecision(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(DecisionBody, body);
    return this.service.addDecision(ctx, parse(Uuid, id), b.description, b.category);
  }

  @Patch('management-review-decisions/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(DecisionBody) })
  @ApiOkResponse({ description: 'Rewords a decision while the review is held' })
  updateDecision(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(DecisionBody, body);
    return this.service.updateDecision(ctx, parse(Uuid, id), b.description, b.category);
  }

  @Delete('management-review-decisions/:id')
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Takes a decision back while the review is held (not once actions came from it)' })
  removeDecision(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.removeDecision(ctx, parse(Uuid, id));
  }

  @Post('management-reviews/:id/actions')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ActionBody) })
  @ApiCreatedResponse({ description: 'Gives an action to a member (optionally from a decision) while the review is held' })
  addAction(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addAction(ctx, parse(Uuid, id), parse(ActionBody, body));
  }

  @Patch('management-review-actions/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateActionBody) })
  @ApiOkResponse({ description: 'Changes an open action: owner and due date at any time, its words while the review is held' })
  updateAction(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateAction(ctx, parse(Uuid, id), parse(UpdateActionBody, body));
  }

  @Post('management-review-actions/:id/complete')
  @HttpCode(200)
  @OrganisationScoped()
  @ApiBody({ schema: openApiSchema(NoteBody) })
  @ApiOkResponse({ description: 'Closes an action with what was done (its owner, or a manager)' })
  completeAction(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.completeAction(ctx, parse(Uuid, id), parse(NoteBody, body).note);
  }

  @Post('management-review-actions/:id/cancel')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Cancels an open action with a reason' })
  cancelAction(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.cancelAction(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('management-review-actions/:id/reopen')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Reopens a done or cancelled action' })
  reopenAction(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.reopenAction(ctx, parse(Uuid, id));
  }

  @Post('management-reviews/:id/complete')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CompleteBody) })
  @ApiOkResponse({ description: 'Completes the review (every section reviewed, someone present, a decision or a note why none): it is then frozen' })
  complete(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.complete(ctx, parse(Uuid, id), parse(CompleteBody, body ?? {}).noDecisionNote);
  }

  @Post('management-reviews/:id/cancel')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Cancels a review that is planned or being held, with a reason; its open actions are cancelled with it' })
  cancel(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.cancel(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }
}
