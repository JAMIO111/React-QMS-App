import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { RequestContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { ExchangeRateGateway, RateAnswer } from './exchange-rate.gateway';

export interface RatePair {
  requestedOn: string;
  base: string;
  quote: string;
}

export interface RatePreview {
  from: string;
  to: string;
  requestedOn: string;
  /** 1 `from` = `rate` `to`; null when there is no automatic rate. */
  rate: number | null;
  /** The business day the rate was published for. */
  rateDate: string | null;
  /** `published`, `not_published` (the source does not publish the pair) or `unavailable` (could not be reached just now). */
  state: 'published' | 'not_published' | 'unavailable';
}

export interface SettleResult {
  asked: number;
  stored: number;
  filled: number;
  unavailable: number;
}

type Item = { organisationId: string; requestedOn: string; base: string; quotes: string[] };
type Stored = { requestedOn: string; base: string; quote: string; rate: number | null; rateDate: string | null };

const todayUtc = () => new Date().toISOString().slice(0, 10);

/**
 * Keeps the cache of published exchange rates (public.exchange_rates) up to date and gives waiting cost lines their rate. The database decides what a line
 * gets (it looks the pair up in the cache when the line is saved); this only fetches what is missing, stores it through the API login's functions and then
 * asks the database to fill the lines that were waiting. **A failure to reach the source never fails anything**: lines stay "needed" and are tried again
 * (by the next save, or by the worker).
 */
@Injectable()
export class ExchangeRateService {
  private readonly log = new Logger(ExchangeRateService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly gateway: ExchangeRateGateway,
  ) {}

  /**
   * Fetches the pairs lines are waiting for (one organisation, or all of them), stores them and fills the lines. Bounded by `budgetMs`, so a slow source
   * cannot hold a request or a worker tick.
   */
  async settle(organisationId: string | null, correlationId = '', budgetMs = 8000): Promise<SettleResult> {
    const result: SettleResult = { asked: 0, stored: 0, filled: 0, unavailable: 0 };
    const stopAt = Date.now() + budgetMs;
    try {
      const needed = await this.database.asApi(
        async (client) => (await client.query(`select app.system_cost_rates_needed($1::uuid, 100) as items`, [organisationId])).rows[0].items as Item[],
        correlationId,
        'exchange-rates',
      );
      const stored = await this.fetchAndStore(
        needed.map((i) => ({ requestedOn: i.requestedOn, base: i.base, quotes: i.quotes })),
        stopAt,
        result,
        correlationId,
      );
      result.stored = stored;
      result.filled = await this.database.asApi(
        async (client) => Number((await client.query(`select app.system_fill_cost_rates($1::uuid) as n`, [organisationId])).rows[0].n),
        correlationId,
        'exchange-rates',
      );
    } catch (error) {
      result.unavailable += 1;
      this.log.warn(`Exchange rates could not be settled: ${(error as Error).message}`);
    }
    return result;
  }

  /** Makes sure the given pairs are cached (the restate asks for the ones it needs). Returns how many were stored. */
  async ensurePairs(pairs: RatePair[], correlationId = '', budgetMs = 20000): Promise<SettleResult> {
    const result: SettleResult = { asked: 0, stored: 0, filled: 0, unavailable: 0 };
    const grouped = new Map<string, { requestedOn: string; base: string; quotes: string[] }>();
    for (const p of pairs) {
      const key = `${p.requestedOn}|${p.base}`;
      const g = grouped.get(key) ?? { requestedOn: p.requestedOn, base: p.base, quotes: [] };
      if (!g.quotes.includes(p.quote)) g.quotes.push(p.quote);
      grouped.set(key, g);
    }
    result.stored = await this.fetchAndStore([...grouped.values()], Date.now() + budgetMs, result, correlationId);
    return result;
  }

  /** What an automatic conversion would use, for the cost form: the cache, then the source. Nothing about any record is touched. */
  async preview(ctx: RequestContext, from: string, to: string, requestedOn: string): Promise<RatePreview> {
    const on = requestedOn > todayUtc() ? todayUtc() : requestedOn;
    const base: RatePreview = { from, to, requestedOn: on, rate: null, rateDate: null, state: 'not_published' };
    if (from === to) return { ...base, rate: 1, rateDate: null, state: 'published' };
    const lookup = () =>
      this.database.asUser(ctx, async (db) => {
        const r = await db.execute<{ supported: boolean; rate: string | null; rate_date: string | null }>(
          sql`select supported, rate, to_char(rate_date, 'YYYY-MM-DD') as rate_date from app.exchange_rate_lookup(${on}::date, ${from}, ${to})`,
        );
        return r.rows[0];
      });
    let row = await lookup();
    if (!row) {
      const scratch: SettleResult = { asked: 0, stored: 0, filled: 0, unavailable: 0 };
      await this.fetchAndStore([{ requestedOn: on, base: from, quotes: [to] }], Date.now() + 6000, scratch, ctx.correlationId);
      if (scratch.unavailable) return { ...base, state: 'unavailable' };
      row = await lookup();
    }
    if (!row || !row.supported || row.rate === null) return base;
    return { ...base, rate: Number(row.rate), rateDate: row.rate_date, state: 'published' };
  }

  // ---- internals -----------------------------------------------------------------------------

  private async fetchAndStore(items: { requestedOn: string; base: string; quotes: string[] }[], stopAt: number, result: SettleResult, correlationId: string): Promise<number> {
    const rows: Stored[] = [];
    // A few at a time, never past the deadline.
    for (let i = 0; i < items.length; i += 4) {
      if (Date.now() >= stopAt) break;
      const chunk = items.slice(i, i + 4);
      await Promise.all(
        chunk.map(async (item) => {
          result.asked += 1;
          let answer: RateAnswer;
          try {
            answer = await this.gateway.fetch(item.requestedOn, item.base, item.quotes);
          } catch (error) {
            result.unavailable += 1;
            this.log.warn(`No answer for ${item.base} on ${item.requestedOn}: ${(error as Error).message}`);
            return;
          }
          for (const quote of item.quotes) {
            const rate = answer.rates[quote] ?? null;
            // A rate must be for a day on or before the one asked (the database holds the same rule).
            const rateDate = rate !== null && answer.rateDate && answer.rateDate <= item.requestedOn ? answer.rateDate : null;
            rows.push({ requestedOn: item.requestedOn, base: item.base, quote, rate: rateDate ? rate : null, rateDate });
          }
        }),
      );
    }
    if (!rows.length) return 0;
    return this.database.asApi(
      async (client) => Number((await client.query(`select app.system_store_exchange_rates($1::jsonb) as n`, [JSON.stringify(rows)])).rows[0].n),
      correlationId,
      'exchange-rates',
    );
  }
}
