import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { AcceptConflictBody, Conflict, ConflictListQuery, ConflictPage, RejectConflictBody } from './integration-conflicts.schemas';
import { IntegrationConflictsService } from './integration-conflicts.service';

/**
 * The review queue (IN5): values an import held back because their field is set to "Review" and they would change the record. Reading needs
 * `integrations.read`; deciding needs `integrations.run` and the permission to edit that kind of record (the database checks both).
 */
@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations/conflicts')
export class IntegrationConflictsController {
  constructor(private readonly service: IntegrationConflictsService) {}

  @Get()
  @OrganisationScoped('integrations.read')
  @ApiOkResponse({ description: 'Values waiting for review (default), decided or all; newest first', schema: openApiSchema(ConflictPage) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(ConflictListQuery, query));
  }

  @Post(':id/accept')
  @HttpCode(200)
  @OrganisationScoped('integrations.run')
  @ApiBody({ schema: openApiSchema(AcceptConflictBody) })
  @ApiOkResponse({ description: 'Writes the source\'s value to the record, as the caller, under the record\'s own rules', schema: openApiSchema(Conflict) })
  accept(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(AcceptConflictBody, body ?? {});
    return this.service.decide(ctx, parse(Uuid, id), true, b.note || null);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @OrganisationScoped('integrations.run')
  @ApiBody({ schema: openApiSchema(RejectConflictBody) })
  @ApiOkResponse({ description: 'Fortress keeps its own value; the same value is not asked about again', schema: openApiSchema(Conflict) })
  reject(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.decide(ctx, parse(Uuid, id), false, parse(RejectConflictBody, body).reason);
  }
}
