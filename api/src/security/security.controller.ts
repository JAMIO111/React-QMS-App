import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { SecurityService } from './security.service';

const PolicyBody = z.object({ mode: z.enum(['off', 'monitor', 'enforce']), confirm: z.boolean().optional() }).strict();
const NetworkBody = z.object({ name: z.string().max(200), network: z.string().max(100), active: z.boolean().optional() }).strict();
const NetworkPatch = z
  .object({ name: z.string().max(200).optional(), network: z.string().max(100).optional(), active: z.boolean().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
const RemoveBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const DomainsBody = z.object({ domains: z.array(z.string().trim().min(1).max(253)).max(20) }).strict();
const SessionAgeBody = z.object({ hours: z.number().int().min(1).max(720).nullable() }).strict();
const DenialsQuery = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  userId: z.string().uuid().optional(),
  mode: z.enum(['monitor', 'enforce']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** Settings → Security → Access restrictions (docs/security-plan.md SE2). Owners and admins (security.read / security.manage). */
@ApiTags('security')
@ApiBearerAuth()
@Controller('security')
export class SecurityController {
  constructor(private readonly service: SecurityService) {}

  @Get('access-policy')
  @OrganisationScoped('security.read')
  @ApiOkResponse({ description: 'The network policy (off, monitor, enforce), the approved networks, and the caller’s own address as the API sees it with whether a network includes it' })
  policy(@Ctx() ctx: RequestContext) {
    return this.service.policy(ctx);
  }

  @Put('access-policy')
  @OrganisationScoped('security.manage')
  @ApiBody({ schema: openApiSchema(PolicyBody) })
  @ApiOkResponse({ description: 'Change the mode. Enforcing needs confirm: true, an active network, and the caller’s own address inside one (409 security_rule otherwise)' })
  setPolicy(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(PolicyBody, body);
    return this.service.setPolicy(ctx, b.mode, b.confirm ?? false);
  }

  @Post('networks')
  @OrganisationScoped('security.manage')
  @ApiBody({ schema: openApiSchema(NetworkBody) })
  @ApiOkResponse({ description: 'Approve a network: a name and an IPv4 or IPv6 address or range (normalised; private, special and very wide ranges are refused). Answers with the policy' })
  addNetwork(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.saveNetwork(ctx, parse(NetworkBody, body));
  }

  @Patch('networks/:id')
  @OrganisationScoped('security.manage')
  @ApiBody({ schema: openApiSchema(NetworkPatch) })
  @ApiOkResponse({ description: 'Rename, change or switch a network on or off. While enforced, a change that would block the caller’s own address is refused' })
  updateNetwork(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.saveNetwork(ctx, parse(NetworkPatch, body), parse(Uuid, id));
  }

  @Post('networks/:id/remove')
  @OrganisationScoped('security.manage')
  @ApiBody({ schema: openApiSchema(RemoveBody) })
  @ApiOkResponse({ description: 'Remove a network with a reason (kept in the history). While enforced, it must not block the caller’s own address' })
  removeNetwork(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.removeNetwork(ctx, parse(Uuid, id), parse(RemoveBody, body).reason);
  }

  @Post('networks/:id/restore')
  @OrganisationScoped('security.manage')
  @ApiOkResponse({ description: 'Bring a removed network back, switched off' })
  restoreNetwork(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.restoreNetwork(ctx, parse(Uuid, id));
  }

  @Put('email-domains')
  @OrganisationScoped('security.manage')
  @ApiBody({ schema: openApiSchema(DomainsBody) })
  @ApiOkResponse({ description: 'Invitations only to these email domains and their sub-domains (empty = anyone). Members already outside are listed, not removed. Answers with the policy' })
  setEmailDomains(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.setEmailDomains(ctx, parse(DomainsBody, body).domains);
  }

  @Put('session-age')
  @OrganisationScoped('security.manage')
  @ApiBody({ schema: openApiSchema(SessionAgeBody) })
  @ApiOkResponse({ description: 'Sign in again after this many hours (1 to 720), or null for no limit. Requests from an older sign-in answer 401 reauthentication_required' })
  setSessionAge(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.setSessionAge(ctx, parse(SessionAgeBody, body).hours);
  }

  @Get('access-denials')
  @OrganisationScoped('security.read')
  @ApiOkResponse({ description: 'Requests blocked (enforce) or that would have been blocked (monitor), one row per person, address and hour, newest first' })
  denials(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.denials(ctx, parse(DenialsQuery, query));
  }
}
