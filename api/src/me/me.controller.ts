import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { MeResponse, UpdateMeBody } from './me.schemas';
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
}
