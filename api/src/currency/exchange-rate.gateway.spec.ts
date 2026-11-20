import { FrankfurterGateway, UnavailableGateway } from './exchange-rate.gateway';

type Answer = { status: number; body?: string };
const gateway = (answers: (Answer | Error)[], timeoutMs = 50) => {
  const calls: string[] = [];
  const g = new FrankfurterGateway(
    'https://rates.example/',
    async (url, init) => {
      calls.push(url);
      const next = answers.shift();
      if (!next) throw new Error('no more answers');
      if (next instanceof Error) throw next;
      if (next.body === 'hang') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      return { status: next.status, text: async () => next.body ?? '' };
    },
    timeoutMs,
  );
  return { g, calls };
};
const ok = (body: unknown): Answer => ({ status: 200, body: JSON.stringify(body) });

describe('FrankfurterGateway', () => {
  it('asks for one day, one base and the wanted currencies', async () => {
    const { g, calls } = gateway([ok({ amount: 1, base: 'EUR', date: '2026-11-13', rates: { GBP: 0.85, USD: 1.09 } })]);
    const a = await g.fetch('2026-11-14', 'EUR', ['GBP', 'USD', 'GBP']);
    expect(calls).toEqual(['https://rates.example/v1/2026-11-14?base=EUR&symbols=GBP,USD']);
    expect(a).toEqual({ rateDate: '2026-11-13', rates: { GBP: 0.85, USD: 1.09 } });
  });

  it('reports a currency that is left out of an answer as not published', async () => {
    const { g } = gateway([ok({ date: '2026-11-13', rates: { USD: 1.3 } })]);
    expect(await g.fetch('2026-11-13', 'GBP', ['USD', 'AED'])).toEqual({ rateDate: '2026-11-13', rates: { USD: 1.3, AED: null } });
  });

  it('treats a 404 as nothing published (an unsupported base or a day out of range)', async () => {
    const { g, calls } = gateway([{ status: 404, body: '{"message":"not found"}' }]);
    expect(await g.fetch('2026-11-13', 'AED', ['GBP'])).toEqual({ rateDate: null, rates: { GBP: null } });
    expect(calls).toHaveLength(1);
  });

  it('does not ask twice after a refusal, but tries again after a server error or a dropped connection', async () => {
    const refused = gateway([{ status: 422, body: '{"message":"invalid date"}' }, ok({ date: '2026-11-13', rates: { USD: 1 } })]);
    await expect(refused.g.fetch('2026-11-13', 'GBP', ['USD'])).rejects.toThrow(/refused/);
    expect(refused.calls).toHaveLength(1);
    const flaky = gateway([{ status: 503 }, ok({ date: '2026-11-13', rates: { USD: 1.3 } })]);
    expect((await flaky.g.fetch('2026-11-13', 'GBP', ['USD'])).rates.USD).toBe(1.3);
    const dropped = gateway([new Error('socket hang up'), ok({ date: '2026-11-13', rates: { USD: 1.3 } })]);
    expect((await dropped.g.fetch('2026-11-13', 'GBP', ['USD'])).rates.USD).toBe(1.3);
    const down = gateway([{ status: 500 }, { status: 502 }]);
    await expect(down.g.fetch('2026-11-13', 'GBP', ['USD'])).rejects.toThrow(/502/);
  });

  it('gives up on a source that does not answer in time', async () => {
    const { g } = gateway([{ status: 200, body: 'hang' }, { status: 200, body: 'hang' }], 20);
    await expect(g.fetch('2026-11-13', 'GBP', ['USD'])).rejects.toThrow(/aborted/);
  });

  it('refuses nonsense in an answer: wrong shape, too big, or rates that are not sensible numbers', async () => {
    await expect(gateway([ok({ nope: true }), ok({ nope: true })]).g.fetch('2026-11-13', 'GBP', ['USD'])).rejects.toThrow(/unexpected/);
    await expect(gateway([{ status: 200, body: 'x'.repeat(70_000) }, { status: 200, body: 'x'.repeat(70_000) }]).g.fetch('2026-11-13', 'GBP', ['USD'])).rejects.toThrow(/too much/);
    const a = await gateway([ok({ date: '2026-11-13', rates: { USD: -3, EUR: 0, CAD: 1e12, SEK: 11.5 } })]).g.fetch('2026-11-13', 'GBP', ['USD', 'EUR', 'CAD', 'SEK']);
    expect(a.rates).toEqual({ USD: null, EUR: null, CAD: null, SEK: 11.5 });
  });

  it('never puts anything but a day and capital-letter codes in the address', async () => {
    const { g, calls } = gateway([]);
    for (const [on, base, quotes] of [['2026-11-13/../x', 'GBP', ['USD']], ['2026-11-13', 'gbp', ['USD']], ['2026-11-13', 'GBP', ['USD&base=EUR']], ['2026-11-13', 'GBP', []], ['2026-11-13', 'GBP', ['GBP']]] as const) {
      await expect(g.fetch(on, base, [...quotes])).rejects.toThrow(/Not a currency pair/);
    }
    expect(calls).toEqual([]);
  });
});

describe('UnavailableGateway', () => {
  it('always fails, so lines wait for a rate', async () => {
    await expect(new UnavailableGateway().fetch()).rejects.toThrow(/switched off/);
  });
});
