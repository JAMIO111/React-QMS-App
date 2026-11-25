import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { DEFAULT_DAYS } from './fmea-evidence';
import { FmeaEvidenceService } from './fmea-evidence.service';
import { OccurrenceEvidenceQuery } from './fmea.schemas';

/** FMEA (FM5b): what the non-conformance register says about the failure modes of an analysis. Information only. */
@ApiTags('fmea')
@ApiBearerAuth()
@Controller()
export class FmeaEvidenceController {
  constructor(private readonly service: FmeaEvidenceService) {}

  @Get('fmea-revisions/:id/occurrence-evidence')
  @OrganisationScoped('fmea.read')
  @ApiOkResponse({ description: 'Each failure mode beside the live non-conformances raised against the register failure mode it is tied to (last `days`, default 365), and the ones the FMEA did not foresee' })
  evidence(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    const { days } = parse(OccurrenceEvidenceQuery, query);
    return this.service.evidence(ctx, parse(Uuid, id), days ?? DEFAULT_DAYS);
  }
}
