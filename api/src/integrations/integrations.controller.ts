import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { AllowedHosts, AllowedHostsBody, Sample, SampleBody, ConnectionDetail, ConnectionList, CreateConnectionBody, CredentialBody, EmptyBody, ProviderList, ReasonBody, UpdateConnectionBody } from './integrations.schemas';
import { IntegrationsService } from './integrations.service';

const READ = 'integrations.read';
const MANAGE = 'integrations.manage';
const APPROVE = 'integrations.approve';

/**
 * Integrations (IN1): provider catalogue, connections and their lifecycle (draft → ready → active ⇄ paused → retired; a different person approves activation),
 * and the credential of a connection (stored in Vault, never returned). Every rule is enforced by the database.
 */
@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly service: IntegrationsService) {}

  @Get('providers')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The connector providers: what each can do and whether it is available yet', schema: openApiSchema(ProviderList) })
  providers(@Ctx() ctx: RequestContext) {
    return this.service.providers(ctx);
  }

  @Get('allowed-hosts')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The host names the organisation\'s connections may call (an entry allows the host and its sub-domains; empty: any public host)', schema: openApiSchema(AllowedHosts) })
  allowedHosts(@Ctx() ctx: RequestContext) {
    return this.service.allowedHosts(ctx);
  }

  @Put('allowed-hosts')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(AllowedHostsBody) })
  @ApiOkResponse({ description: 'Replaces the list. Connections that call a host no longer allowed go back to draft or are paused.', schema: openApiSchema(AllowedHosts) })
  setAllowedHosts(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.setAllowedHosts(ctx, parse(AllowedHostsBody, body));
  }

  @Get('connections')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The organisation\'s connections (retired ones last). No credential values, ever.', schema: openApiSchema(ConnectionList) })
  list(@Ctx() ctx: RequestContext) {
    return this.service.list(ctx);
  }

  @Post('connections')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateConnectionBody) })
  @ApiCreatedResponse({ description: 'A draft connection. The configuration holds no secrets; the database checks it per provider.', schema: openApiSchema(ConnectionDetail) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateConnectionBody, body));
  }

  @Get('connections/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'One connection with its history, whether a credential is stored (never its value) and what still stops it being made ready', schema: openApiSchema(ConnectionDetail) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Patch('connections/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateConnectionBody) })
  @ApiOkResponse({ description: 'Renames it or changes its configuration. Not while active (pause first); a ready connection goes back to draft.', schema: openApiSchema(ConnectionDetail) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateConnectionBody, body));
  }

  @Put('connections/:id/credential')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CredentialBody) })
  @ApiOkResponse({ description: 'Stores the credential in Vault, replacing (and deleting) the previous one. The value is never returned.', schema: openApiSchema(ConnectionDetail) })
  setCredential(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setCredential(ctx, parse(Uuid, id), parse(CredentialBody, body));
  }

  @Post('connections/:id/credential/revoke')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Revokes the credential and deletes its secret; an active connection that needs it is paused.', schema: openApiSchema(ConnectionDetail) })
  revokeCredential(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.revokeCredential(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }

  @Post('connections/:id/sample')
  @HttpCode(200)
  @OrganisationScoped('integrations.run')
  @ApiBody({ schema: openApiSchema(SampleBody) })
  @ApiOkResponse({ description: 'The first page of one kind of record from an API connection, as columns and up to 20 rows. Nothing is stored.', schema: openApiSchema(Sample) })
  sample(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.sample(ctx, parse(Uuid, id), parse(SampleBody, body).entityType);
  }

  @Post('connections/:id/test')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(EmptyBody) })
  @ApiOkResponse({ description: 'Runs the provider\'s connection test and records the result. 409 when the provider cannot be tested yet.', schema: openApiSchema(ConnectionDetail) })
  test(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    parse(EmptyBody, body ?? {});
    return this.service.test(ctx, parse(Uuid, id));
  }

  @Post('connections/:id/ready')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(EmptyBody) })
  @ApiOkResponse({ description: 'Marks a draft ready, if nothing still stops it (the reasons are listed).', schema: openApiSchema(ConnectionDetail) })
  ready(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    parse(EmptyBody, body ?? {});
    return this.service.markReady(ctx, parse(Uuid, id));
  }

  @Post('connections/:id/activate')
  @HttpCode(200)
  @OrganisationScoped(APPROVE)
  @ApiBody({ schema: openApiSchema(EmptyBody) })
  @ApiOkResponse({ description: 'Approves activation. Needs integrations.approve and a different person from the one who marked it ready.', schema: openApiSchema(ConnectionDetail) })
  activate(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    parse(EmptyBody, body ?? {});
    return this.service.activate(ctx, parse(Uuid, id));
  }

  @Post('connections/:id/pause')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ schema: openApiSchema(ConnectionDetail) })
  pause(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.pause(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }

  @Post('connections/:id/resume')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(EmptyBody) })
  @ApiOkResponse({ schema: openApiSchema(ConnectionDetail) })
  resume(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    parse(EmptyBody, body ?? {});
    return this.service.resume(ctx, parse(Uuid, id));
  }

  @Post('connections/:id/retire')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Retires the connection for good: its credential is revoked and its secret deleted.', schema: openApiSchema(ConnectionDetail) })
  retire(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.retire(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }
}
