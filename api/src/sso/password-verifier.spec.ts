import { loadEnv } from '../config/env';
import { PasswordCheckUnavailable, SupabasePasswordVerifier } from './password-verifier';

const env = loadEnv({ DATABASE_URL: 'postgres://x', SUPABASE_JWT_SECRET: 'x'.repeat(40), SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-value' });

describe('SupabasePasswordVerifier', () => {
  it('answers the account id for the right password, and closes the session the check opened', async () => {
    const v = new SupabasePasswordVerifier(env);
    const calls: string[] = [];
    v.fetchImpl = (async (url: URL | string) => {
      calls.push(String(url));
      if (String(url).includes('/token')) return new Response(JSON.stringify({ access_token: 'tok', user: { id: 'u-1' } }), { status: 200 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    await expect(v.verify('a@acme.test', 'right')).resolves.toBe('u-1');
    expect(calls).toEqual(['https://p.supabase.co/auth/v1/token?grant_type=password', 'https://p.supabase.co/auth/v1/logout?scope=local']);
  });

  it('answers null for a wrong password', async () => {
    const v = new SupabasePasswordVerifier(env);
    v.fetchImpl = (async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as typeof fetch;
    await expect(v.verify('a@acme.test', 'wrong')).resolves.toBeNull();
  });

  it('says when it cannot check', async () => {
    const off = new SupabasePasswordVerifier(loadEnv({ DATABASE_URL: 'postgres://x', SUPABASE_JWT_SECRET: 'x'.repeat(40) }));
    expect(off.enabled).toBe(false);
    await expect(off.verify('a@acme.test', 'x')).rejects.toBeInstanceOf(PasswordCheckUnavailable);
    const v = new SupabasePasswordVerifier(env);
    v.fetchImpl = (async () => new Response('', { status: 500 })) as typeof fetch;
    await expect(v.verify('a@acme.test', 'x')).rejects.toBeInstanceOf(PasswordCheckUnavailable);
  });
});
