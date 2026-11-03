import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, decodeProtectedHeader, JWTPayload, JWTVerifyGetKey, jwtVerify } from 'jose';
import { ENV, Env } from '../config/env';
import { ApiError } from '../common/api-error';
import type { AuthenticatedUser } from '../common/request-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verifies Supabase Auth access tokens: asymmetric signing keys via the project's JWKS endpoint,
 * or the legacy shared HS256 secret. Only end-user tokens (role "authenticated") are accepted.
 */
@Injectable()
export class JwtVerifier {
  private readonly jwks?: JWTVerifyGetKey;
  private readonly secret?: Uint8Array;
  private readonly issuer?: string;
  private readonly audience: string;

  constructor(@Inject(ENV) env: Env) {
    if (env.SUPABASE_URL) {
      this.jwks = createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', env.SUPABASE_URL));
    }
    if (env.SUPABASE_JWT_SECRET) this.secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
    this.issuer = env.JWT_ISSUER ?? (env.SUPABASE_URL ? new URL('/auth/v1', env.SUPABASE_URL).toString() : undefined);
    this.audience = env.JWT_AUDIENCE;
  }

  async verify(token: string): Promise<AuthenticatedUser> {
    let payload: JWTPayload;
    try {
      const { alg } = decodeProtectedHeader(token);
      const options = { issuer: this.issuer, audience: this.audience, clockTolerance: 5 };
      if (alg === 'HS256') {
        if (!this.secret) throw new Error('HS256 tokens are not accepted');
        ({ payload } = await jwtVerify(token, this.secret, { ...options, algorithms: ['HS256'] }));
      } else {
        if (!this.jwks) throw new Error('asymmetric tokens are not accepted');
        ({ payload } = await jwtVerify(token, this.jwks, { ...options, algorithms: ['RS256', 'ES256'] }));
      }
    } catch {
      throw ApiError.unauthenticated('Invalid or expired access token');
    }

    if (payload.role !== 'authenticated' || typeof payload.sub !== 'string' || !UUID.test(payload.sub)) {
      throw ApiError.unauthenticated('Token is not a signed-in user token');
    }
    return {
      id: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      claims: payload,
    };
  }
}
