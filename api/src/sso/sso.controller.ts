import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { SsoService } from './sso.service';

const DomainBody = z.object({ domain: z.string().trim().min(1).max(253) }).strict();
const RemoveBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

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

  @Post('domains/:id/remove')
  @OrganisationScoped('security.manage')
  @ApiBody({ schema: openApiSchema(RemoveBody) })
  @ApiOkResponse({ description: 'Remove a domain with a reason (kept in the history; it is no longer verified)' })
  removeDomain(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.removeDomain(ctx, parse(Uuid, id), parse(RemoveBody, body).reason);
  }
}
