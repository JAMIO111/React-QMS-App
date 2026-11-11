import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  ApproveBody, CommentBody, CompareQuery, CreateDocumentBody, CreateTypeBody, DocumentFileBody, DocumentListQuery, DocumentType, ReasonBody, ReviewBody, SignersBody,
  TypeListQuery, UpdateDocumentBody, UpdateRevisionBody, UpdateTypeBody,
} from './documents.schemas';
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
  constructor(private readonly service: DocumentsService) {}

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
}
