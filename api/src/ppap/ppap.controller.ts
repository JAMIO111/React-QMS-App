import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { Versioned } from '../common/versioned';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { AddFileBody, AddLinkBody, CandidatesQuery, CreatePpapBody, CustomerRulesBody, LevelBody, PpapListQuery, ReasonBody, SaveRequirementsBody, UpdateElementBody, UpdatePpapBody, WaiveBody } from './ppap.schemas';
import { PpapService } from './ppap.service';

const READ = 'ppap.read';
const MANAGE = 'ppap.manage';
const APPROVE = 'ppap.approve';

/** PPAP (PP1): production part approval submissions (PPAP-YY-NNNN) with their 18 elements and file evidence, and the organisation's requirements. */
@ApiTags('ppap')
@ApiBearerAuth()
@Controller()
export class PpapController {
  constructor(private readonly service: PpapService) {}

  @Get('ppaps')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'A page of PPAP submissions: `{ data, page, pageSize, total }`; by default the ones not withdrawn or rejected' })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(PpapListQuery, query));
  }

  @Post('ppaps')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreatePpapBody) })
  @ApiCreatedResponse({ description: 'Starts a submission with its 18 elements, set from the level and the customer\'s rules. A retry with the same `clientKey` returns the same submission (`created: false`)' })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreatePpapBody, body));
  }

  @Get('ppap-requirements')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The organisation\'s requirement set (which elements each level needs, and the study minimums): the current version and every version' })
  requirements(@Ctx() ctx: RequestContext) {
    return this.service.requirements(ctx);
  }

  @Put('ppap-requirements')
  @OrganisationScoped(APPROVE)
  @ApiBody({ schema: openApiSchema(SaveRequirementsBody) })
  @ApiOkResponse({ description: 'Saves a new version of the requirements, with a reason (an unchanged set is refused)' })
  saveRequirements(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.saveRequirements(ctx, parse(SaveRequirementsBody, body));
  }

  @Get('ppap-customer-rules')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Each customer\'s own PPAP rules: `{ data, canChange }`' })
  customerRules(@Ctx() ctx: RequestContext) {
    return this.service.customerRules(ctx);
  }

  @Put('ppap-customer-rules/:id')
  @OrganisationScoped(APPROVE)
  @ApiBody({ schema: openApiSchema(CustomerRulesBody) })
  @ApiOkResponse({ description: 'Replaces a customer\'s rules (default level, extra elements, own minimums)' })
  setCustomerRules(@Ctx() ctx: RequestContext, @Param('id') customerId: string, @Body() body: unknown) {
    return this.service.setCustomerRules(ctx, parse(Uuid, customerId), parse(CustomerRulesBody, body));
  }

  @Versioned('ppap_submissions')
  @Get('ppaps/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'A submission with its elements, their evidence, what is still needed and what the caller may do' })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Versioned('ppap_submissions')
  @Patch('ppaps/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdatePpapBody) })
  @ApiOkResponse({ description: 'Changes the site, reason, notes or owner while the submission is being prepared' })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdatePpapBody, body));
  }

  @Put('ppaps/:id/level')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(LevelBody) })
  @ApiOkResponse({ description: 'Changes the level and applies the requirement rules again to the elements nobody has touched' })
  setLevel(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setLevel(ctx, parse(Uuid, id), parse(LevelBody, body).level);
  }

  @Post('ppaps/:id/ready')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Marks the submission ready once nothing is still needed (409 ppap_rule otherwise, saying what)' })
  ready(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.markReady(ctx, parse(Uuid, id));
  }

  @Post('ppaps/:id/reopen')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Takes a ready submission back to preparation' })
  reopen(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.reopen(ctx, parse(Uuid, id));
  }

  @Post('ppaps/:id/withdraw')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Withdraws a submission that has not been sent, with a reason' })
  withdraw(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.withdraw(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Patch('ppap-elements/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateElementBody) })
  @ApiOkResponse({ description: 'Changes an element\'s requirement, status or note; answers with the whole submission' })
  updateElement(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateElement(ctx, parse(Uuid, id), parse(UpdateElementBody, body));
  }

  @Post('ppap-elements/:id/files')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(AddFileBody) })
  @ApiCreatedResponse({ description: 'Records a file already uploaded to the submission\'s folder in the ppap-files bucket as evidence for the element' })
  addFile(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addFile(ctx, parse(Uuid, id), parse(AddFileBody, body));
  }

  @Post('ppap-elements/:id/links')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(AddLinkBody) })
  @ApiCreatedResponse({
    description:
      'Links a record Fortress already holds (a part revision, a control plan revision, an FMEA revision, a change, an inspection, a gauge R&R study, a material certificate, a calibration, a document, a gauge, a plan characteristic) as evidence for the element. The record must be in this organisation, readable by the caller, of a kind that is evidence for this element, and (where it belongs to one part) for the submission\'s part. Answers with the whole submission.',
  })
  addLink(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addLink(ctx, parse(Uuid, id), parse(AddLinkBody, body));
  }

  @Get('ppap-candidates')
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Records of one kind that can be linked to an element, read as the caller, scoped to the submission\'s part unless `q` searches; each with its own state: `{ kind, data: [{ id, label, status, ok, problem, linked }] }`' })
  candidates(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.candidates(ctx, parse(CandidatesQuery, query));
  }

  @Post('ppap-elements/:id/waive')
  @HttpCode(200)
  @OrganisationScoped(APPROVE)
  @ApiBody({ schema: openApiSchema(WaiveBody) })
  @ApiOkResponse({ description: 'An approver waives a required element, with a reason of substance' })
  waive(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.waive(ctx, parse(Uuid, id), parse(WaiveBody, body).reason);
  }

  @Post('ppap-elements/:id/unwaive')
  @HttpCode(200)
  @OrganisationScoped(APPROVE)
  @ApiOkResponse({ description: 'Takes a waiver off' })
  unwaive(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.unwaive(ctx, parse(Uuid, id));
  }

  @Post('ppap-evidence/:id/remove')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Removes evidence with a reason (it is kept, marked removed)' })
  removeEvidence(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.removeEvidence(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }
}
