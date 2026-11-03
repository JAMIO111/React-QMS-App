import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { AssignRoleBody, Invitation, InviteBody, InviteResponse, Member, Permission, Role, UpdateMemberBody } from './members.schemas';
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
