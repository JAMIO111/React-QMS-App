import { corsOrigins, loadEnv } from './env';

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv({ DATABASE_URL: 'postgres://x', SUPABASE_URL: 'https://p.supabase.co' });
    expect(env).toMatchObject({ PORT: 3001, JWT_AUDIENCE: 'authenticated', RATE_LIMIT_PER_MINUTE: 300 });
  });

  it('requires a database URL and a way to verify tokens', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
    expect(() => loadEnv({ DATABASE_URL: 'postgres://x' })).toThrow(/SUPABASE_URL .* SUPABASE_JWT_SECRET/);
  });

  it('treats empty strings as unset and never echoes secret values', () => {
    const secret = 'short';
    expect(() => loadEnv({ DATABASE_URL: 'postgres://x', SUPABASE_JWT_SECRET: secret })).toThrow();
    try {
      loadEnv({ DATABASE_URL: 'postgres://x', SUPABASE_JWT_SECRET: secret });
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
    expect(loadEnv({ DATABASE_URL: 'postgres://x', SUPABASE_URL: 'https://p.supabase.co', SUPABASE_JWT_SECRET: '' }).SUPABASE_JWT_SECRET).toBeUndefined();
  });

  it('splits CORS origins', () => {
    const env = loadEnv({ DATABASE_URL: 'x', SUPABASE_URL: 'https://p.supabase.co', CORS_ORIGINS: 'http://a, https://b ,' });
    expect(corsOrigins(env)).toEqual(['http://a', 'https://b']);
  });

  it('turns * in a CORS origin into a single-label wildcard', () => {
    const env = loadEnv({ DATABASE_URL: 'x', SUPABASE_URL: 'https://p.supabase.co', CORS_ORIGINS: 'https://qms-web-*.vercel.app' });
    const [pattern] = corsOrigins(env) as RegExp[];
    expect(pattern.test('https://qms-web-git-dev-jamie.vercel.app')).toBe(true);
    expect(pattern.test('https://qms-web-abc123.vercel.app')).toBe(true);
    expect(pattern.test('https://qms-web-x.evil.com/.vercel.app')).toBe(false);
    expect(pattern.test('https://qms-web-a.b.vercel.app')).toBe(false);
    expect(pattern.test('https://qms-web-xvercel.app')).toBe(false);
  });

  it('keeps email in the outbox unless Resend is fully set up, and never echoes the key', () => {
    const base = { DATABASE_URL: 'postgres://x', SUPABASE_URL: 'https://p.supabase.co' };
    expect(loadEnv(base).MAIL_PROVIDER).toBe('none');
    expect(() => loadEnv({ ...base, MAIL_PROVIDER: 'resend' })).toThrow(/RESEND_API_KEY and MAIL_FROM/);
    const ok = loadEnv({ ...base, MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_abcdefghij123', MAIL_FROM: 'Fortress QMS <alerts@example.com>' });
    expect(ok).toMatchObject({ MAIL_PROVIDER: 'resend', MAIL_FROM: 'Fortress QMS <alerts@example.com>' });
    expect(loadEnv({ ...base, MAIL_FROM: 'alerts@example.com' }).MAIL_FROM).toBe('alerts@example.com');
    expect(() => loadEnv({ ...base, MAIL_FROM: 'not an address' })).toThrow(/MAIL_FROM/);
    expect(() => loadEnv({ ...base, MAIL_FROM: 'A <a@b.co>\r\nBcc: x@y.z' })).toThrow(/MAIL_FROM/);
    try {
      loadEnv({ ...base, RESEND_API_KEY: 'secret-value-not-resend' });
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-value-not-resend');
    }
  });

  it('takes an optional CRON_SECRET of at least 20 characters, and never echoes it', () => {
    const base = { DATABASE_URL: 'x', SUPABASE_URL: 'https://p.supabase.co' };
    expect(loadEnv(base).CRON_SECRET).toBeUndefined();
    expect(loadEnv({ ...base, CRON_SECRET: 'a'.repeat(24) }).CRON_SECRET).toBe('a'.repeat(24));
    expect(() => loadEnv({ ...base, CRON_SECRET: 'short-secret' })).toThrow(/CRON_SECRET/);
    try {
      loadEnv({ ...base, CRON_SECRET: 'short-secret' });
    } catch (e) {
      expect((e as Error).message).not.toContain('short-secret');
    }
  });
});
