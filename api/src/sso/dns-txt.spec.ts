import { checkVerificationRecord, DnsTxtResolver, verificationValue } from './dns-txt';

class Answer extends DnsTxtResolver {
  constructor(private readonly records: string[] | { code: string }) {
    super();
  }
  async txt() {
    if (Array.isArray(this.records)) return this.records;
    throw Object.assign(new Error('dns'), this.records);
  }
}

const TOKEN = '0123456789abcdef0123456789abcdef';

describe('checkVerificationRecord', () => {
  it('finds the record among others, ignoring case and spaces around it', async () => {
    const r = await checkVerificationRecord(new Answer(['v=spf1 -all', `  ${verificationValue(TOKEN).toUpperCase()} `]), 'acme.test', TOKEN);
    expect(r).toEqual({ found: true, error: null });
  });

  it('a different token is not enough, and says so', async () => {
    const r = await checkVerificationRecord(new Answer([verificationValue('f'.repeat(32))]), 'acme.test', TOKEN);
    expect(r.found).toBe(false);
    expect(r.error).toMatch(/not this one/);
  });

  it('a token inside a longer value does not count', async () => {
    const r = await checkVerificationRecord(new Answer([`x${verificationValue(TOKEN)}`, `${verificationValue(TOKEN)}x`]), 'acme.test', TOKEN);
    expect(r.found).toBe(false);
  });

  it('no record or no such name: not there yet', async () => {
    for (const code of ['ENODATA', 'ENOTFOUND']) {
      const r = await checkVerificationRecord(new Answer({ code }), 'acme.test', TOKEN);
      expect(r).toEqual({ found: false, error: expect.stringMatching(/No Fortress verification record was found at acme.test yet/) });
    }
    expect((await checkVerificationRecord(new Answer([]), 'acme.test', TOKEN)).error).toMatch(/yet/);
  });

  it('a lookup that fails says so, never throws', async () => {
    const r = await checkVerificationRecord(new Answer({ code: 'ETIMEOUT' }), 'acme.test', TOKEN);
    expect(r).toEqual({ found: false, error: expect.stringMatching(/did not answer \(ETIMEOUT\)/) });
  });
});
