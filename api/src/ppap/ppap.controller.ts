import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { Versioned } from '../common/versioned';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  AddFileBody, AddLinkBody, AskCustomerBody, CandidatesQuery, CreatePpapBody, CustomerRulesBody, DecisionBody, DraftQuery, LevelBody, PartStateQuery, PpapListQuery, PromptsQuery, PswBody, ReasonBody, ResubmitBody, ReviewBody,
  SaveRequirementsBody, SignPswBody, SubmitBody, UpdateElementBody, UpdatePpapBody, WaiveBody,
} from './ppap.schemas';
import { PpapPromptsService } from './ppap-prompts.service';
import { PpapService } from './ppap.service';

const READ = 'ppap.read';
const MANAGE = 'ppap.manage';
const APPROVE = 'ppap.approve';

/** PPAP (PP1): production part approval submissions (PPAP-YY-NNNN) with their 18 elements and file evidence, and the organisation's requirements. */
@ApiTags('ppap')
@ApiBearerAuth()
@Controller()
export class PpapController {
  constructor(private readonly service: PpapService, private readonly prompts: PpapPromptsService) {}

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

  @Get('ppap-draft')
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'What a part revision, a change or a control plan revision suggests for a PPAP raised from it: part, revision, customer(s), reason, notes. Nothing is saved.' })
  draft(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(DraftQuery, query);
    return this.prompts.draft(ctx, q.kind, q.id);
  }

  @Get('part-ppap-state')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Where a part revision stands for each of its customers, and what is worth saying about it (banners): `{ available, part, revision, customers, attention, lastProducedOn, canRaise }`; `available: false` without `ppap.read`. Information only.' })
  partState(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(PartStateQuery, query);
    return this.prompts.partState(ctx, q.partId, q.partRevisionId);
  }

  @Get('ppap-prompts')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The PPAPs raised from a change or a control plan revision, and the new ones it may call for: `{ available, applies, reference, prompts, raised, canRaise }`. Information only.' })
  promptsFor(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(PromptsQuery, query);
    return this.prompts.sourcePrompts(ctx, q.kind, q.id);
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
  @ApiOkResponse({ description: 'Withdraws a submission with a reason. Before sending that is a manager\'s act; once sent it needs approval rights and is recorded as a decision' })
  withdraw(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.withdraw(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Get('ppaps/:id/psw')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The Part Submission Warrant as a form: the typed fields beside the part, revision, customer, site, reason and level, the signer, and whether it is frozen (sent)' })
  pswForm(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.pswForm(ctx, parse(Uuid, id));
  }

  @Put('ppaps/:id/psw')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(PswBody) })
  @ApiOkResponse({ description: 'Saves the typed fields of the warrant (weight, purchase order, engineering change level, whether the results meet the requirements, a declaration) while the submission is being prepared and the warrant is not signed' })
  savePsw(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.savePsw(ctx, parse(Uuid, id), parse(PswBody, body));
  }

  @Post('ppaps/:id/psw/sign')
  @HttpCode(200)
  @OrganisationScoped(APPROVE)
  @ApiBody({ schema: openApiSchema(SignPswBody) })
  @ApiOkResponse({ description: 'An approver signs the warrant with their title and phone. Never the owner, the person who created the submission or whoever last saved the warrant (409 ppap_rule)' })
  signPsw(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.signPsw(ctx, parse(Uuid, id), parse(SignPswBody, body));
  }

  @Post('ppaps/:id/psw/unsign')
  @HttpCode(200)
  @OrganisationScoped(APPROVE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'An approver takes the signature off while the submission is still being prepared, with a reason' })
  unsignPsw(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.unsignPsw(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('ppaps/:id/submit')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(SubmitBody) })
  @ApiOkResponse({ description: 'Sends a ready submission: every link and the warrant are frozen, the status moves to submitted and the sending is recorded as a decision. Refused (409 ppap_rule) if anything is still needed' })
  submit(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.submit(ctx, parse(Uuid, id), parse(SubmitBody, body ?? {}));
  }

  @Post('ppaps/:id/decisions')
  @HttpCode(200)
  @OrganisationScoped(APPROVE)
  @ApiBody({ schema: openApiSchema(DecisionBody) })
  @ApiOkResponse({ description: 'An approver records the customer\'s decision (approved, interim approved with an expiry and conditions, rejected with the reason), with their reference and optionally their signed warrant as a file in the submission\'s folder' })
  decide(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.decide(ctx, parse(Uuid, id), parse(DecisionBody, body));
  }

  @Post('ppaps/:id/resubmission')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ResubmitBody) })
  @ApiCreatedResponse({ description: 'Starts a new submission that names this one (rejected, withdrawn after sending, or approved and due for revalidation). Links and notes are carried over unfrozen; files, waivers and the signature are not. Answers with the new submission' })
  resubmit(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.resubmit(ctx, parse(Uuid, id), parse(ResubmitBody, body ?? {}));
  }

  @Post('ppaps/:id/reviews')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReviewBody) })
  @ApiOkResponse({ description: 'Records that an approved submission was reviewed and nothing changed, and when it is next due' })
  review(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.review(ctx, parse(Uuid, id), parse(ReviewBody, body));
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

  @Get('ppaps/:id/customer-requests')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The requests put to the customer to answer this submission in the portal (who asked, what they answered), and the customer it can be put to' })
  customerRequests(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.customerRequests(ctx, parse(Uuid, id));
  }

  @Post('ppaps/:id/customer-requests')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(AskCustomerBody) })
  @ApiOkResponse({ description: 'Asks the customer the submission was sent to to answer it in the portal (their people are emailed). Their answer is recorded as the submission\'s decision' })
  askCustomer(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.askCustomer(ctx, parse(Uuid, id), parse(AskCustomerBody, body).note ?? null);
  }

  @Post('ppaps/:id/supplier-requests')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(AskCustomerBody) })
  @ApiOkResponse({ description: 'Asks the supplier a received package is from to prepare and submit it in their portal (their people are emailed)' })
  askSupplier(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.askSupplier(ctx, parse(Uuid, id), parse(AskCustomerBody, body).note ?? null);
  }

  @Post('ppap-customer-requests/:id/withdraw')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Withdraws a request that is still waiting for the customer (a reason is needed)' })
  withdrawCustomerRequest(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.withdrawCustomerRequest(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }
}
