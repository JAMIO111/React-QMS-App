import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { Performance, PerformanceQuery, SaveModelBody, SaveScorecardBody, Scorecard, ScorecardModel, ScorecardSummary, Watchlist, WatchlistQuery } from './supplier-performance.schemas';
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
