import { Body, Controller, Get, Header, HttpCode, Param, Patch, Post, Put, Query, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  ChangeRequestBody, ChangeRequestListQuery, InForceQuery, LinksBody, PeriodicReviewBody,
  AcknowledgeBody, AddRecipientBody, ReadersBody, SkillsBody, ApproveBody, CommentBody, CompareQuery, CreateDocumentBody, CreateTypeBody, DocumentFileBody, DocumentListQuery, DocumentType, ReasonBody, ReviewBody, SignersBody,
  TypeListQuery, UpdateDocumentBody, UpdateRevisionBody, UpdateTypeBody, IssueExternalBody,
} from './documents.schemas';
import { DocumentFileStore } from './controlled-copy';
import { DocumentsService } from './documents.service';

const READ = 'documentation.read';
const MANAGE = 'documentation.manage';

/**
 * Document control (DC1): document types, documents (`SOP-001`) and their draft revisions with a text body or files.
 * Reading needs only membership where the database decides (drafts are seen by their author, the owner and document managers).
 */
@ApiTags('documents')
@ApiBearerAuth()
@Controller()
export class DocumentsController {
  constructor(
    private readonly service: DocumentsService,
    private readonly store: DocumentFileStore,
  ) {}

  // ---- types ---------------------------------------------------------------------------------------

