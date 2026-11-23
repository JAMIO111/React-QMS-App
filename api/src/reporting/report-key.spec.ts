import { hashReportKey, looksLikeReportKey, makeReportKey, reportKeyFrom } from './report-key';

describe('report keys', () => {
  it('make a long random key, keep only a hash and a short prefix of it', () => {
    const a = makeReportKey();
    const b = makeReportKey();
    expect(a.secret).toMatch(/^fqr_[A-Za-z0-9_-]{43}$/);
    expect(looksLikeReportKey(a.secret)).toBe(true);
    expect(a.secret).not.toBe(b.secret);
    expect(a.hash).toBe(hashReportKey(a.secret));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.prefix).toBe(a.secret.slice(4, 12));
    expect(a.hash).not.toContain(a.secret);
  });

  it('are read from a Bearer header', () => {
    const { secret } = makeReportKey();
    expect(reportKeyFrom(`Bearer ${secret}`)).toBe(secret);
    expect(reportKeyFrom(`bearer ${secret}`)).toBe(secret);
  });

  it('are read from the password of a Basic header, whatever the user name', () => {
    const { secret } = makeReportKey();
    expect(reportKeyFrom(`Basic ${Buffer.from(`powerbi:${secret}`).toString('base64')}`)).toBe(secret);
    expect(reportKeyFrom(`Basic ${Buffer.from(`:${secret}`).toString('base64')}`)).toBe(secret);
    expect(reportKeyFrom(`Basic ${Buffer.from(`a:b:${secret}`).toString("base64")}`)).toBeNull(); // the first colon ends the user name, so this password is not a key
  });

  it('leave a person\'s token and anything else alone', () => {
    expect(reportKeyFrom(undefined)).toBeNull();
    expect(reportKeyFrom('Bearer eyJhbGciOiJIUzI1NiJ9.e30.x')).toBeNull();
    expect(reportKeyFrom('Basic ' + Buffer.from('user:password').toString('base64'))).toBeNull();
    expect(reportKeyFrom('Basic ' + Buffer.from('no-colon-fqr_x').toString('base64'))).toBeNull();
    expect(reportKeyFrom('Digest abc')).toBeNull();
  });

  it('refuse a key that is the wrong shape', () => {
    expect(looksLikeReportKey('fqr_short')).toBe(false);
    expect(looksLikeReportKey('x'.repeat(47))).toBe(false);
    expect(looksLikeReportKey(`fqr_${'a'.repeat(44)}`)).toBe(false);
  });
});
