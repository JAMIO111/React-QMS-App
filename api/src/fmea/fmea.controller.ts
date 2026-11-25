import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { Versioned } from '../common/versioned';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { ApproveBody, ApproverBody, CommentBody, CreateFmeaBody, FmeaListQuery, LinkedFmeaQuery, LinksBody, ReasonBody, ReviewBody, StartRevisionBody, TeamBody, UpdateFmeaBody, UpdateRevisionBody } from './fmea.schemas';
import { FmeaLinkedService } from './fmea-linked.service';
import { FmeaService } from './fmea.service';

const READ = 'fmea.read';
const MANAGE = 'fmea.manage';
const APPROVE = 'fmea.approve';

/** FMEA (FM1): design and process FMEAs (FMEA-NNN) with revisions, a team and what each covers. */
@ApiTags('fmea')
@ApiBearerAuth()
@Controller()
export class FmeaController {
  constructor(
    private readonly service: FmeaService,
    private readonly linkedService: FmeaLinkedService,
  ) {}

  @Get('fmeas')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'A page of FMEAs: `{ data, page, pageSize, total }`; by default the ones not withdrawn or discarded' })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(FmeaListQuery, query));
  }

  @Get('fmea-people')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(z.object({ id: z.string().uuid(), name: z.string(), canApprove: z.boolean() })) })), description: 'Members who may be named on a team or as approver' })
  people(@Ctx() ctx: RequestContext) {
    return this.service.people(ctx);
  }

  @Post('fmeas')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateFmeaBody) })
  @ApiCreatedResponse({ description: 'Starts an FMEA (FMEA-NNN) with its first draft revision, optionally with the team and what it covers' })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateFmeaBody, body));
  }

  @Versioned('fmeas')
  @Get('fmeas/linked')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The FMEAs in force that cover a part (or its family), a part family, a machine or a control plan, for banners: `{ data, canRaise }`' })
  linked(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(LinkedFmeaQuery, query);
    return this.linkedService.linked(ctx, q.kind, q.id);
  }

  @Get('fmeas/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'An FMEA with its revisions' })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Versioned('fmeas')
  @Patch('fmeas/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateFmeaBody) })
  @ApiOkResponse({ description: 'Changes the title, scope, customer, owner or review interval (never the kind or number)' })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateFmeaBody, body));
  }

  @Post('fmeas/:id/revisions')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(StartRevisionBody), required: false })
  @ApiCreatedResponse({ description: 'Starts a new draft revision from the one in force (team, scope and analysis copied); `adopt: true` also takes in the finished actions' })
  startRevision(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.startRevision(ctx, parse(Uuid, id), parse(StartRevisionBody, body ?? {}).adopt === true);
  }

  @Post('fmeas/:id/reviews')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReviewBody) })
  @ApiCreatedResponse({ description: 'Records the periodic review of an FMEA in force: no change needed (with a note), or a revision started' })
  review(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.review(ctx, parse(Uuid, id), parse(ReviewBody, body));
  }

  @Post('fmeas/:id/withdraw')
  @HttpCode(200)
  @OrganisationScoped(APPROVE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Withdraws an FMEA in force, with a reason' })
  withdraw(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.withdraw(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Versioned('fmea_revisions')
  @Get('fmea-revisions/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'A revision with its team, scope and what it still needs' })
  getRevision(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.getRevision(ctx, parse(Uuid, id));
  }

  @Versioned('fmea_revisions')
  @Patch('fmea-revisions/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateRevisionBody) })
  @ApiOkResponse({ description: 'Changes the wording of a draft revision (what changed and why)' })
  updateRevision(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateRevision(ctx, parse(Uuid, id), parse(UpdateRevisionBody, body));
  }

  @Put('fmea-revisions/:id/team')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(TeamBody) })
  @ApiOkResponse({ description: 'Replaces the team of a draft revision' })
  setTeam(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setTeam(ctx, parse(Uuid, id), parse(TeamBody, body).team);
  }

  @Put('fmea-revisions/:id/links')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(LinksBody) })
  @ApiOkResponse({ description: 'Replaces what a draft revision covers' })
  setLinks(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setLinks(ctx, parse(Uuid, id), parse(LinksBody, body).links);
  }

  @Put('fmea-revisions/:id/approver')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ApproverBody) })
  @ApiOkResponse({ description: 'Names who will approve the draft: a member who holds the approve permission and is not the preparer' })
  setApprover(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setApprover(ctx, parse(Uuid, id), parse(ApproverBody, body).approverId);
  }

  @Post('fmea-revisions/:id/submit')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Draft to waiting for approval: the "still needed" list must be empty; gives the revision its letter the first time' })
  submit(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.submit(ctx, parse(Uuid, id));
  }

  @Post('fmea-revisions/:id/approve')
  @HttpCode(200)
  @OrganisationScoped(READ)
  @ApiBody({ schema: openApiSchema(ApproveBody) })
  @ApiOkResponse({ description: 'The named approver (never the preparer) approves from a date; the database checks the approve permission' })
  approve(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.approve(ctx, parse(Uuid, id), parse(ApproveBody, body));
  }

  @Post('fmea-revisions/:id/send-back')
  @HttpCode(200)
  @OrganisationScoped(READ)
  @ApiBody({ schema: openApiSchema(CommentBody) })
  @ApiOkResponse({ description: 'The named approver sends the revision back to draft with a comment' })
  sendBack(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.sendBack(ctx, parse(Uuid, id), parse(CommentBody, body).comment);
  }

  @Post('fmea-revisions/:id/recall')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Takes a revision waiting for approval back to draft, with a reason' })
  recall(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.recall(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('fmea-revisions/:id/discard')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Discards a draft revision with a reason (the only draft of a never-used FMEA discards the FMEA)' })
  discard(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.discard(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }
}
