import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Query, RawBodyRequest, Req } from '@nestjs/common';
import type { Request } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/auth.guard';
import { resolveCorrelationId, ApiRequest } from '../common/request-context';
import { ApiBearerAuth, ApiBody, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  AssignPackageBody,
  CheckoutBody,
  CheckoutResponse,
  ConfirmCheckoutBody,
  PortalResponse,
  SeatChangeBody,
  SeatPreviewResponse,
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
import { StripeBillingService } from './stripe-billing.service';

/** Subscription packages, seats and billing records. Independent of company roles: see BillingService. */
@ApiTags('subscription')
@ApiBearerAuth()
@Controller()
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly stripe: StripeBillingService,
  ) {}

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

  @Post('billing/checkout-session')
  @OrganisationScoped('subscription.manage')
  @ApiBody({ schema: openApiSchema(CheckoutBody) })
  @ApiOkResponse({ description: 'Starts Stripe Checkout (14-day trial, card required). Redirect the browser to url. 409 subscription_rule for an owner-only start, a live subscription or seat problems; 503 billing_unavailable without Stripe set up.', schema: openApiSchema(CheckoutResponse) })
  @HttpCode(200)
  checkout(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.stripe.checkout(ctx, parse(CheckoutBody, body));
  }

  @Post('billing/checkout-session/confirm')
  @OrganisationScoped('subscription.manage')
  @ApiBody({ schema: openApiSchema(ConfirmCheckoutBody) })
  @ApiOkResponse({ description: 'Asks Stripe about the Checkout the person started and applies the subscription. status is open until they have finished paying.' })
  @HttpCode(200)
  confirm(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.stripe.confirm(ctx, parse(ConfirmCheckoutBody, body));
  }

  @Post('billing/portal-session')
  @OrganisationScoped('subscription.manage')
  @ApiOkResponse({ description: 'Stripe Customer Portal address (card, invoices, tax details, cancellation at period end).', schema: openApiSchema(PortalResponse) })
  @HttpCode(200)
  portal(@Ctx() ctx: RequestContext) {
    return this.stripe.portal(ctx);
  }

  @Post('billing/seats/preview')
  @OrganisationScoped('subscription.manage')
  @ApiBody({ schema: openApiSchema(SeatChangeBody) })
  @ApiOkResponse({ description: 'What the seat change would cost now (proration from Stripe); changes nothing.', schema: openApiSchema(SeatPreviewResponse) })
  @HttpCode(200)
  previewSeats(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.stripe.previewSeats(ctx, parse(SeatChangeBody, body));
  }

  @Put('billing/seats')
  @OrganisationScoped('subscription.manage')
  @ApiBody({ schema: openApiSchema(SeatChangeBody) })
  @ApiOkResponse({ description: 'Changes the seats on the Stripe subscription (prorated). 409 subscription_rule below the seats in use or with no Controller seat.', schema: openApiSchema(SubscriptionOverview) })
  changeSeats(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.stripe.changeSeats(ctx, parse(SeatChangeBody, body));
  }
}

/** Stripe's webhook: no sign-in, no organisation header; the signature over the raw body is the authentication. */
@ApiTags('subscription')
@Controller('stripe')
export class StripeWebhookController {
  constructor(private readonly stripe: StripeBillingService) {}

  @Post('webhook')
  @Public()
  @SkipThrottle()
  @HttpCode(200)
  @ApiOkResponse({ description: 'Event accepted (or already handled). 400 invalid_signature; 5xx makes Stripe retry.' })
  webhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature: string | undefined) {
    return this.stripe.handleWebhook(req.rawBody, signature, resolveCorrelationId(req as ApiRequest));
  }
}
