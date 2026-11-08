import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { SUBJECT_TYPES, Traceability, TraceQuery, TraceSearchQuery, TraceSearchResult } from './traceability.schemas';
import { TraceabilityService } from './traceability.service';

/** Where a production order, lot or serial number was made, measured, found wrong and dealt with. Read-only. */
@ApiTags('production')
@ApiBearerAuth()
@Controller('traceability')
export class TraceabilityController {
  constructor(private readonly service: TraceabilityService) {}

  /** Find orders, lots and serial numbers by (part of) their number. Declared before the subject route. */
  @Get('search')
  @OrganisationScoped('production.read')
  @ApiQuery({ name: 'q', required: true, schema: { type: 'string' } })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(TraceSearchResult) })) })
  async search(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return { data: await this.service.search(ctx, parse(TraceSearchQuery, query).q) };
  }

  @Get()
  @OrganisationScoped('production.read')
  @ApiQuery({ name: 'type', required: true, schema: { type: 'string', enum: [...SUBJECT_TYPES] } })
  @ApiQuery({ name: 'id', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ schema: openApiSchema(Traceability) })
  trace(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.trace(ctx, parse(TraceQuery, query));
  }
}
