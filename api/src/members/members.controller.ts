import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { AddDepartmentBody, AssignRoleBody, BulkInviteBody, BulkInviteResponse, Invitation, InviteBody, InviteResponse, Member, Permission, Role, UpdateDepartmentMembershipBody, UpdateMemberBody } from './members.schemas';
import { MembersService } from './members.service';

@ApiTags('members')
@ApiBearerAuth()
@Controller()
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get('members')
  @OrganisationScoped('members.read')
  @ApiOkResponse({ description: 'Members and pending invitations', schema: openApiSchema(z.object({ data: z.array(Member) })) })
  async list(@Ctx() ctx: RequestContext) {
    return { data: await this.members.list(ctx) };
  }

  @Post('members/invitations')
  @HttpCode(201)
  @OrganisationScoped('members.manage')
  @ApiBody({ schema: openApiSchema(InviteBody) })
  @ApiCreatedResponse({
    description: 'Invitation created. `email.sent` says whether an email went out (reason: not_configured, existing_account, send_failed).',
    schema: openApiSchema(InviteResponse),
  })
  invite(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.members.invite(ctx, parse(InviteBody, body));
  }

  @Post('members/invitations/bulk')
  @HttpCode(200)
  @OrganisationScoped('members.manage')
  @ApiBody({ schema: openApiSchema(BulkInviteBody) })
  @ApiOkResponse({
    description: 'Up to 50 invitations, each independent. One result per row (in order): invited with the email outcome, or the reason it was not.',
    schema: openApiSchema(BulkInviteResponse),
  })
  inviteMany(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.members.inviteMany(ctx, parse(BulkInviteBody, body));
  }

  @Post('members/:id/invitation/resend')
  @HttpCode(200)
  @OrganisationScoped('members.manage')
  @ApiOkResponse({ description: 'Sends a pending invitation again (not within a minute, at most 10 times) and extends it to 14 days from now. 409 invitation_rule otherwise.', schema: openApiSchema(InviteResponse) })
  resend(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.members.resendInvitation(ctx, parse(Uuid, id));
  }

  @Post('members/:id/invitation/revoke')
  @HttpCode(200)
  @OrganisationScoped('members.manage')
  @ApiOkResponse({ description: 'Withdraws a pending invitation and frees the seat reserved for it.', schema: openApiSchema(Member) })
  revoke(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.members.revokeInvitation(ctx, parse(Uuid, id));
  }

  @Patch('members/:id')
  @OrganisationScoped('members.manage')
  @ApiBody({ schema: openApiSchema(UpdateMemberBody) })
  @ApiOkResponse({ description: 'Suspend, reactivate, remove a member or revoke an invitation', schema: openApiSchema(Member) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.members.updateStatus(ctx, parse(Uuid, id), parse(UpdateMemberBody, body));
  }

  @Post('members/:id/role-assignments')
  @HttpCode(201)
  @OrganisationScoped('members.manage')
  @ApiBody({ schema: openApiSchema(AssignRoleBody) })
  @ApiCreatedResponse({ description: 'Role granted (optionally scoped to a site/department)', schema: openApiSchema(Member) })
  assign(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.members.assignRole(ctx, parse(Uuid, id), parse(AssignRoleBody, body));
  }

  @Delete('role-assignments/:id')
  @HttpCode(204)
  @OrganisationScoped('members.manage')
  @ApiNoContentResponse({ description: 'Role removed. 409 last_owner if it would leave no active Owner.' })
  async unassign(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.members.removeAssignment(ctx, parse(Uuid, id));
  }

  @Post('members/:id/departments')
  @HttpCode(201)
  @OrganisationScoped('members.manage')
  @ApiBody({ schema: openApiSchema(AddDepartmentBody) })
  @ApiCreatedResponse({ description: 'The person joins the department (the first one is primary)', schema: openApiSchema(Member) })
  addDepartment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.members.addDepartment(ctx, parse(Uuid, id), parse(AddDepartmentBody, body));
  }

  @Patch('department-memberships/:id')
  @OrganisationScoped('members.manage')
  @ApiBody({ schema: openApiSchema(UpdateDepartmentMembershipBody) })
  @ApiOkResponse({ description: 'Makes this the person’s primary department', schema: openApiSchema(Member) })
  setPrimary(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.members.setPrimaryDepartment(ctx, parse(Uuid, id), parse(UpdateDepartmentMembershipBody, body));
  }

  @Delete('department-memberships/:id')
  @OrganisationScoped('members.manage')
  @ApiOkResponse({ description: 'Takes the person out of the department (kept as history). 409 department_rule while they still hold a role in it.', schema: openApiSchema(Member) })
  endDepartment(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.members.endDepartmentMembership(ctx, parse(Uuid, id));
  }

  @Get('roles')
  @OrganisationScoped('members.read')
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(Role) })) })
  async roles(@Ctx() ctx: RequestContext) {
    return { data: await this.members.roles(ctx) };
  }

  @Get('permissions')
  @OrganisationScoped('members.read')
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(Permission) })) })
  async permissions(@Ctx() ctx: RequestContext) {
    return { data: await this.members.permissions(ctx) };
  }

  @Get('invitations')
  @ApiOkResponse({ description: 'Pending invitations addressed to the signed-in user', schema: openApiSchema(z.object({ data: z.array(Invitation) })) })
  async myInvitations(@Ctx() ctx: RequestContext) {
    return { data: await this.members.myInvitations(ctx) };
  }

  @Post('invitations/:id/accept')
  @HttpCode(200)
  @ApiOkResponse({ schema: openApiSchema(z.object({ organisationId: z.string().uuid() })) })
  accept(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.members.accept(ctx, parse(Uuid, id));
  }
}
