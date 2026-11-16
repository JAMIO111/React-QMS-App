import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { SsoService } from './sso.service';

const DomainBody = z.object({ domain: z.string().trim().min(1).max(253) }).strict();
const RemoveBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const ModeBody = z
  .object({ mode: z.enum(['off', 'optional', 'required']), confirm: z.boolean().optional() })
  .strict()
  .refine((b) => b.mode !== 'required' || b.confirm === true, { message: 'Requiring single sign-on must be confirmed (confirm: true)', path: ['confirm'] });
const TrustBody = z.object({ trust: z.boolean() }).strict();
const JoiningBody = z
  .object({ join: z.enum(['invited', 'domain']), roleId: z.string().uuid().nullable().optional(), departmentId: z.string().uuid().nullable().optional() })
  .strict();
const BreakGlassBody = z.object({ userIds: z.array(z.string().uuid()).max(3) }).strict();
const ProviderBody = z.union([
  z.object({ metadataUrl: z.string().trim().url().max(2000).refine((u) => u.startsWith('https://'), 'The metadata address must start with https://') }).strict(),
  z
    .object({ metadataXml: z.string().trim().min(50).max(262_144) })
    .strict()
    .refine((b) => /EntityDescriptor/.test(b.metadataXml), 'That is not SAML metadata: it has no EntityDescriptor'),
]);

/** Settings → Security → Single sign-on (docs/sso-plan.md SS1). Owners and admins (security.read / security.manage). */
@ApiTags('security')
@ApiBearerAuth()
@Controller('security/sso')
export class SsoController {
  constructor(private readonly service: SsoService) {}

  @Get()
  @OrganisationScoped('security.read')
  @ApiOkResponse({ description: 'Single sign-on: the mode (off until SS3), joining and two-factor settings, and the email domains with their DNS verification record and state' })
  overview(@Ctx() ctx: RequestContext) {
    return this.service.overview(ctx);
  }

  @Post('domains')
  @OrganisationScoped('security.manage')
  @ApiBody({ schema: openApiSchema(DomainBody) })
  @ApiOkResponse({ description: 'Claim an email domain for single sign-on. It is verified once its TXT record is found (POST …/verify). Answers with the overview' })
  addDomain(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.addDomain(ctx, parse(DomainBody, body).domain);
  }

  @Post('domains/:id/verify')
  @OrganisationScoped('security.manage')
  @ApiOkResponse({ description: 'Look the TXT record up now. Answers with the overview and check.outcome (verified, unverified, failed, refused)' })
  verifyDomain(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.verifyDomain(ctx, parse(Uuid, id));
  }

  @Put('provider')
  @OrganisationScoped('security.manage')
  @ApiBody({ schema: openApiSchema(ProviderBody) })
  @ApiOkResponse({ description: 'Connect the company’s SAML identity provider (its metadata address, or the metadata file), or replace the connected one’s metadata. Needs a verified domain. 503 sso_unavailable when this server cannot manage providers' })
  saveProvider(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.saveProvider(ctx, parse(ProviderBody, body));
  }

  @Post('provider/disable')
  @OrganisationScoped('security.manage')
  @ApiBody({ schema: openApiSchema(RemoveBody) })
  @ApiOkResponse({ description: 'Disconnect the identity provider (kept in the history with the reason); its domains are free again' })
  disableProvider(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.disableProvider(ctx, parse(RemoveBody, body).reason);
  }

  @Put('mode')
  @OrganisationScoped('security.manage')
  @ApiBody({ schema: openApiSchema(ModeBody) })
  @ApiOkResponse({
    description:
      'Off, optional (passwords still work) or required (company sign-in only; confirm: true). Optional and required need a connected provider with a domain; required needs this request to come through that provider. Answers with the overview',
  })
  setMode(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.setMode(ctx, parse(ModeBody, body).mode);
  }

  @Put('two-factor')
  @OrganisationScoped('security.manage')
  @ApiBody({ schema: openApiSchema(TrustBody) })
  @ApiOkResponse({ description: 'Whether a company sign-in meets the organisation’s two-factor rule (default on). Answers with the overview' })
  setTrust(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.setTrustIdpMfa(ctx, parse(TrustBody, body).trust);
  }

  @Put('joining')
  @OrganisationScoped('security.manage')
  @ApiBody({ schema: openApiSchema(JoiningBody) })
  @ApiOkResponse({ description: 'Who may join on their first company sign-in: invited only, or anyone at the verified domains with a default role (viewer or inspector) and optional department. Answers with the overview' })
  setJoining(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.setJoining(ctx, parse(JoiningBody, body));
  }

  @Put('break-glass')
  @OrganisationScoped('security.manage')
  @ApiBody({ schema: openApiSchema(BreakGlassBody) })
  @ApiOkResponse({ description: 'The break-glass members (up to three owners or admins who may sign in with a password and two-factor while single sign-on is required), replaced as a whole' })
  setBreakGlass(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.setBreakGlass(ctx, parse(BreakGlassBody, body).userIds);
  }

  @Post('domains/:id/remove')
  @OrganisationScoped('security.manage')
  @ApiBody({ schema: openApiSchema(RemoveBody) })
  @ApiOkResponse({ description: 'Remove a domain with a reason (kept in the history; it is no longer verified)' })
  removeDomain(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.removeDomain(ctx, parse(Uuid, id), parse(RemoveBody, body).reason);
  }
}
