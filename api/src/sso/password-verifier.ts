import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, Env } from '../config/env';

/**
 * Checks an email address and password against Supabase Auth, for someone who signed in with their company account and wants to move their
 * old password account across (docs/sso-plan.md SS5). Answers the password account's user id, or null when the address and password do not
 * match. The session Supabase opens for the check is signed out at once. Tests substitute a fake.
 */
export abstract class PasswordVerifier {
  abstract get enabled(): boolean;
  abstract verify(email: string, password: string): Promise<string | null>;
}

export class PasswordCheckUnavailable extends Error {}

@Injectable()
export class SupabasePasswordVerifier extends PasswordVerifier {
  private readonly log = new Logger(SupabasePasswordVerifier.name);

  /** Replaced in unit tests. */
  fetchImpl: typeof fetch = (...args) => fetch(...args);

  constructor(@Inject(ENV) private readonly env: Env) {
    super();
  }

  get enabled() {
    return Boolean(this.env.SUPABASE_URL && this.env.SUPABASE_SERVICE_ROLE_KEY);
  }

  async verify(email: string, password: string): Promise<string | null> {
    if (!this.enabled) throw new PasswordCheckUnavailable('Passwords cannot be checked on this server');
    const base = this.env.SUPABASE_URL!;
    const key = this.env.SUPABASE_SERVICE_ROLE_KEY!;
    let res: Response;
    try {
      res = await this.fetchImpl(new URL('/auth/v1/token?grant_type=password', base), {
        method: 'POST',
        headers: { apikey: key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      throw new PasswordCheckUnavailable(`The sign-in service could not be reached: ${(e as Error).message}`);
    }
    if (res.status === 400 || res.status === 401 || res.status === 422) return null;
    if (!res.ok) throw new PasswordCheckUnavailable(`The sign-in service answered ${res.status}`);
    const body = (await res.json().catch(() => null)) as { access_token?: string; user?: { id?: string } } | null;
    const id = body?.user?.id ?? null;
    if (body?.access_token) {
      // Only the check was wanted: close the session the check opened.
      await this.fetchImpl(new URL('/auth/v1/logout?scope=local', base), {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${body.access_token}` },
        signal: AbortSignal.timeout(5000),
      }).catch((e) => this.log.warn(`Could not close the checking session: ${(e as Error).message}`));
    }
    return id;
  }
}
