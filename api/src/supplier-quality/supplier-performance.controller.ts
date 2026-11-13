import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { InspectionRecommendation, Performance, Schedule, ScheduleBody, PerformanceQuery, RecommendationQuery, SaveModelBody, SaveScorecardBody, Scorecard, ScorecardModel, ScorecardSummary, SupplierSettings, SupplierSettingsBody, Watchlist, WatchlistQuery } from './supplier-performance.schemas';
import { SupplierPerformanceService } from './supplier-performance.service';

const READ = 'supplier_quality.read';
const MANAGE = 'supplier_quality.manage';
const CONFIGURE = 'supplier_quality.configure';

/**
 * Supplier performance (SQ5): live figures (PPM, lot rejection, on-time delivery, non-conformances, SCAR responsiveness, certification validity), the score and band, saved scorecards that
 * never change, the scoring model (versioned) and the watchlist. The database works everything out; reading needs supplier_quality.read and receiving.read.
 */
@ApiTags('supplier-quality')
@ApiBearerAuth()
@Controller('supplier-quality')
export class SupplierPerformanceController {
  constructor(private readonly service: SupplierPerformanceService) {}

  @Get('performance/model')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The current scorecard model and its versions', schema: openApiSchema(ScorecardModel) })
  model(@Ctx() ctx: RequestContext) {
    return this.service.model(ctx);
  }

  @Put('performance/model')
  @OrganisationScoped(CONFIGURE)
  @ApiBody({ schema: openApiSchema(SaveModelBody) })
  @ApiOkResponse({ description: 'Saves a new version with a reason; saved scorecards keep the version they used', schema: openApiSchema(ScorecardModel) })
  saveModel(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.saveModel(ctx, parse(SaveModelBody, body));
  }

  @Get('performance/schedule')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Scheduled scorecards: monthly, quarterly and annual (each on or off), which suppliers, the next periods, whose authority it uses and any problem', schema: openApiSchema(Schedule) })
  schedule(@Ctx() ctx: RequestContext) {
    return this.service.schedule(ctx);
  }

  @Put('performance/schedule')
  @OrganisationScoped(CONFIGURE)
  @ApiBody({ schema: openApiSchema(ScheduleBody) })
  @ApiOkResponse({ description: 'Switches monthly, quarterly and annual scorecards on or off separately and sets which suppliers they cover; keys left out keep their value. The schedule then uses your authority.', schema: openApiSchema(Schedule) })
  saveSchedule(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.saveSchedule(ctx, parse(ScheduleBody, body));
  }

  @Get('performance/watchlist')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Active suppliers with a poor or watch band, or a warning, over the last N days (default 90), worst first; each warning names the records behind it', schema: openApiSchema(Watchlist) })
  watchlist(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.watchlist(ctx, parse(WatchlistQuery, query));
  }

  @Get('suppliers/:id/performance')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The supplier\'s live figures, score, band and warnings for a period (default: the last 90 days)', schema: openApiSchema(Performance) })
  performance(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return this.service.performance(ctx, parse(Uuid, id), parse(PerformanceQuery, query));
  }

  @Get('suppliers/:id/performance/settings')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The supplier\'s own scoring settings (empty = follows the organisation\'s model) and what it is scored with now', schema: openApiSchema(SupplierSettings) })
  settings(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.supplierSettings(ctx, parse(Uuid, id));
  }

  @Put('suppliers/:id/performance/settings')
  @OrganisationScoped(CONFIGURE)
  @ApiBody({ schema: openApiSchema(SupplierSettingsBody) })
  @ApiOkResponse({ description: 'Sets this supplier\'s date policy, grace days and in-full tolerances; a key set to null clears it. Saved scorecards keep the configuration they used.', schema: openApiSchema(SupplierSettings) })
  saveSettings(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.saveSupplierSettings(ctx, parse(Uuid, id), parse(SupplierSettingsBody, body));
  }

  @Get('suppliers/:id/inspection-recommendation')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'INFORMATION ONLY: the level of incoming inspection the rules would suggest from risk, approval status and performance over the last N days (default 90), beside the current supplier-wide requirement, with the reasons. Nothing is changed.', schema: openApiSchema(InspectionRecommendation) })
  recommendation(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return this.service.recommendation(ctx, parse(Uuid, id), parse(RecommendationQuery, query));
  }

  @Get('suppliers/:id/scorecards')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Saved scorecards, newest first', schema: openApiSchema(z.object({ data: z.array(ScorecardSummary) })) })
  scorecards(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.scorecards(ctx, parse(Uuid, id));
  }

  @Post('suppliers/:id/scorecards')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(SaveScorecardBody) })
  @ApiCreatedResponse({ description: 'Freezes a scorecard for the period under the current model. The period ends today or earlier and is at most a year.', schema: openApiSchema(Scorecard) })
  save(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.save(ctx, parse(Uuid, id), parse(SaveScorecardBody, body));
  }

  @Get('scorecards/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'One saved scorecard with every figure and the records behind each warning', schema: openApiSchema(Scorecard) })
  scorecard(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.scorecard(ctx, parse(Uuid, id));
  }
}