  @Get('document-types')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'all', required: false, schema: { type: 'string', enum: ['true', 'false'] }, description: 'Include switched-off types' })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(DocumentType) })) })
  types(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.types(ctx, parse(TypeListQuery, query));
  }

  @Post('document-types')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateTypeBody) })
  @ApiCreatedResponse({ schema: openApiSchema(DocumentType) })
  createType(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createType(ctx, parse(CreateTypeBody, body));
  }

  @Patch('document-types/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateTypeBody) })
  @ApiOkResponse({ description: 'Renames, changes or switches a type off. The prefix is fixed once a document uses it.', schema: openApiSchema(DocumentType) })
  updateType(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateType(ctx, parse(Uuid, id), parse(UpdateTypeBody, body));
  }

  // ---- documents -----------------------------------------------------------------------------------

  @Get('documents')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'Documents the caller may read, page-based (`q`, `type`, `status`, `kind`, `owner=me`, `sort`, `order`, `page`, `pageSize`)' })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(DocumentListQuery, query));
  }

  @Post('documents')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateDocumentBody) })
  @ApiCreatedResponse({ description: 'Creates a document (numbered from its type, or with a typed number and letter) and its first draft' })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateDocumentBody, body));
  }

  @Get('documents/:id')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'A document with its revisions' })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Patch('documents/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateDocumentBody) })
  @ApiOkResponse({ description: 'Changes the title, description or owner (the number, type and content kind never change)' })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateDocumentBody, body));
  }

  // ---- revisions -----------------------------------------------------------------------------------

  @Get('document-revisions/:id')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'A revision with its text body or files' })
  revision(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.getRevision(ctx, parse(Uuid, id));
  }

  @Patch('document-revisions/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateRevisionBody) })
  @ApiOkResponse({ description: 'Changes a draft: the change summary, or the text body of a text document' })
  updateRevision(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateRevision(ctx, parse(Uuid, id), parse(UpdateRevisionBody, body));
  }

  @Post('document-revisions/:id/discard')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Discards a draft (reason kept). Discarding the only draft of a document never in force discards the document.' })
  discard(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.discardRevision(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Get('document-revisions/:id/files')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'The main file and attachments of a revision, removed ones included' })
  files(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.files(ctx, parse(Uuid, id));
  }

  @Post('document-revisions/:id/files')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(DocumentFileBody) })
  @ApiCreatedResponse({ description: 'Records a file already uploaded to document-files (a new main file replaces the old one)' })
  addFile(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addFile(ctx, parse(Uuid, id), parse(DocumentFileBody, body));
  }

  @Post('document-files/:id/delete')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Marks a draft\'s file removed (never deleted)' })
  removeFile(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.removeFile(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('document-files/:id/restore')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Brings a removed file back' })
  restoreFile(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.restoreFile(ctx, parse(Uuid, id));
  }

  // ---- review, approval and effect (DC2) -------------------------------------------------------------

  // ---- external documents and controlled copies (DC5) ----------------------------------------------

  @Post('document-revisions/:id/issue-external')
  @HttpCode(200)
  @OrganisationScoped('documentation.issue')
  @ApiBody({ schema: openApiSchema(IssueExternalBody) })
  @ApiOkResponse({ description: "Records an external document's revision as issued: our letter, the issuer's revision and the effective date (no internal review)" })
  issueExternal(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.issueExternal(ctx, parse(Uuid, id), parse(IssueExternalBody, body));
  }

  @Get('document-files/:id/controlled-copy')
  @OrganisationScoped()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'The PDF stamped on every page: controlled copy (number, revision, effective date, who printed it and when) or not for use. Only PDFs.' })
  async controlledCopy(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const copy = await this.service.controlledCopy(ctx, parse(Uuid, id), this.store);
    return new StreamableFile(Buffer.from(copy.bytes), {
      type: 'application/pdf',
      disposition: `inline; filename="${copy.fileName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'")}"`,
    });
  }

  @Get('document-signers')
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Active members who may be named as reviewers or approver (`canApprove`: holds documentation.issue)' })
  signers(@Ctx() ctx: RequestContext) {
    return this.service.signerCandidates(ctx);
  }

  @Get('document-reviews/mine')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'Revisions waiting for the caller to review or approve' })
  waiting(@Ctx() ctx: RequestContext) {
    return this.service.waiting(ctx);
  }

  @Put('document-revisions/:id/signers')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(SignersBody) })
  @ApiOkResponse({ description: 'Names the reviewers (replaced as a whole) and the approver of a draft; none of them the author' })
  setSigners(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setSigners(ctx, parse(Uuid, id), parse(SignersBody, body));
  }

  @Post('document-revisions/:id/submit')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Sends a draft for review: gives it its letter (the first time) and starts a review round' })
  submit(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.submit(ctx, parse(Uuid, id));
  }

  @Post('document-revisions/:id/review')
  @HttpCode(200)
  @OrganisationScoped()
  @ApiBody({ schema: openApiSchema(ReviewBody) })
  @ApiOkResponse({ description: 'A named reviewer accepts, or sends it back with a comment (back to draft; every review starts again)' })
  review(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.review(ctx, parse(Uuid, id), parse(ReviewBody, body));
  }

  @Post('document-revisions/:id/approve')
  @HttpCode(200)
  @OrganisationScoped('documentation.issue')
  @ApiBody({ schema: openApiSchema(ApproveBody) })
  @ApiOkResponse({ description: 'The named approver approves with the date it takes effect (today or later); never the author' })
  approve(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.approve(ctx, parse(Uuid, id), parse(ApproveBody, body));
  }

  @Post('document-revisions/:id/send-back')
  @HttpCode(200)
  @OrganisationScoped()
  @ApiBody({ schema: openApiSchema(CommentBody) })
  @ApiOkResponse({ description: 'The named approver returns it to draft with a comment' })
  sendBack(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.sendBack(ctx, parse(Uuid, id), parse(CommentBody, body).comment);
  }

  @Get('document-revisions/:id/compare')
  @OrganisationScoped()
  @ApiQuery({ name: 'with', required: false, description: 'Another revision of the same document (default: the one it was started from)' })
  @ApiOkResponse({ description: 'Blocks of text added, removed and kept; files added, removed and kept' })
  compare(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return this.service.compare(ctx, parse(Uuid, id), parse(CompareQuery, query).with);
  }

  @Post('documents/:id/revisions')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiCreatedResponse({ description: 'Starts a new draft from the revision in force (text and files copied)' })
  startRevision(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.startRevision(ctx, parse(Uuid, id));
  }

  @Post('documents/:id/withdraw')
  @HttpCode(200)
  @OrganisationScoped('documentation.issue')
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Withdraws a document in force (reason kept); a draft in progress is left alone' })
  withdraw(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.withdraw(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  // ---- readers and acknowledgement (DC3) ------------------------------------------------------------

  @Get('my-documents')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'The caller\'s reading: revisions in force to acknowledge (overdue first), recent acknowledgements, and reviews waiting' })
  myDocuments(@Ctx() ctx: RequestContext) {
    return this.service.mine(ctx);
  }

  @Get('my-documents/count')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'For the menu badge: `{ toRead, overdue, reviews, total }`' })
  myDocumentsCount(@Ctx() ctx: RequestContext) {
    return this.service.mineCount(ctx);
  }

  @Put('documents/:id/readers')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReadersBody) })
  @ApiOkResponse({ description: 'Who must read the document (departments, roles, people), replaced as a whole; fixed on each revision when it takes effect' })
  setReaders(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setReaders(ctx, parse(Uuid, id), parse(ReadersBody, body));
  }

  @Put('documents/:id/skills')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(SkillsBody) })
  @ApiOkResponse({ description: 'The skills the document trains (acknowledging it shows as evidence on the competence record)' })
  setSkills(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setSkills(ctx, parse(Uuid, id), parse(SkillsBody, body).skillIds);
  }

  @Post('document-revisions/:id/acknowledge')
  @HttpCode(200)
  @OrganisationScoped()
  @ApiBody({ schema: openApiSchema(AcknowledgeBody) })
  @ApiOkResponse({ description: 'The caller acknowledges the revision in force they were asked to read (once)' })
  acknowledge(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.acknowledge(ctx, parse(Uuid, id), parse(AcknowledgeBody, body));
  }

  @Get('document-revisions/:id/recipients')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'Who was asked to read it: viewed, acknowledged, due, overdue (managers see everyone)' })
  recipients(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.recipients(ctx, parse(Uuid, id));
  }

  @Post('document-revisions/:id/recipients')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(AddRecipientBody) })
  @ApiCreatedResponse({ description: 'Asks one more person to read the revision in force' })
  addRecipient(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addRecipient(ctx, parse(Uuid, id), parse(AddRecipientBody, body).userId);
  }

  // ---- periodic review, change requests, links (DC4) ------------------------------------------------

  @Get('documents-in-force')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'Documents in force linked to a part (or its family), part family, machine or operation; information only' })
  inForce(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.inForce(ctx, parse(InForceQuery, query));
  }

  @Post('documents/:id/reviews')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(PeriodicReviewBody) })
  @ApiCreatedResponse({ description: 'Records a periodic review: no change needed (with what was checked), or a revision started' })
  recordReview(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.recordReview(ctx, parse(Uuid, id), parse(PeriodicReviewBody, body));
  }

  @Put('documents/:id/links')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(LinksBody) })
  @ApiOkResponse({ description: 'The parts, part families, machines and operations the document applies to, replaced as a whole' })
  setLinks(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setLinks(ctx, parse(Uuid, id), parse(LinksBody, body));
  }

  @Get('document-change-requests')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'Change requests: your own, or all of them for document managers (`status`, `documentId`, `mine=true`)' })
  changeRequests(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.changeRequests(ctx, parse(ChangeRequestListQuery, query));
  }

  @Post('documents/:id/change-requests')
  @HttpCode(201)
  @OrganisationScoped('documentation.read')
  @ApiBody({ schema: openApiSchema(ChangeRequestBody) })
  @ApiCreatedResponse({ description: 'Asks for a change to a document the caller may read' })
  raiseChangeRequest(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.raiseChangeRequest(ctx, parse(Uuid, id), parse(ChangeRequestBody, body));
  }

  @Post('document-change-requests/:id/accept')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Accepts it: a draft is started, or the draft in progress is used, and the request points at it' })
  acceptChangeRequest(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.acceptChangeRequest(ctx, parse(Uuid, id));
  }

  @Post('document-change-requests/:id/decline')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Declines it with a reason' })
  declineChangeRequest(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.declineChangeRequest(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('document-change-requests/:id/withdraw')
  @HttpCode(200)
  @OrganisationScoped()
  @ApiOkResponse({ description: 'The person who asked withdraws it while it is open' })
  withdrawChangeRequest(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.withdrawChangeRequest(ctx, parse(Uuid, id));
  }
}
