import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { CreateSavedFilterBody, SAVED_FILTER_SCOPES, SavedFilter, SavedFilterList, SavedFiltersQuery, UpdateSavedFilterBody } from './saved-filters.schemas';
import { SavedFiltersService } from './saved-filters.service';

/** The signed-in member's own saved filters for a register; every member may use them, and nobody can see another person's. */
@ApiTags('saved-filters')
@ApiBearerAuth()
@Controller('saved-filters')
export class SavedFiltersController {
  constructor(private readonly filters: SavedFiltersService) {}

  @Get()
  @OrganisationScoped()
  @ApiQuery({ name: 'scope', description: `The register: ${SAVED_FILTER_SCOPES.join(', ')}` })
  @ApiOkResponse({ description: 'The caller\'s saved filters for the register, in order, with the limit', schema: openApiSchema(SavedFilterList) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.filters.list(ctx, parse(SavedFiltersQuery, query).scope);
  }

  @Post()
  @OrganisationScoped()
  @ApiBody({ schema: openApiSchema(CreateSavedFilterBody) })
  @ApiCreatedResponse({ description: 'Saves the filters under a name. 409 saved_filter_rule at five, 409 conflict for a name already used.', schema: openApiSchema(SavedFilter) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.filters.create(ctx, parse(CreateSavedFilterBody, body));
  }

  @Patch(':id')
  @OrganisationScoped()
  @ApiBody({ schema: openApiSchema(UpdateSavedFilterBody) })
  @ApiOkResponse({ description: 'Renames a saved filter and/or replaces its filters', schema: openApiSchema(SavedFilter) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.filters.update(ctx, parse(Uuid, id), parse(UpdateSavedFilterBody, body));
  }

  @Delete(':id')
  @HttpCode(204)
  @OrganisationScoped()
  @ApiNoContentResponse({ description: 'Deletes a saved filter' })
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.filters.remove(ctx, parse(Uuid, id));
  }
}
