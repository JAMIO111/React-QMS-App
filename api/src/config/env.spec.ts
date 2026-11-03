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
});
