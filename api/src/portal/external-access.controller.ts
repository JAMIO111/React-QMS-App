import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { ExternalAccessService } from './external-access.service';
import { CommentBody, InviteBody, PartyBody, PeopleQuery, ReasonBody, SettingsBody, ShareBody, SharesQuery } from './portal.schemas';

/** Settings → External access (docs/external-portal-plan.md PT1): the staff side of the supplier and customer portal. */
@ApiTags('external-access')
@ApiBearerAuth()
@Controller('external-access')
export class ExternalAccessController {
  constructor(private readonly service: ExternalAccessService) {}

  @Get()
  @OrganisationScoped('external_access.read')
  @ApiOkResponse({ description: 'The portal switch and settings, and every supplier and customer with whether they are opted in and how many people they have' })
  overview(@Ctx() ctx: RequestContext) {
    return this.service.overview(ctx);
  }

  @Put('settings')
  @OrganisationScoped('external_access.manage')
  @ApiBody({ schema: openApiSchema(SettingsBody) })
  @ApiOkResponse({ description: 'Switch the portal on or off, choose two-factor for external people and the ranking band; answers with the overview' })
  settings(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.setSettings(ctx, parse(SettingsBody, body));
  }

  @Put('parties')
  @OrganisationScoped('external_access.manage')
  @ApiBody({ schema: openApiSchema(PartyBody) })
  @ApiOkResponse({ description: 'Opt a supplier or customer in or out, the contact name they see and their tiles; answers with the overview' })
  party(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.setParty(ctx, parse(PartyBody, body));
  }

  @Get('people')
  @OrganisationScoped('external_access.read')
  @ApiOkResponse({ description: 'Everyone invited or given access, with status and last sign-in (the access report); partyId narrows it to one supplier or customer' })
  people(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.people(ctx, parse(PeopleQuery, query).partyId);
  }

  @Post('people')
  @OrganisationScoped('external_access.manage')
  @ApiBody({ schema: openApiSchema(InviteBody) })
  @ApiOkResponse({ description: 'Invite someone to act for a supplier or customer (admin: the first contact; member: a colleague). Sends the email; answers with the person and whether it was sent' })
  invite(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.invite(ctx, parse(InviteBody, body));
  }

  @Post('people/:id/resend')
  @OrganisationScoped('external_access.manage')
  @ApiOkResponse({ description: 'Send a pending invitation again (not within a minute, at most ten times) and give it another seven days' })
  resend(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.resend(ctx, Uuid.parse(id));
  }

  @Post('people/:id/remove')
  @OrganisationScoped('external_access.manage')
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Remove an invitation or a person’s access, with a reason. What they wrote stays on the records under their name' })
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.remove(ctx, Uuid.parse(id), parse(ReasonBody, body).reason);
  }

  @Post('people/:id/suspend')
  @OrganisationScoped('external_access.manage')
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Suspend someone’s access, with a reason; it stops at once' })
  suspend(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.suspend(ctx, Uuid.parse(id), parse(ReasonBody, body).reason);
  }

  @Post('people/:id/restore')
  @OrganisationScoped('external_access.manage')
  @ApiOkResponse({ description: 'Bring suspended access back' })
  restore(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.restore(ctx, Uuid.parse(id));
  }

  // ---- Sharing records (PT2): the card on an NC or an 8D ----

  @Get('shares')
  @OrganisationScoped('external_access.share')
  @ApiOkResponse({ description: 'Who a record (kind ncr | capa | document | quality_alert, recordId) is shared with and how they have used it (viewed, replies), and which suppliers or customers it could still be shared with' })
  shares(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(SharesQuery, query);
    return this.service.shares(ctx, q.kind, q.recordId);
  }

  @Post('shares')
  @OrganisationScoped('external_access.share')
  @ApiBody({ schema: openApiSchema(ShareBody) })
  @ApiOkResponse({ description: 'Share an NC with the supplier or customer it names, or an 8D with the party of a linked NC. Emails the party’s people (best effort); answers with the record’s shares' })
  share(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.share(ctx, parse(ShareBody, body));
  }

  @Post('shares/:id/withdraw')
  @OrganisationScoped('external_access.share')
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Stop sharing, with a reason. The party stops seeing it at once; the conversation is kept for staff' })
  withdrawShare(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.withdrawShare(ctx, Uuid.parse(id), parse(ReasonBody, body).reason);
  }

  @Get('shares/:id/acknowledgements')
  @OrganisationScoped('external_access.share')
  @ApiOkResponse({ description: 'Who in the party acknowledged a shared document or quality alert, with their note and the revision they acknowledged' })
  acknowledgements(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.acknowledgements(ctx, Uuid.parse(id));
  }

  @Get('shares/:id/comments')
  @OrganisationScoped('external_access.share')
  @ApiOkResponse({ description: 'The conversation on a shared record, with real names for staff' })
  comments(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.comments(ctx, Uuid.parse(id));
  }

  @Post('shares/:id/comments')
  @OrganisationScoped('external_access.share')
  @ApiBody({ schema: openApiSchema(CommentBody) })
  @ApiOkResponse({ description: 'Write to the party on a shared record (the party sees it as coming from the organisation); emails their people. Answers with the conversation' })
  comment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.comment(ctx, Uuid.parse(id), parse(CommentBody, body).body);
  }

  @Post('comments/:id/withdraw')
  @OrganisationScoped('external_access.share')
  @ApiOkResponse({ description: 'Withdraw your own comment within ten minutes of writing it' })
  withdrawComment(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.withdrawComment(ctx, Uuid.parse(id));
  }
}
