import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { CatalogueResponse, IntegrationFileDetail, IntegrationFileList, MappingList, MappingQuery, RegisterFileBody, SaveMappingBody } from './integration-files.schemas';
import { IntegrationFilesService } from './integration-files.service';

const READ = 'integrations.read';
const RUN = 'integrations.run';
const MANAGE = 'integrations.manage';

/** File imports (upload, read, keep the rows), the canonical field catalogue, and versioned mappings (IN3). */
@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations')
export class IntegrationFilesController {
  constructor(private readonly service: IntegrationFilesService) {}

  @Get('entities')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The kinds of record a source can be mapped to, and their Fortress fields', schema: openApiSchema(CatalogueResponse) })
  entities() {
    return this.service.catalogue();
  }

  @Get('connections/:id/files')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Files uploaded to a file connection, newest first', schema: openApiSchema(IntegrationFileList) })
  files(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.list(ctx, parse(Uuid, id));
  }

  @Post('connections/:id/files')
  @HttpCode(201)
  @OrganisationScoped(RUN)
  @ApiBody({ schema: openApiSchema(RegisterFileBody) })
  @ApiCreatedResponse({ description: 'Records an uploaded file, reads it and keeps its rows (or keeps it as failed with the reason). 503 when file storage is not set up.', schema: openApiSchema(IntegrationFileDetail) })
  register(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.register(ctx, parse(Uuid, id), parse(RegisterFileBody, body));
  }

  @Get('files/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'One uploaded file with its columns and first rows', schema: openApiSchema(IntegrationFileDetail) })
  file(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Get('connections/:id/mappings')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Every mapping version of a connection, newest first per kind of record', schema: openApiSchema(MappingList) })
  mappings(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return this.service.mappings(ctx, parse(Uuid, id), parse(MappingQuery, query).entityType);
  }

  @Put('connections/:id/mapping')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(SaveMappingBody) })
  @ApiOkResponse({ description: 'Saves a new mapping version (a change needs a reason; an unchanged mapping is refused). 409 lists what is wrong with it.', schema: openApiSchema(MappingList) })
  saveMapping(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.saveMapping(ctx, parse(Uuid, id), parse(SaveMappingBody, body));
  }
}
