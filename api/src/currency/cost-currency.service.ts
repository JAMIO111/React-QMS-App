import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import { RequestContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { ExchangeRateService, RatePair } from './exchange-rate.service';

export interface RestateSite {
  siteId: string;
  code: string;
  name: string;
  siteCurrency: string;
  lines: number;
  statedIn: string[];
  /** Rates a restate needs that are not cached yet (asked for when the restate is confirmed). */
  missing: { requestedOn: string; base: string; quote: string }[];
}

export interface RestateReport {
  sites: RestateSite[];
}

/**
 * The restate of cost lines stated in a currency other than their site's (docs/cost-currency-plan.md CU11). The report changes nothing; the confirmed run
 * fetches the rates it needs, then the database restates that site's lines into its currency with the published rates (organisation figures stay as they
 * were; a line with no published rate becomes "needed").
 */
@Injectable()
export class CostCurrencyService {
  constructor(
    private readonly database: DatabaseService,
    private readonly rates: ExchangeRateService,
  ) {}

  report(ctx: RequestContext): Promise<RestateReport> {
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<{ report: RestateReport }>(sql`select app.restate_cost_report(${ctx.organisationId!}::uuid) as report`);
      return r.rows[0].report;
    });
  }

  /** Without `confirm` it only says what would happen for the site; with it, it does it. */
  async restate(ctx: RequestContext, siteId: string, confirm: boolean) {
    const report = await this.report(ctx);
    const site = report.sites.find((s) => s.siteId === siteId);
    if (!site) return { confirmed: confirm, site: null, restated: 0, needed: 0 };
    if (!confirm) return { confirmed: false, site, restated: 0, needed: 0 };
    const pairs: RatePair[] = site.missing.map((m) => ({ requestedOn: m.requestedOn, base: m.base, quote: m.quote }));
    if (pairs.length) await this.rates.ensurePairs(pairs, ctx.correlationId);
    const done = await this.database.asApi(
      async (client) => (await client.query(`select app.system_restate_costs($1::uuid, $2::uuid) as r`, [ctx.organisationId, siteId])).rows[0].r as { restated: number; needed: number },
      ctx.correlationId,
      'cost-restate',
    ).catch((error: { code?: string }) => {
      if (error.code === 'P0002') throw ApiError.notFound('site_not_found', 'Site not found');
      throw error;
    });
    return { confirmed: true, site, restated: Number(done.restated), needed: Number(done.needed) };
  }
}
