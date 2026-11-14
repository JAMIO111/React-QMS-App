import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  ApplyBody,
  CreateImportBody,
  DiscardBody,
  FeatureMapBody,
  FeatureMapList,
  ImportDetail,
  ImportList,
  MatchBody,
  Profile,
  ProfileBody,
  ProfileList,
  ProfileListQuery,
  ProfilePatchBody,
  RetireBody,
  TemplateList,
  TryBody,
  TryResult,
} from './measurement-imports.schemas';
import { MeasurementImportsService } from './measurement-imports.service';

const MANAGE = 'process_control.manage';
const SITE_SCOPED = { anyScope: true };

/** How measurement report files are read (CMM ingestion, docs/cmm-ingestion-plan.md). Every member reads them; process_control.manage changes them. */
@ApiTags('measurement-imports')
@ApiBearerAuth()
@Controller('measurement-profiles')
export class MeasurementProfilesController {
  constructor(private readonly service: MeasurementImportsService) {}

  @Get()
  @OrganisationScoped()
  @ApiQuery({ name: 'all', required: false, schema: { type: 'string', enum: ['true', 'false'] }, description: 'true includes retired profiles' })
  @ApiOkResponse({ schema: openApiSchema(ProfileList) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.listProfiles(ctx, parse(ProfileListQuery, query).all === 'true');
  }

  /** Ready-made starting points (CALYPSO table file, PC-DMIS CSV, a simple table with limits). */
  @Get('templates')
  @OrganisationScoped()
  @ApiOkResponse({ schema: openApiSchema(TemplateList) })
  templates() {
    return this.service.templates();
  }

  /** Read a file with settings and show what was found; nothing is saved. */
  @Post('try')
  @HttpCode(200)
  @OrganisationScoped()
  @ApiBody({ schema: openApiSchema(TryBody) })
  @ApiOkResponse({ schema: openApiSchema(TryResult) })
  try(@Body() body: unknown) {
    return this.service.tryFile(parse(TryBody, body));
  }

  @Get(':id')
  @OrganisationScoped()
  @ApiOkResponse({ schema: openApiSchema(Profile) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.getProfile(ctx, parse(Uuid, id));
  }

  @Post()
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ProfileBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Profile) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createProfile(ctx, parse(ProfileBody, body));
  }

  /** Rename, describe, change the default gauge, or change how files are read (a new version, with a reason). */
  @Patch(':id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ProfilePatchBody) })
  @ApiOkResponse({ schema: openApiSchema(Profile) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateProfile(ctx, parse(Uuid, id), parse(ProfilePatchBody, body));
  }

  @Post(':id/retire')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(RetireBody) })
  @ApiOkResponse({ schema: openApiSchema(Profile) })
  retire(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.retireProfile(ctx, parse(Uuid, id), parse(RetireBody, body).reason);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ schema: openApiSchema(Profile) })
  reactivate(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.reactivateProfile(ctx, parse(Uuid, id));
  }
}

/** A part's remembered feature matches (CMM feature name → characteristic). */
@ApiTags('measurement-imports')
@ApiBearerAuth()
@Controller()
export class FeatureMapsController {
  constructor(private readonly service: MeasurementImportsService) {}

  @Get('parts/:id/feature-maps')
  @OrganisationScoped()
  @ApiOkResponse({ schema: openApiSchema(FeatureMapList) })
  list(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.listFeatureMaps(ctx, parse(Uuid, id));
  }

  /** Remember a match (anyone who records inspections or manages control plans; the database decides). */
  @Post('parts/:id/feature-maps')
  @HttpCode(200)
  @OrganisationScoped()
  @ApiBody({ schema: openApiSchema(FeatureMapBody) })
  @ApiOkResponse({ schema: openApiSchema(FeatureMapList) })
  save(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.saveFeatureMap(ctx, parse(Uuid, id), parse(FeatureMapBody, body));
  }

  @Post('measurement-feature-maps/:id/end')
  @HttpCode(200)
  @OrganisationScoped()
  @ApiOkResponse({ schema: openApiSchema(FeatureMapList) })
  end(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.endFeatureMap(ctx, parse(Uuid, id));
  }
}

/** Measurement report files on an inspection: upload → preview → (CM3) apply. */
@ApiTags('measurement-imports')
@ApiBearerAuth()
@Controller()
export class InspectionImportsController {
  constructor(private readonly service: MeasurementImportsService) {}

  /** Read an uploaded file with a profile, match its features and keep it as a preview; nothing is recorded yet. */
  @Post('inspections/:id/imports')
  @HttpCode(201)
  @OrganisationScoped('inspection.record', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(CreateImportBody) })
  @ApiCreatedResponse({ schema: openApiSchema(ImportDetail) })
  create(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createImport(ctx, parse(Uuid, id), parse(CreateImportBody, body));
  }

  @Get('inspections/:id/imports')
  @OrganisationScoped('inspection.read', SITE_SCOPED)
  @ApiOkResponse({ schema: openApiSchema(ImportList) })
  list(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.listImports(ctx, parse(Uuid, id));
  }

  @Get('inspection-imports/:id')
  @OrganisationScoped('inspection.read', SITE_SCOPED)
  @ApiOkResponse({ schema: openApiSchema(ImportDetail) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.getImport(ctx, parse(Uuid, id));
  }

  /** The person has checked the features whose nominal or limits differ from the control plan. */
  @Post('inspection-imports/:id/confirm-mismatches')
  @HttpCode(200)
  @OrganisationScoped('inspection.record', SITE_SCOPED)
  @ApiOkResponse({ schema: openApiSchema(ImportDetail) })
  confirm(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.confirmMismatches(ctx, parse(Uuid, id));
  }

  @Post('inspection-imports/:id/discard')
  @HttpCode(200)
  @OrganisationScoped('inspection.record', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(DiscardBody) })
  @ApiOkResponse({ schema: openApiSchema(ImportDetail) })
  discard(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.discard(ctx, parse(Uuid, id), parse(DiscardBody, body ?? {}));
  }

  /** Record the preview's readings (new, a retest of the failed ones, or a correction with a reason); all or nothing. */
  @Post('inspection-imports/:id/apply')
  @HttpCode(200)
  @OrganisationScoped('inspection.record', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(ApplyBody) })
  @ApiOkResponse({ schema: openApiSchema(ImportDetail) })
  apply(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.apply(ctx, parse(Uuid, id), parse(ApplyBody, body ?? {}));
  }

  /** Match a feature to a check (or to nothing); `remember` also saves it for later files of the part. */
  @Put('inspection-import-rows/:id/match')
  @OrganisationScoped('inspection.record', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(MatchBody) })
  @ApiOkResponse({ schema: openApiSchema(ImportDetail) })
  match(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setMatch(ctx, parse(Uuid, id), parse(MatchBody, body));
  }
}
