import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { HoursQuery, LimitQuery, Overview, OverviewQuery, OrganisationsQuery, PlatformActivity, PlatformMe, PlatformOrganisations, PlatformPayments, PlatformEmail, PlatformRevenue, PlatformWebhooks } from './platform.schemas';
import { PlatformService } from './platform.service';

/**
 * The operator's area. Deliberately not organisation-scoped (it spans organisations) and read-only: it reads the platform's own tables through admin-only
 * database functions and never any organisation's business data. Access = on the platform allow-list AND an MFA session, enforced in the database.
 */
@ApiTags('platform')
@ApiBearerAuth()
@Controller('platform')
export class PlatformController {
  constructor(private readonly service: PlatformService) {}

  @Get('me')
  @ApiOkResponse({ description: 'Whether the caller may use the platform area', schema: openApiSchema(PlatformMe) })
  me(@Ctx() ctx: RequestContext) {
    return this.service.me(ctx);
  }

  @Get('overview')
  @ApiQuery({ name: 'days', required: false, schema: { type: 'integer', minimum: 1, maximum: 365 } })
  @ApiOkResponse({ description: 'The sign-up funnel for the period and the latest sign-ups (404 for non-operators, 403 mfa_required without MFA)', schema: openApiSchema(Overview) })
  overview(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.overview(ctx, parse(OverviewQuery, query));
  }

  @Get('organisations')
  @ApiOkResponse({ description: 'Every organisation with its billing state, owners and counts (no business data). Search by name or owner email. 404 for non-operators, 403 mfa_required without MFA.', schema: openApiSchema(PlatformOrganisations) })
  organisations(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.organisations(ctx, parse(OrganisationsQuery, query));
  }

  @Get('revenue')
  @ApiOkResponse({ description: 'MRR, ARR, trial MRR, subscriptions by status, seats by package, trials ending, past due, cancelling (Stripe-billed, pence, excluding VAT)', schema: openApiSchema(PlatformRevenue) })
  revenue(@Ctx() ctx: RequestContext) {
    return this.service.revenue(ctx);
  }

  @Get('payments')
  @ApiOkResponse({ description: 'Latest invoices across organisations, failed payments and 30-day totals', schema: openApiSchema(PlatformPayments) })
  payments(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.payments(ctx, parse(LimitQuery, query));
  }

  @Get('email')
  @ApiOkResponse({ description: 'Email notifications: the mail provider in use, emails by status, waiting, last sent and failures with their error (never content or addresses). 404 for non-operators, 403 mfa_required without MFA.', schema: openApiSchema(PlatformEmail) })
  email(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.email(ctx, parse(HoursQuery, query));
  }

  @Get('webhooks')
  @ApiOkResponse({ description: 'Webhook health: last received, events by status, stuck and failed events', schema: openApiSchema(PlatformWebhooks) })
  webhooks(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.webhooks(ctx, parse(HoursQuery, query));
  }

  @Get('activity')
  @ApiOkResponse({ description: 'Billing events and organisation milestones, newest first', schema: openApiSchema(PlatformActivity) })
  activity(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.activity(ctx, parse(LimitQuery, query));
  }
}
