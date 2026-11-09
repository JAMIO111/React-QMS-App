import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  AcknowledgeScarBody, CreateScarBody, ExtendBody, ImplementationBody, LinkNcrBody, RecordResponseBody, ReviewBody, ScarDetail, ScarListQuery, ScarPage, ScarReasonBody, UpdateScarBody, VerificationBody,
} from './supplier-scar.schemas';
import { SupplierScarService } from './supplier-scar.service';

const READ = 'supplier_quality.read';
const MANAGE = 'supplier_quality.manage';
const APPROVE = 'supplier_quality.approve';

/**
 * Supplier corrective action requests (SQ3). The stages are separate commands: record a response, start the review, decide on it, record implementation, verify effectiveness. Receiving a
 * response never closes a SCAR; closing needs an effective verification by someone with supplier_quality.approve. The database checks every transition.
 */
@ApiTags('supplier-quality')
@ApiBearerAuth()
@Controller('supplier-quality')
export class SupplierScarController {
  constructor(private readonly service: SupplierScarService) {}

  @Get('scars')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'SCARs, page by page. Status defaults to the running ones; `overdue=true` lists those whose response is late.', schema: openApiSchema(ScarPage) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(ScarListQuery, query));
  }

  @Post('scars')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateScarBody) })
  @ApiCreatedResponse({ description: 'A draft SCAR for one supplier, linking that supplier\'s own non-conformances. A retry with the same clientKey returns the same SCAR.', schema: openApiSchema(ScarDetail) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateScarBody, body));
  }

  @Get('scars/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The SCAR with its linked non-conformances, responses (each with our review), implementation, verification, due-date extensions and status history', schema: openApiSchema(ScarDetail) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Patch('scars/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateScarBody) })
  @ApiOkResponse({ description: 'A draft can change its content; once issued only the contact and the 8D link', schema: openApiSchema(ScarDetail) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateScarBody, body));
  }

  @Post('scars/:id/issue')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Issues a draft: it needs a response due date and at least one linked non-conformance', schema: openApiSchema(ScarDetail) })
  issue(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.issue(ctx, parse(Uuid, id));
  }

  @Post('scars/:id/acknowledge')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(AcknowledgeScarBody) })
  @ApiOkResponse({ description: 'Records that the supplier confirmed receipt', schema: openApiSchema(ScarDetail) })
  acknowledge(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.acknowledge(ctx, parse(Uuid, id), parse(AcknowledgeScarBody, body ?? {}));
  }

  @Post('scars/:id/responses')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(RecordResponseBody) })
  @ApiOkResponse({ description: 'Records a response from the supplier (root cause, containment, corrective and preventive action). It never closes the SCAR: it waits for review.', schema: openApiSchema(ScarDetail) })
  respond(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.recordResponse(ctx, parse(Uuid, id), parse(RecordResponseBody, body));
  }

  @Post('scars/:id/start-review')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Starts our internal review of the latest response', schema: openApiSchema(ScarDetail) })
  startReview(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.startReview(ctx, parse(Uuid, id));
  }

  @Post('scars/:id/review')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReviewBody) })
  @ApiOkResponse({ description: 'Our decision on the latest response: accepted, or a revision is requested (the supplier answers again)', schema: openApiSchema(ScarDetail) })
  review(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.review(ctx, parse(Uuid, id), parse(ReviewBody, body));
  }

  @Post('scars/:id/implementations')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ImplementationBody) })
  @ApiOkResponse({ description: 'Records that the accepted fix was carried out; the first one moves the SCAR to verifying', schema: openApiSchema(ScarDetail) })
  implement(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.recordImplementation(ctx, parse(Uuid, id), parse(ImplementationBody, body));
  }

  @Post('scars/:id/verifications')
  @HttpCode(200)
  @OrganisationScoped(APPROVE)
  @ApiBody({ schema: openApiSchema(VerificationBody) })
  @ApiOkResponse({ description: 'Effectiveness verification (needs supplier_quality.approve). Effective closes the SCAR; not effective sends it back for a new response.', schema: openApiSchema(ScarDetail) })
  verify(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.recordVerification(ctx, parse(Uuid, id), parse(VerificationBody, body));
  }

  @Post('scars/:id/extensions')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ExtendBody) })
  @ApiOkResponse({ description: 'Moves the response due date later, with a reason; the original date is kept', schema: openApiSchema(ScarDetail) })
  extend(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.extend(ctx, parse(Uuid, id), parse(ExtendBody, body));
  }

  @Post('scars/:id/cancel')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ScarReasonBody) })
  @ApiOkResponse({ description: 'Cancels a SCAR that is not closed, with a reason; it is kept', schema: openApiSchema(ScarDetail) })
  cancel(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.cancel(ctx, parse(Uuid, id), parse(ScarReasonBody, body));
  }

  @Post('scars/:id/ncrs')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(LinkNcrBody) })
  @ApiOkResponse({ description: 'Links one of this supplier\'s non-conformances', schema: openApiSchema(ScarDetail) })
  linkNcr(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.linkNcr(ctx, parse(Uuid, id), parse(LinkNcrBody, body));
  }

  @Post('scar-ncrs/:id/unlink')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ScarReasonBody) })
  @ApiOkResponse({ description: 'Ends the link to a non-conformance, with a reason; the row is kept', schema: openApiSchema(ScarDetail) })
  unlinkNcr(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.unlinkNcr(ctx, parse(Uuid, id), parse(ScarReasonBody, body));
  }
}
