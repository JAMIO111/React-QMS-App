import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { AcknowledgeBody, ScarActionCompleteBody, CommentBody, OwnPartyInviteBody, ReasonBody, ScarAcknowledgeBody, ScarExtensionBody, ScarExtensionWithdrawBody, ScarFileBody, ScarRespondBody, ScarUploadBody, ShareFileBody } from './portal.schemas';
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

  @Post('shares/:id/acknowledge')
  @PortalScoped()
  @ApiBody({ schema: openApiSchema(AcknowledgeBody) })
  @ApiOkResponse({ description: 'Acknowledge a shared document (the revision in force) or quality alert, with an optional note; once per person per revision' })
  acknowledgeShare(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.acknowledgeShare(ctx, Uuid.parse(id), parse(AcknowledgeBody, body).note ?? null);
  }

  @Post('shares/:id/file-url')
  @HttpCode(200)
  @PortalScoped()
  @ApiBody({ schema: openApiSchema(ShareFileBody) })
  @ApiOkResponse({ description: 'A short-lived link (ten minutes) to a file of a shared document’s revision in force' })
  shareFileUrl(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.documentFileLink(ctx, Uuid.parse(id), parse(ShareFileBody, body).fileId);
  }

  @Get('scars')
  @PortalScoped()
  @ApiOkResponse({ description: 'The corrective action requests (SCARs) issued to the person’s supplier, those awaiting a response first' })
  scars(@Ctx() ctx: RequestContext) {
    return this.service.listScars(ctx);
  }

  @Get('scars/:id')
  @PortalScoped()
  @ApiOkResponse({ description: 'One SCAR as the supplier sees it (named fields only: the request, what is affected, their responses with our review, requests for more time) and what they may do next' })
  scar(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.getScar(ctx, Uuid.parse(id));
  }

  @Post('scars/:id/acknowledge')
  @PortalScoped()
  @ApiBody({ schema: openApiSchema(ScarAcknowledgeBody) })
  @ApiOkResponse({ description: 'Confirm the SCAR has been received; answers with the SCAR' })
  acknowledgeScar(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.acknowledgeScar(ctx, Uuid.parse(id), parse(ScarAcknowledgeBody, body).note ?? null);
  }

  @Post('scars/:id/respond')
  @PortalScoped()
  @ApiBody({ schema: openApiSchema(ScarRespondBody) })
  @ApiOkResponse({ description: 'Send a response (root cause and corrective action are needed); it waits for review and never closes the SCAR; answers with the SCAR' })
  respondScar(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.respondScar(ctx, Uuid.parse(id), parse(ScarRespondBody, body));
  }

  @Post('scars/:id/extensions')
  @PortalScoped()
  @ApiBody({ schema: openApiSchema(ScarExtensionBody) })
  @ApiOkResponse({ description: 'Ask for more time; the date moves only when someone at the organisation agrees; answers with the SCAR' })
  requestExtension(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.requestScarExtension(ctx, Uuid.parse(id), parse(ScarExtensionBody, body));
  }

  @Post('scar-actions/:id/complete')
  @PortalScoped()
  @ApiBody({ schema: openApiSchema(ScarActionCompleteBody) })
  @ApiOkResponse({ description: 'Complete an action the organisation asked for, with a note of what was done; answers with the SCAR' })
  completeScarAction(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.completeScarAction(ctx, Uuid.parse(id), parse(ScarActionCompleteBody, body).note);
  }

  @Post('scar-extensions/:id/withdraw')
  @PortalScoped()
  @ApiBody({ schema: openApiSchema(ScarExtensionWithdrawBody) })
  @ApiOkResponse({ description: 'Take back your own request for more time while it waits; answers with the SCAR' })
  withdrawScarExtension(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.withdrawScarExtension(ctx, Uuid.parse(id), parse(ScarExtensionWithdrawBody, body).reason);
  }

  @Post('scars/:id/files/upload-url')
  @HttpCode(200)
  @PortalScoped()
  @ApiBody({ schema: openApiSchema(ScarUploadBody) })
  @ApiOkResponse({ description: 'A token to upload one evidence file to the SCAR’s folder (only while a response is awaited, at most ten unsent files); 403 file_not_allowed otherwise' })
  scarUploadUrl(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.scarUploadLink(ctx, Uuid.parse(id), parse(ScarUploadBody, body).fileName);
  }

  @Post('scars/:id/files')
  @PortalScoped()
  @ApiBody({ schema: openApiSchema(ScarFileBody) })
  @ApiOkResponse({ description: 'Record an uploaded file; it waits, unsent, until a response is sent; answers with the SCAR' })
  addScarFile(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addScarFile(ctx, Uuid.parse(id), parse(ScarFileBody, body));
  }

  @Post('scar-files/:id/remove')
  @PortalScoped()
  @ApiOkResponse({ description: 'Take back a file that has not been sent with a response yet; answers with the SCAR' })
  removeScarFile(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.removeScarFile(ctx, Uuid.parse(id));
  }

  @Post('scar-files/:id/download-url')
  @HttpCode(200)
  @PortalScoped()
  @ApiOkResponse({ description: 'A short-lived link (ten minutes) to a file of a SCAR the person may see' })
  scarFileUrl(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.scarFileLink(ctx, Uuid.parse(id));
  }
}
