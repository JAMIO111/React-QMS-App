import { generateKeyPair, SignJWT } from 'jose';
import { ApiError } from '../common/api-error';
import { loadEnv } from '../config/env';
import { JwtVerifier } from './jwt-verifier.service';

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const USER = '0f4f2a3e-8c3b-4f7a-9d5e-1a2b3c4d5e6f';

const verifier = new JwtVerifier(
  loadEnv({ DATABASE_URL: 'postgres://x', SUPABASE_JWT_SECRET: SECRET, JWT_ISSUER: 'test-issuer' }),
);

const sign = (claims: Record<string, unknown>, opts: { secret?: string; exp?: string; iss?: string; aud?: string } = {}) =>
  new SignJWT({ role: 'authenticated', email: 'a@example.test', ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject((claims.sub as string) ?? USER)
    .setIssuer(opts.iss ?? 'test-issuer')
    .setAudience(opts.aud ?? 'authenticated')
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(new TextEncoder().encode(opts.secret ?? SECRET));

const rejects = async (token: Promise<string> | string) => {
  await expect(verifier.verify(await token)).rejects.toMatchObject({ code: 'unauthenticated' } satisfies Partial<ApiError>);
};

describe('JwtVerifier', () => {
  it('accepts a signed-in user token and exposes id, email and claims', async () => {
    const user = await verifier.verify(await sign({}));
    expect(user).toMatchObject({ id: USER, email: 'a@example.test' });
    expect(user.claims.role).toBe('authenticated');
  });

  it('rejects a wrong signature', () => rejects(sign({}, { secret: 'another-secret-that-is-at-least-32-characters' })));
  it('rejects an expired token', () => rejects(sign({}, { exp: '-1m' })));
  it('rejects the wrong issuer', () => rejects(sign({}, { iss: 'someone-else' })));
  it('rejects the wrong audience', () => rejects(sign({}, { aud: 'service' })));
  it('rejects service_role tokens', () => rejects(sign({ role: 'service_role' })));
  it('rejects anon tokens', () => rejects(sign({ role: 'anon' })));
  it('rejects a non-UUID subject', () => rejects(sign({ sub: 'not-a-uuid' })));
  it('rejects garbage', () => rejects('not.a.token'));

  it('rejects asymmetric tokens when no JWKS is configured', async () => {
    const { privateKey } = await generateKeyPair('ES256');
    const token = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(USER)
      .setIssuer('test-issuer')
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(privateKey);
    await rejects(token);
  });
});
