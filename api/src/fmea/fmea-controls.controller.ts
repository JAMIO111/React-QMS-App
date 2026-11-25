import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { FmeaControlsService } from './fmea-controls.service';
import { CarryToPlanBody, PlanCharacteristicsQuery, ReasonBody } from './fmea.schemas';

const READ = 'fmea.read';
const MANAGE = 'fmea.manage';

/** FMEA (FM5a): controls carried to the control plan, the coverage report, and what FMEAs say about a plan's characteristics. Information only. */
@ApiTags('fmea')
@ApiBearerAuth()
@Controller()
export class FmeaControlsController {
  constructor(private readonly service: FmeaControlsService) {}

  @Post('fmea-causes/:id/carry-to-plan')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CarryToPlanBody) })
  @ApiCreatedResponse({ description: 'Carries the cause\'s prevention or detection control to a control plan characteristic (plan, operation, characteristic key). Answers with the whole revision' })
  carry(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.carry(ctx, parse(Uuid, id), parse(CarryToPlanBody, body));
  }

  @Post('fmea-control-links/:id/end')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Ends a carried control, with a reason; the link stays on record. Answers with the whole revision' })
  end(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.end(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Get('fmea-plan-characteristics')
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Control plan characteristics a control can be carried to (`q`, `planId`, `causeId` for the criticality suggestion): `{ available, data }`' })
  planCharacteristics(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.planCharacteristics(ctx, parse(PlanCharacteristicsQuery, query));
  }

  @Get('fmea-revisions/:id/control-coverage')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Which causes that need attention the control plan in force covers: rows (worst first) and totals' })
  coverage(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.coverage(ctx, parse(Uuid, id));
  }

  @Get('control-plan-revisions/:id/fmea-cover')
  @OrganisationScoped('process_control.read')
  @ApiOkResponse({ description: 'For each characteristic of a control plan revision, the FMEA causes (of FMEAs in force) that carry a control to it: `{ available, data }`' })
  planCover(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.planCover(ctx, parse(Uuid, id));
  }
}
