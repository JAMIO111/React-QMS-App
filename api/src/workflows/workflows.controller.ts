import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { parse } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { CancelBody, CompleteBody, CreateRuleBody, StatusBody, TaskListQuery, UpdateRuleBody } from './workflows.schemas';
import { WorkflowsService } from './workflows.service';

@ApiTags('workflows')
@ApiBearerAuth()
@Controller()
export class WorkflowsController {
  constructor(private readonly service: WorkflowsService) {}

  @Get('workflow-triggers')
  @OrganisationScoped('workflows.read')
  @ApiOkResponse({ description: 'What a rule can start from, and for each what it can test (fields, their kinds and choices)' })
  triggers() {
    return this.service.triggers();
  }

  @Get('workflow-rules')
  @OrganisationScoped('workflows.read')
  @ApiOkResponse({ description: 'Every workflow rule with its trigger, status, version and how often it ran' })
  list(@Ctx() ctx: RequestContext) {
    return this.service.list(ctx);
  }

  @Post('workflow-rules')
  @OrganisationScoped('workflows.manage')
  @ApiOkResponse({ description: 'Write a rule (version 1); conditions and actions are checked against the trigger. Answers with the rule.' })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateRuleBody, body));
  }

  @Get('workflow-rules/:id')
  @OrganisationScoped('workflows.read')
  @ApiOkResponse({ description: 'A rule: what it does now, every version with its reason, and its latest runs' })
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(ctx, id);
  }

  @Patch('workflow-rules/:id')
  @OrganisationScoped('workflows.manage')
  @ApiOkResponse({ description: 'Rename or describe a rule; a change to its trigger, conditions or actions is a new version and needs a reason' })
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.service.update(ctx, id, parse(UpdateRuleBody, body));
  }

  @Post('workflow-rules/:id/status')
  @HttpCode(200)
  @OrganisationScoped('workflows.manage')
  @ApiOkResponse({ description: 'Pause, resume, retire (with a reason) or bring back a rule' })
  status(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(StatusBody, body);
    return this.service.setStatus(ctx, id, b.status, b.reason);
  }

  @Get('workflow-tasks/mine')
  @OrganisationScoped()
  @ApiOkResponse({ description: "The caller's own workflow tasks (open by default), with the record each is about; no workflow permission needed" })
  mine(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.myTasks(ctx, parse(TaskListQuery, query).status);
  }

  @Post('workflow-tasks/:id/complete')
  @HttpCode(200)
  @OrganisationScoped()
  @ApiOkResponse({ description: 'Mark a task done (its person, or someone who manages workflows), with an optional note' })
  complete(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.service.taskCommand(ctx, id, 'complete', parse(CompleteBody, body ?? {}).note);
  }

  @Post('workflow-tasks/:id/reopen')
  @HttpCode(200)
  @OrganisationScoped()
  @ApiOkResponse({ description: 'Reopen a done task' })
  reopen(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.taskCommand(ctx, id, 'reopen');
  }

  @Post('workflow-tasks/:id/cancel')
  @HttpCode(200)
  @OrganisationScoped('workflows.manage')
  @ApiOkResponse({ description: 'Cancel an open task, with a reason (someone who manages workflows)' })
  cancel(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.service.taskCommand(ctx, id, 'cancel', parse(CancelBody, body).reason);
  }
}
