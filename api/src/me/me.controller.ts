import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { AcceptTermsBody, MeResponse, MoveOwnAccountBody, SsoJoinBody, UpdateMeBody } from './me.schemas';
import { MeService } from './me.service';

@ApiTags('me')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing, invalid or expired token' })
@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get()
  @ApiOkResponse({ description: 'Signed-in user, organisations and effective permissions', schema: openApiSchema(MeResponse) })
  get(@Ctx() ctx: RequestContext) {
    return this.me.get(ctx);
  }

  @Patch()
  @ApiBody({ schema: openApiSchema(UpdateMeBody) })
  @ApiOkResponse({ description: 'Updated profile', schema: openApiSchema(MeResponse) })
  update(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.me.update(ctx, parse(UpdateMeBody, body));
  }

  @Post('terms')
  @ApiBody({ schema: openApiSchema(AcceptTermsBody) })
  @ApiOkResponse({ description: 'Record that the signed-in person accepted this version of Fortress’s terms', schema: openApiSchema(MeResponse) })
  acceptTerms(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.me.acceptTerms(ctx, parse(AcceptTermsBody, body).version);
  }

  @Post('sso-join')
  @ApiBody({ schema: openApiSchema(SsoJoinBody) })
  @ApiOkResponse({ description: 'Join an organisation that lets people at its verified domains join with their company account (only through its own sign-in; 409 sso_rule otherwise)', schema: openApiSchema(MeResponse) })
  ssoJoin(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.me.joinWithCompanyAccount(ctx, parse(SsoJoinBody, body).organisationId);
  }

  @Post('move-to-sso')
  @ApiBody({ schema: openApiSchema(MoveOwnAccountBody) })
  @ApiOkResponse({ description: 'Signed in with a company account: move your old password account (same address) onto it, proving it with its password. 409 sso_rule when the password is wrong or nothing can be moved; 503 password_check_unavailable', schema: openApiSchema(MeResponse) })
  moveToSso(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(MoveOwnAccountBody, body);
    return this.me.moveOwnAccount(ctx, b.organisationId, b.password);
  }
}
