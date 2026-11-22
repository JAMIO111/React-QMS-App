import { Injectable } from '@nestjs/common';
import { z } from 'zod';

/**
 * What the source says about a day and a pair of currencies. `rates[quote]` is the rate (1 base = rate quote) or `null` when the source does not publish
 * that currency. `rateDate` is the business day the rates are for (a weekend asks answer with the Friday before); null when nothing is published at all.
 */
export interface RateAnswer {
  rateDate: string | null;
  rates: Record<string, number | null>;
}

/**
 * Where published exchange rates come from. The only code that talks to the outside: a failure to reach the source **throws** (nothing is cached and
 * the line stays "needed", to be tried again); an answer that says "not published" is returned as nulls (remembered for a week).
 */
export abstract class ExchangeRateGateway {
  abstract fetch(requestedOn: string, base: string, quotes: string[]): Promise<RateAnswer>;
}

const Published = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rates: z.record(z.number()),
});

type Fetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ status: number; text(): Promise<string> }>;

const MAX_BYTES = 64 * 1024;

/**
 * Frankfurter (https://frankfurter.dev): European Central Bank reference rates, no key, historical by day. Only a fixed host is ever called (the address is
 * configuration, never something a person types), currencies and the date are checked before they are put in the address, and answers are size-capped.
 * A currency or day it does not publish is a 404 (or simply missing from a 200); anything else unexpected is a failure to try again later.
 */
@Injectable()
export class FrankfurterGateway extends ExchangeRateGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly doFetch: Fetch = (url, init) => fetch(url, init),
    private readonly timeoutMs = 4000,
  ) {
    super();
  }

  async fetch(requestedOn: string, base: string, quotes: string[]): Promise<RateAnswer> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedOn) || !/^[A-Z]{3}$/.test(base) || quotes.length === 0 || quotes.some((q) => !/^[A-Z]{3}$/.test(q) || q === base)) {
      throw new Error('Not a currency pair or day Frankfurter can be asked for');
    }
    const url = `${this.baseUrl.replace(/\/+$/, '')}/v1/${requestedOn}?base=${base}&symbols=${[...new Set(quotes)].join(',')}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.once(url, quotes);
      } catch (error) {
        lastError = error;
        if (error instanceof Error && error.message.startsWith('Frankfurter refused')) break; // a refusal is not worth asking twice
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Frankfurter could not be reached');
  }

  private async once(url: string, quotes: string[]): Promise<RateAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.doFetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (res.status === 404) return { rateDate: null, rates: Object.fromEntries(quotes.map((q) => [q, null])) };
      if (res.status === 422 || (res.status >= 400 && res.status < 500 && res.status !== 429)) throw new Error(`Frankfurter refused the request (${res.status})`);
      if (res.status !== 200) throw new Error(`Frankfurter answered ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error('Frankfurter sent too much');
      const parsed = Published.safeParse(JSON.parse(text));
      if (!parsed.success) throw new Error('Frankfurter sent something unexpected');
      const rates: Record<string, number | null> = {};
      for (const q of quotes) {
        const v = parsed.data.rates[q];
        rates[q] = typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e9 ? v : null;
      }
      return { rateDate: parsed.data.date, rates };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Used when exchange rates are switched off (EXCHANGE_RATES=off) and in tests that do not provide a fake: every ask fails, so lines wait for a rate. */
export class UnavailableGateway extends ExchangeRateGateway {
  async fetch(): Promise<RateAnswer> {
    throw new Error('Exchange rates are switched off');
  }
}
