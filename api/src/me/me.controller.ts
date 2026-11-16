import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { AcceptTermsBody, MeResponse, UpdateMeBody } from './me.schemas';
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
}
