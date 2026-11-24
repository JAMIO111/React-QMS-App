import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { Versioned } from '../common/versioned';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  AllQuery, Attachment, ChangeListQuery, CreateAttachmentBody, CreateChangeBody, CreateFunctionBody, CreateTypeBody, DeleteBody, DeletedQuery, LinksBody, ListItem, ReasonBody,
  UpdateAreaBody, UpdateChangeBody, UpdateFunctionBody, UpdateTypeBody,
} from './change.schemas';
import { ChangeService } from './change.service';

const READ = 'change.read';
const MANAGE = 'change.manage';

/** Change management (CH1): types, functions and impact areas, and changes (ECR-YY-NNNN) with their scope and files. */
@ApiTags('change')
@ApiBearerAuth()
@Controller()
export class ChangeController {
  constructor(private readonly service: ChangeService) {}

  // ---- the lists ----------------------------------------------------------------------------------

  @Get('change-types')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'all', required: false, schema: { type: 'string', enum: ['true', 'false'] }, description: 'Include switched-off types' })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(ListItem) })) })
  types(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.types(ctx, parse(AllQuery, query));
  }

  @Post('change-types')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateTypeBody) })
  @ApiCreatedResponse({ schema: openApiSchema(ListItem) })
  createType(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createType(ctx, parse(CreateTypeBody, body));
  }

  @Patch('change-types/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateTypeBody) })
  @ApiOkResponse({ description: 'Renames, describes, reorders, switches off or on, or sets whether the customer must approve (nothing is deleted)', schema: openApiSchema(ListItem) })
  updateType(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateType(ctx, parse(Uuid, id), parse(UpdateTypeBody, body));
  }

  @Get('change-functions')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'all', required: false, schema: { type: 'string', enum: ['true', 'false'] } })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(ListItem) })) })
  functions(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.functions(ctx, parse(AllQuery, query));
  }

  @Post('change-functions')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateFunctionBody) })
  @ApiCreatedResponse({ schema: openApiSchema(ListItem) })
  createFunction(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createFunction(ctx, parse(CreateFunctionBody, body));
  }

  @Patch('change-functions/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateFunctionBody) })
  @ApiOkResponse({ schema: openApiSchema(ListItem) })
  updateFunction(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateFunction(ctx, parse(Uuid, id), parse(UpdateFunctionBody, body));
  }

  @Get('change-areas')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'all', required: false, schema: { type: 'string', enum: ['true', 'false'] } })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(ListItem) })) })
  areas(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.areas(ctx, parse(AllQuery, query));
  }

  @Patch('change-areas/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateAreaBody) })
  @ApiOkResponse({ description: 'Switches an impact area off or on (the list itself is fixed)', schema: openApiSchema(ListItem) })
  updateArea(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateArea(ctx, parse(Uuid, id), parse(UpdateAreaBody, body));
  }

  // ---- changes ------------------------------------------------------------------------------------

  @Get('changes')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The register, page-based (`q`, `stage` (default open), `typeId`, `urgency`, `owner=me`, `originKind`, `partId|partFamilyId|machineId|supplierId|customerId`, `sort`, `order`, `page`, `pageSize`)' })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(ChangeListQuery, query));
  }

  @Post('changes')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateChangeBody) })
  @ApiCreatedResponse({ description: 'Raises a change as a draft (ECR-YY-NNNN), optionally from a non-conformance, an 8D, an audit finding, a risk or a document change request (`origin`) and with what it covers (`links`)' })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateChangeBody, body));
  }

  @Versioned('change_requests')
  @Get('changes/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'A change with its scope, origin and files' })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Versioned('change_requests')
  @Patch('changes/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateChangeBody) })
  @ApiOkResponse({ description: 'Changes the title, what, why, type or urgency of a draft' })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateChangeBody, body));
  }

  @Put('changes/:id/links')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(LinksBody) })
  @ApiOkResponse({ description: 'Replaces everything the change covers (parts, families, machines, suppliers, customers, orders, operations); a draft only' })
  setLinks(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setLinks(ctx, parse(Uuid, id), parse(LinksBody, body).links);
  }

  @Post('changes/:id/cancel')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Cancels a change with a reason (never deleted)' })
  cancel(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.cancel(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Get('changes/:id/attachments')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'deleted', required: false, schema: { type: 'string', enum: ['exclude', 'include', 'only'] } })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(Attachment) })) })
  async attachments(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return { data: await this.service.listAttachments(ctx, parse(Uuid, id), parse(DeletedQuery, query)) };
  }

  @Post('changes/:id/attachments')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateAttachmentBody) })
  @ApiCreatedResponse({ description: 'Records a file already uploaded to the change’s folder (not once closed, rejected or cancelled)', schema: openApiSchema(Attachment) })
  createAttachment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createAttachment(ctx, parse(Uuid, id), parse(CreateAttachmentBody, body));
  }

  @Post('change-attachments/:id/delete')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(DeleteBody) })
  @ApiOkResponse({ description: 'Takes a file off the change with a reason; the stored file is kept', schema: openApiSchema(Attachment) })
  removeAttachment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.removeAttachment(ctx, parse(Uuid, id), parse(DeleteBody, body).reason);
  }

  @Post('change-attachments/:id/restore')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ schema: openApiSchema(Attachment) })
  restoreAttachment(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.restoreAttachment(ctx, parse(Uuid, id));
  }
}
