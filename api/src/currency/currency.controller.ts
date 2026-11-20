import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { CostCurrencyService } from './cost-currency.service';
import { ExchangeRateService } from './exchange-rate.service';

const code = z.string().trim().regex(/^[A-Za-z]{3}$/, 'Use a 3-letter ISO currency code').transform((v) => v.toUpperCase());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const PreviewQuery = z.object({ from: code, to: code, date: isoDate.optional() }).strict();
export const RestateBody = z.object({ siteId: Uuid, confirm: z.boolean().default(false) }).strict();

@ApiTags('costs')
@ApiBearerAuth()
@Controller()
export class CurrencyController {
  constructor(
    private readonly rates: ExchangeRateService,
    private readonly costs: CostCurrencyService,
  ) {}

  /** The automatic rate a conversion would use (for the cost form). Nothing is saved. */
  @Get('exchange-rates/preview')
  @OrganisationScoped()
  @ApiQuery({ name: 'from', required: true, description: 'Currency of the cost' })
  @ApiQuery({ name: 'to', required: true, description: 'Currency to convert to' })
  @ApiQuery({ name: 'date', required: false, description: 'The day the cost was incurred (YYYY-MM-DD); default today' })
  @ApiOkResponse({ description: '{ from, to, requestedOn, rate, rateDate, state: published | not_published | unavailable }' })
  preview(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(PreviewQuery, query);
    return this.rates.preview(ctx, q.from, q.to, q.date ?? new Date().toISOString().slice(0, 10));
  }

  /** Sites whose lines were stated in a different currency from the site's. Changes nothing. */
  @Get('cost-currency/restate-report')
  @OrganisationScoped('organisation.manage')
  @ApiOkResponse({ description: '{ sites: [{ siteId, code, name, siteCurrency, lines, statedIn, missing }] }' })
  report(@Ctx() ctx: RequestContext) {
    return this.costs.report(ctx);
  }

  /** Restate one site's lines into its currency. Without `confirm` it only says what would happen. */
  @Post('cost-currency/restate')
  @HttpCode(200)
  @OrganisationScoped('organisation.manage')
  @ApiBody({ schema: openApiSchema(RestateBody) })
  @ApiOkResponse({ description: '{ confirmed, site, restated, needed }' })
  restate(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(RestateBody, body);
    return this.costs.restate(ctx, b.siteId, b.confirm);
  }
}
