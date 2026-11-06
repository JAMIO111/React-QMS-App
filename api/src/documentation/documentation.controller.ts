import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { AlertDetail, AlertList, CreateAlertBody, ListQuery, ReasonBody, UpdateAlertBody } from './documentation.schemas';
import { DocumentationService } from './documentation.service';

const READ = 'documentation.read';
const MANAGE = 'documentation.manage';
const ISSUE = 'documentation.issue';

/** Quality alerts: controlled communications that need immediate attention (the first controlled document type). */
@ApiTags('documentation')
@ApiBearerAuth()
@Controller('quality-alerts')
export class QualityAlertsController {
  constructor(private readonly service: DocumentationService) {}

  @Get()
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'status', required: false, schema: { type: 'string', enum: ['draft', 'active', 'expired', 'withdrawn', 'superseded', 'all'] } })
  @ApiQuery({ name: 'category', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'severity', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string' } })
  @ApiOkResponse({ description: 'The newest revision of each alert (drafts only for people who manage documentation)', schema: openApiSchema(AlertList) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(ListQuery, query));
  }

  @Post()
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateAlertBody) })
  @ApiCreatedResponse({ description: 'A new draft with the next QA number', schema: openApiSchema(AlertDetail) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateAlertBody, body));
  }

  @Get(':id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(AlertDetail) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Patch(':id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateAlertBody) })
  @ApiOkResponse({ description: 'Edits a draft (content and, if given, its whole scope and targets). An issued alert needs a revision.', schema: openApiSchema(AlertDetail) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateAlertBody, body));
  }

  @Delete(':id')
  @HttpCode(204)
  @OrganisationScoped(MANAGE)
  @ApiNoContentResponse({ description: 'Discards a draft. An issued alert is withdrawn instead.' })
  async discard(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.service.discard(ctx, parse(Uuid, id));
  }

  @Post(':id/issue')
  @HttpCode(200)
  @OrganisationScoped(ISSUE)
  @ApiOkResponse({ description: 'Makes the draft active; the revision it replaces becomes superseded', schema: openApiSchema(AlertDetail) })
  issue(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.issue(ctx, parse(Uuid, id));
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @OrganisationScoped(ISSUE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ schema: openApiSchema(AlertDetail) })
  withdraw(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.withdraw(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }

  @Post(':id/revisions')
  @HttpCode(201)
  @OrganisationScoped(ISSUE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiCreatedResponse({ description: 'A draft revision copied from this alert, to edit and issue', schema: openApiSchema(AlertDetail) })
  revise(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.revise(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }
}
