import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { CommentBody, OwnPartyInviteBody, ReasonBody } from './portal.schemas';
import { PortalScoped } from './portal.guard';
import { PortalService } from './portal.service';

/**
 * The supplier and customer portal (docs/external-portal-plan.md). Not organisation-scoped like staff routes: the first three belong to the signed-in
 * person themselves, and the rest use PortalGuard (live access to the organisation in X-Organisation-Id), never the staff OrganisationGuard.
 */
@ApiTags('portal')
@ApiBearerAuth()
@Controller('portal')
export class PortalController {
  constructor(private readonly service: PortalService) {}

  @Get('me')
  @ApiOkResponse({ description: 'Where the signed-in person has portal access: organisation, supplier or customer, role, and whether two-factor is still needed' })
  me(@Ctx() ctx: RequestContext) {
    return this.service.me(ctx);
  }

  @Get('invitations')
  @ApiOkResponse({ description: 'Portal invitations waiting for the signed-in person (matched by their confirmed email address)' })
  invitations(@Ctx() ctx: RequestContext) {
    return this.service.invitations(ctx);
  }

  @Post('invitations/:id/accept')
  @ApiOkResponse({ description: 'Accept a portal invitation (it expires after seven days); answers with where the person now has access' })
  accept(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.accept(ctx, Uuid.parse(id));
  }

  @Get('home')
  @PortalScoped()
  @ApiOkResponse({ description: 'The portal home for the supplier or customer: who they act for and what needs their attention' })
  home(@Ctx() ctx: RequestContext) {
    return this.service.home(ctx);
  }

  @Get('people')
  @PortalScoped({ admin: true })
  @ApiOkResponse({ description: 'The party admin’s own colleagues with status and last sign-in' })
  people(@Ctx() ctx: RequestContext) {
    return this.service.people(ctx);
  }

  @Post('people')
  @PortalScoped({ admin: true })
  @ApiBody({ schema: openApiSchema(OwnPartyInviteBody) })
  @ApiOkResponse({ description: 'Invite a colleague (as a member) to act for the same supplier or customer; sends the email' })
  invite(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.invite(ctx, parse(OwnPartyInviteBody, body));
  }

  @Post('people/:id/resend')
  @PortalScoped({ admin: true })
  @ApiOkResponse({ description: 'Send a colleague’s pending invitation again' })
  resend(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.resend(ctx, Uuid.parse(id));
  }

  @Post('people/:id/remove')
  @PortalScoped({ admin: true })
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Remove a colleague’s access or invitation, with a reason' })
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.remove(ctx, Uuid.parse(id), parse(ReasonBody, body).reason);
  }

  @Get('shares')
  @PortalScoped()
  @ApiOkResponse({ description: 'Everything shared with the person’s supplier or customer, newest conversation first, with what is new since they last looked' })
  shares(@Ctx() ctx: RequestContext) {
    return this.service.listShares(ctx);
  }

  @Get('shares/:id')
  @PortalScoped()
  @ApiOkResponse({ description: 'One shared record as the party sees it (a non-conformance or an 8D: named fields only), its conversation, and records that the person has seen it' })
  share(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.getShare(ctx, Uuid.parse(id));
  }

  @Post('shares/:id/comments')
  @PortalScoped()
  @ApiBody({ schema: openApiSchema(CommentBody) })
  @ApiOkResponse({ description: 'Write on a shared record (1 to 4,000 characters); answers with the conversation' })
  comment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.comment(ctx, Uuid.parse(id), parse(CommentBody, body).body);
  }

  @Post('comments/:id/withdraw')
  @PortalScoped()
  @ApiOkResponse({ description: 'Withdraw your own comment within ten minutes of writing it' })
  withdrawComment(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.withdrawComment(ctx, Uuid.parse(id));
  }
}
