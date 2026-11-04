import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { Attachment, Cost, CostList, CreateAttachmentBody, CreateCostBody, DeletedQuery, UpdateCostBody } from './ncr-records.schemas';
import { DeleteBody } from './ncr.schemas';
import { NcrRecordsService } from './ncr-records.service';

// Site-scoped role assignments count; RLS then limits rows to the NCR's site.
const SITE_SCOPED = { anyScope: true };

@ApiTags('ncrs')
@ApiBearerAuth()
@Controller('ncrs')
export class NcrChildRecordsController {
  constructor(private readonly service: NcrRecordsService) {}

  @Get(':id/costs')
  @OrganisationScoped('ncr.read', SITE_SCOPED)
  @ApiQuery({ name: 'deleted', required: false, enum: ['exclude', 'include', 'only'] })
  @ApiOkResponse({ schema: openApiSchema(CostList) })
  listCosts(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return this.service.listCosts(ctx, parse(Uuid, id), parse(DeletedQuery, query));
  }

  /** Add a cost; net / VAT / gross and base-currency values are worked out by the server. */
  @Post(':id/costs')
  @HttpCode(201)
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(CreateCostBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Cost) })
  createCost(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createCost(ctx, parse(Uuid, id), parse(CreateCostBody, body));
  }

  @Get(':id/attachments')
  @OrganisationScoped('ncr.read', SITE_SCOPED)
  @ApiQuery({ name: 'deleted', required: false, enum: ['exclude', 'include', 'only'] })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(Attachment) })) })
  async listAttachments(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return { data: await this.service.listAttachments(ctx, parse(Uuid, id), parse(DeletedQuery, query)) };
  }

  /** Record a file already uploaded to the nc-files bucket at {organisationId}/ncr/{id}/… */
  @Post(':id/attachments')
  @HttpCode(201)
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(CreateAttachmentBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Attachment) })
  createAttachment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createAttachment(ctx, parse(Uuid, id), parse(CreateAttachmentBody, body));
  }
}

@ApiTags('ncrs')
@ApiBearerAuth()
@Controller('ncr-costs')
export class NcrCostsController {
  constructor(private readonly service: NcrRecordsService) {}

  @Patch(':id')
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(UpdateCostBody) })
  @ApiOkResponse({ schema: openApiSchema(Cost) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateCost(ctx, parse(Uuid, id), parse(UpdateCostBody, body));
  }

  @Post(':id/delete')
  @HttpCode(200)
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(DeleteBody) })
  @ApiOkResponse({ schema: openApiSchema(Cost) })
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.removeCost(ctx, parse(Uuid, id), parse(DeleteBody, body).reason);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiOkResponse({ schema: openApiSchema(Cost) })
  restore(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.restoreCost(ctx, parse(Uuid, id));
  }
}

@ApiTags('ncrs')
@ApiBearerAuth()
@Controller('ncr-attachments')
export class NcrAttachmentsController {
  constructor(private readonly service: NcrRecordsService) {}

  /** Remove a file from the NCR (soft delete; the stored file is kept as evidence). */
  @Post(':id/delete')
  @HttpCode(200)
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(DeleteBody) })
  @ApiOkResponse({ schema: openApiSchema(Attachment) })
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.removeAttachment(ctx, parse(Uuid, id), parse(DeleteBody, body).reason);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @OrganisationScoped('ncr.update', SITE_SCOPED)
  @ApiOkResponse({ schema: openApiSchema(Attachment) })
  restore(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.restoreAttachment(ctx, parse(Uuid, id));
  }
}
