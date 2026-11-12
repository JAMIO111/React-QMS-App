import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  AllQuery, AssessBody, CreateCategoryBody, CreateRiskBody, ReasonBody, RiskCategory, RiskListQuery, SaveModelBody, ScoreQuery, UpdateCategoryBody, UpdateRiskBody,
} from './risk.schemas';
import { RiskService } from './risk.service';

const READ = 'risk.read';
const MANAGE = 'risk.manage';
const APPROVE = 'risk.approve';

/** Risk register (RK1): the 5 x 5 scoring matrix (versions), categories, risks and opportunities, and their assessments before treatment. */
@ApiTags('risk')
@ApiBearerAuth()
@Controller()
export class RiskController {
  constructor(private readonly service: RiskService) {}

  // ---- the matrix ----------------------------------------------------------------------------------

  @Get('risk-model')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The current matrix (labels, the band of each cell, the acceptable level, review intervals) and its versions' })
  model(@Ctx() ctx: RequestContext) {
    return this.service.model(ctx);
  }

  @Put('risk-model')
  @OrganisationScoped(APPROVE)
  @ApiBody({ schema: openApiSchema(SaveModelBody) })
  @ApiOkResponse({ description: 'Saves a new version of the matrix with a reason. Existing assessments keep the version they were scored with.' })
  saveModel(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.saveModel(ctx, parse(SaveModelBody, body));
  }

  @Get('risk-score')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'likelihood', required: true, schema: { type: 'integer', minimum: 1, maximum: 5 } })
  @ApiQuery({ name: 'consequence', required: true, schema: { type: 'integer', minimum: 1, maximum: 5 } })
  @ApiOkResponse({ description: 'What a likelihood and a consequence come to on the current matrix: score, band, whether it is acceptable. Nothing is saved.' })
  score(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.score(ctx, parse(ScoreQuery, query));
  }

  // ---- categories ----------------------------------------------------------------------------------

  @Get('risk-categories')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'all', required: false, schema: { type: 'string', enum: ['true', 'false'] }, description: 'Include switched-off categories' })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(RiskCategory) })) })
  categories(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.categories(ctx, parse(AllQuery, query));
  }

  @Post('risk-categories')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateCategoryBody) })
  @ApiCreatedResponse({ schema: openApiSchema(RiskCategory) })
  createCategory(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createCategory(ctx, parse(CreateCategoryBody, body));
  }

  @Patch('risk-categories/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateCategoryBody) })
  @ApiOkResponse({ description: 'Renames, describes, reorders or switches a category off (nothing is deleted)', schema: openApiSchema(RiskCategory) })
  updateCategory(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateCategory(ctx, parse(Uuid, id), parse(UpdateCategoryBody, body));
  }

  // ---- risks ---------------------------------------------------------------------------------------

  @Get('risks')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The register, page-based (`q`, `kind`, `status` (default live = not retired), `band` incl. `unassessed`, `categoryId`, `owner=me`, `sort`, `order`, `page`, `pageSize`)' })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(RiskListQuery, query));
  }

  @Post('risks')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateRiskBody) })
  @ApiCreatedResponse({ description: 'Raises a risk or an opportunity as a draft (RSK-001 …); the first assessment opens it' })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateRiskBody, body));
  }

  @Get('risks/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'A risk with every assessment, newest first' })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Patch('risks/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateRiskBody) })
  @ApiOkResponse({ description: 'Changes the details (the kind only while it is a draft; nothing once closed or retired)' })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateRiskBody, body));
  }

  @Post('risks/:id/assessments')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(AssessBody) })
  @ApiOkResponse({ description: 'Assesses the risk before treatment. The database works out the score and band; the earlier assessment is kept as superseded.' })
  assess(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.assess(ctx, parse(Uuid, id), parse(AssessBody, body));
  }

  @Post('risks/:id/retire')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Retires the risk with a reason (never deleted)' })
  retire(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.retire(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('risks/:id/reactivate')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Brings a retired risk back (open when it has been assessed, else a draft)' })
  reactivate(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.reactivate(ctx, parse(Uuid, id));
  }
}
