import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { HoursQuery, LimitQuery, Overview, OverviewQuery, OrganisationsQuery, PlatformActivity, PlatformMe, PlatformOrganisations, PlatformPayments, PlatformEmail, PlatformWorker, PlatformRevenue, PlatformWebhooks, RecoverNetworkBody, InvoiceBillingBody, InvoiceCompanyExemptBody, PlatformInvoiceAccounts, AgentReleases, PublishReleaseBody, WithdrawReleaseBody } from './platform.schemas';
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

  @Get('invoice-accounts')
  @ApiOkResponse({ description: 'Invoiced organisations: route, whether the first invoice is paid, what is open and how late. 404 for non-operators, 403 mfa_required without MFA.', schema: openApiSchema(PlatformInvoiceAccounts) })
  invoiceAccounts(@Ctx() ctx: RequestContext) {
    return this.service.invoiceAccounts(ctx);
  }

  @Post('organisations/:id/invoice-billing')
  @HttpCode(200)
  @ApiBody({ schema: openApiSchema(InvoiceBillingBody) })
  @ApiOkResponse({ description: 'Allow or refuse paying by invoice for one organisation (reason required). Existing subscriptions carry on. 404 for non-operators, 403 mfa_required without MFA.' })
  invoiceBilling(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setInvoiceBillingAllowed(ctx, parse(Uuid, id), parse(InvoiceBillingBody, body));
  }

  @Post('organisations/:id/invoice-company-exempt')
  @HttpCode(200)
  @ApiBody({ schema: openApiSchema(InvoiceCompanyExemptBody) })
  @ApiOkResponse({ description: 'Lift (or restore) the one-invoiced-organisation-per-company block for a genuine second entity (reason required). 404 for non-operators, 403 mfa_required without MFA.' })
  invoiceCompanyExempt(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setInvoiceCompanyExempt(ctx, parse(Uuid, id), parse(InvoiceCompanyExemptBody, body));
  }

  @Post('organisations/:id/recover-network-policy')
  @HttpCode(200)
  @ApiBody({ schema: openApiSchema(RecoverNetworkBody) })
  @ApiOkResponse({ description: 'Put an organisation that enforces network restrictions back to monitor when everyone is locked out (reason and how ownership was verified; never off). Owners and admins are told. 404 for non-operators, 403 mfa_required without MFA, 409 security_rule when it is not enforcing.' })
  recoverNetworkPolicy(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.recoverNetworkPolicy(ctx, parse(Uuid, id), parse(RecoverNetworkBody, body));
  }

  @Post('organisations/:id/recover-sso')
  @HttpCode(200)
  @ApiBody({ schema: openApiSchema(RecoverNetworkBody) })
  @ApiOkResponse({ description: 'Make single sign-on optional again for an organisation that requires it, when the company sign-in fails and nobody can get in (reason and how ownership was verified; never off; the provider is kept). Owners and admins are told. 404 for non-operators, 403 mfa_required without MFA, 409 sso_rule when it is not required.' })
  recoverSso(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.recoverSso(ctx, parse(Uuid, id), parse(RecoverNetworkBody, body));
  }

  @Get('agent-releases')
  @ApiOkResponse({ description: 'Connector agent releases, withdrawn ones too, with how many agents run each, and which release keys are configured (AGENT_RELEASE_KEYS). 404 for non-operators, 403 mfa_required without MFA.', schema: openApiSchema(AgentReleases) })
  agentReleases(@Ctx() ctx: RequestContext) {
    return this.service.agentReleases(ctx);
  }

  @Post('agent-releases')
  @HttpCode(201)
  @ApiBody({ schema: openApiSchema(PublishReleaseBody) })
  @ApiOkResponse({ description: 'Publish a signed connector agent release (the manifest text exactly as signed and its signature). 400 when the manifest reads wrong or no configured key signed it, 503 release_keys_unavailable without keys, 409 integration_rule when the version is published already.' })
  publishAgentRelease(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.publishAgentRelease(ctx, parse(PublishReleaseBody, body));
  }

  @Post('agent-releases/:id/withdraw')
  @HttpCode(200)
  @ApiBody({ schema: openApiSchema(WithdrawReleaseBody) })
  @ApiOkResponse({ description: 'Withdraw a release (a reason): no new updates to it; updates waiting for it are cancelled. Never deleted.' })
  withdrawAgentRelease(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.withdrawAgentRelease(ctx, parse(Uuid, id), parse(WithdrawReleaseBody, body).reason);
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

  @Get('worker')
  @ApiOkResponse({ description: 'The background worker: the last ticks with their steps, ticks in the last hour, the job queue by kind and status, failed jobs with their error (never payloads), outbox consumers and their backlog. 404 for non-operators, 403 mfa_required without MFA.', schema: openApiSchema(PlatformWorker) })
  worker(@Ctx() ctx: RequestContext) {
    return this.service.worker(ctx);
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
