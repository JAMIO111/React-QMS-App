import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  ArchiveTemplateBody,
  CreateTemplateBody,
  DuplicateTemplateBody,
  RestoreTemplateVersionBody,
  SaveTemplateVersionBody,
  TemplateDetail,
  TemplateList,
  TemplateListQuery,
  TemplateVersion,
  TemplateVersionList,
  UpdateTemplateBody,
} from './integration-templates.schemas';
import { IntegrationTemplatesService } from './integration-templates.service';

const READ = 'integrations.read';
const MANAGE = 'integrations.manage';
const VersionNumber = z.coerce.number().int().min(1).max(100000);

/** Organisation-wide import templates with frozen versions (UI2a). Writes need `integrations.manage`, which needs a Controller seat. */
@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations/templates')
export class IntegrationTemplatesController {
  constructor(private readonly service: IntegrationTemplatesService) {}

  @Get()
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Import templates, by kind of record and name (archived ones only when asked for)', schema: openApiSchema(TemplateList) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(TemplateListQuery, query));
  }

  @Post()
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateTemplateBody) })
  @ApiCreatedResponse({ description: 'A new template with its first version. 409 lists what is wrong with the mapping.', schema: openApiSchema(TemplateDetail) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateTemplateBody, body));
  }

  @Get(':id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'One template with its current version', schema: openApiSchema(TemplateDetail) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Patch(':id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateTemplateBody) })
  @ApiOkResponse({ description: 'Renames or re-describes a template (its content changes only through a new version)', schema: openApiSchema(TemplateDetail) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateTemplateBody, body));
  }

  @Get(':id/versions')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Every version of a template, newest first, with its reason and how many imports used it', schema: openApiSchema(TemplateVersionList) })
  versions(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.versions(ctx, parse(Uuid, id));
  }

  @Post(':id/versions')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(SaveTemplateVersionBody) })
  @ApiCreatedResponse({ description: 'Saves a new version (a reason is needed; an unchanged one is refused)', schema: openApiSchema(TemplateDetail) })
  saveVersion(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.saveVersion(ctx, parse(Uuid, id), parse(SaveTemplateVersionBody, body));
  }

  @Get(':id/versions/:version')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'One version of a template as it was saved', schema: openApiSchema(TemplateVersion) })
  version(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('version') version: string) {
    return this.service.version(ctx, parse(Uuid, id), parse(VersionNumber, version));
  }

  @Post(':id/duplicate')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(DuplicateTemplateBody) })
  @ApiCreatedResponse({ description: 'A new template from the current version ("Copy of …" unless named)', schema: openApiSchema(TemplateDetail) })
  duplicate(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.duplicate(ctx, parse(Uuid, id), parse(DuplicateTemplateBody, body ?? {}).name);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ArchiveTemplateBody) })
  @ApiOkResponse({ description: 'Hides a template from pickers (kept for the imports that used it)', schema: openApiSchema(TemplateDetail) })
  archive(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.archive(ctx, parse(Uuid, id), parse(ArchiveTemplateBody, body).reason);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Brings back an archived template', schema: openApiSchema(TemplateDetail) })
  restore(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.restore(ctx, parse(Uuid, id));
  }

  @Post(':id/restore-version')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(RestoreTemplateVersionBody) })
  @ApiOkResponse({ description: 'Saves an earlier version\'s content as a new version, with a reason', schema: openApiSchema(TemplateDetail) })
  restoreVersion(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(RestoreTemplateVersionBody, body);
    return this.service.restoreVersion(ctx, parse(Uuid, id), b.version, b.reason);
  }
}
