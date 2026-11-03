import { Body, Controller, Get, Headers, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { CreateOrganisationBody, IdempotencyKey, OrganisationResponse, UpdateOrganisationBody } from './organisations.schemas';
import { OrganisationsService } from './organisations.service';

@ApiTags('organisations')
@ApiBearerAuth()
@Controller('organisations')
export class OrganisationsController {
  constructor(private readonly organisations: OrganisationsService) {}

  @Post()
  @HttpCode(201)
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Repeat-safe creation: the same key returns the same organisation' })
  @ApiBody({ schema: openApiSchema(CreateOrganisationBody) })
  @ApiCreatedResponse({ description: 'Organisation created; the caller is its Owner', schema: openApiSchema(OrganisationResponse) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    return this.organisations.create(ctx, parse(CreateOrganisationBody, body), key === undefined ? undefined : parse(IdempotencyKey, key));
  }

  @Get('current')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'The organisation named by X-Organisation-Id', schema: openApiSchema(OrganisationResponse) })
  current(@Ctx() ctx: RequestContext) {
    return this.organisations.get(ctx, ctx.organisationId!);
  }

  @Patch('current')
  @OrganisationScoped('organisation.manage')
  @ApiBody({ schema: openApiSchema(UpdateOrganisationBody) })
  @ApiOkResponse({ description: 'Updated organisation', schema: openApiSchema(OrganisationResponse) })
  update(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.organisations.update(ctx, ctx.organisationId!, parse(UpdateOrganisationBody, body));
  }
}
