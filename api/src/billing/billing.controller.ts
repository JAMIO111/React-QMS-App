import { Body, Controller, Delete, Get, HttpCode, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  AssignPackageBody,
  EntitlementCheck,
  EntitlementQuery,
  Invoice,
  PlanCatalogue,
  SeatMember,
  SetSeatsBody,
  SubscriptionAccess,
  SubscriptionEvent,
  SubscriptionOverview,
} from './billing.schemas';
import { BillingService } from './billing.service';

/** Subscription packages, seats and billing records. Independent of company roles: see BillingService. */
@ApiTags('subscription')
@ApiBearerAuth()
@Controller()
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('subscription/access')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'The signed-in member\'s package and access level per module (for navigation and restriction pages)', schema: openApiSchema(SubscriptionAccess) })
  access(@Ctx() ctx: RequestContext) {
    return this.billing.access(ctx);
  }

  @Get('subscription/check')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'checkSubscriptionEntitlement for the signed-in member', schema: openApiSchema(EntitlementCheck) })
  check(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(EntitlementQuery, query);
    return this.billing.check(ctx, q.module, q.feature);
  }

  @Get('subscription-plans')
  @OrganisationScoped('subscription.read')
  @ApiOkResponse({ description: 'Packages, current prices (pence) and the module/feature comparison', schema: openApiSchema(PlanCatalogue) })
  plans(@Ctx() ctx: RequestContext) {
    return this.billing.catalogue(ctx);
  }

  @Get('subscription')
  @OrganisationScoped('subscription.read')
  @ApiOkResponse({ schema: openApiSchema(SubscriptionOverview) })
  overview(@Ctx() ctx: RequestContext) {
    return this.billing.overview(ctx);
  }

  @Put('subscription/seats')
  @OrganisationScoped('subscription.manage')
  @ApiBody({ schema: openApiSchema(SetSeatsBody) })
  @ApiOkResponse({ description: 'Sets the purchased seats of a package. 409 subscription_rule if below the seats in use.', schema: openApiSchema(SubscriptionOverview) })
  setSeats(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.billing.setSeats(ctx, parse(SetSeatsBody, body));
  }

  @Get('subscription/assignments')
  @OrganisationScoped('subscription.read')
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(SeatMember) })) })
  async seats(@Ctx() ctx: RequestContext) {
    return { data: await this.billing.seats(ctx) };
  }

  @Put('subscription/assignments/:id')
  @OrganisationScoped('subscription.seats')
  @ApiBody({ schema: openApiSchema(AssignPackageBody) })
  @ApiOkResponse({ description: 'Assigns or changes a member\'s package. 409 subscription_rule without a free seat.', schema: openApiSchema(SeatMember) })
  assign(@Ctx() ctx: RequestContext, @Param('id') membershipId: string, @Body() body: unknown) {
    return this.billing.assign(ctx, parse(Uuid, membershipId), parse(AssignPackageBody, body));
  }

  @Delete('subscription/assignments/:id')
  @HttpCode(204)
  @OrganisationScoped('subscription.seats')
  @ApiNoContentResponse({ description: 'Removes the package only; membership, roles and permissions are untouched.' })
  async unassign(@Ctx() ctx: RequestContext, @Param('id') membershipId: string) {
    await this.billing.unassign(ctx, parse(Uuid, membershipId));
  }

  @Get('billing/invoices')
  @OrganisationScoped('invoices.read')
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(Invoice) })) })
  async invoices(@Ctx() ctx: RequestContext) {
    return { data: await this.billing.invoices(ctx) };
  }

  @Get('subscription/history')
  @OrganisationScoped('subscription.read')
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(SubscriptionEvent) })) })
  async history(@Ctx() ctx: RequestContext) {
    return { data: await this.billing.history(ctx) };
  }
}
