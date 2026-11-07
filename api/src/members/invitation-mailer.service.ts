import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, Env } from '../config/env';

export type EmailOutcome =
  | { sent: true; kind?: 'sign_in_link' }
  | { sent: false; reason: 'not_configured' | 'existing_account' | 'send_failed' };

/**
 * Sends invitation emails through Supabase Auth's admin invite endpoint (creates the account and
 * emails a sign-up link). Optional: without SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY the invitation
 * is still created and the person can accept it after signing up. People who already have an
 * account get a Supabase sign-in link that lands on /accept-invite (APP_BASE_URL, else beside INVITE_REDIRECT_URL); without one to send they see the invitation when they next sign in.
 * The service-role key is used only for this call and never leaves the server.
 */
@Injectable()
export class InvitationMailer {
  private readonly logger = new Logger(InvitationMailer.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  get configured(): boolean {
    return Boolean(this.env.SUPABASE_URL && this.env.SUPABASE_SERVICE_ROLE_KEY);
  }

  /** Where the sign-in link for an existing account leads. */
  acceptUrl(): string | undefined {
    const base = this.env.APP_BASE_URL ?? this.env.INVITE_REDIRECT_URL;
    if (!base) return undefined;
    try {
      return new URL('/accept-invite', base).toString();
    } catch {
      return undefined;
    }
  }

  private async signInLink(email: string, fetchImpl: typeof fetch): Promise<EmailOutcome> {
    const redirect = this.acceptUrl();
    if (!redirect) return { sent: false, reason: 'existing_account' };
    const url = new URL('/auth/v1/otp', this.env.SUPABASE_URL);
    url.searchParams.set('redirect_to', redirect);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { apikey: this.env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, create_user: false }),
      });
      return res.ok ? { sent: true, kind: 'sign_in_link' } : { sent: false, reason: 'existing_account' };
    } catch (error) {
      this.logger.warn({ err: error }, 'Sign-in link request failed');
      return { sent: false, reason: 'existing_account' };
    }
  }

  async send(email: string, organisationName: string, fetchImpl: typeof fetch = fetch): Promise<EmailOutcome> {
    if (!this.configured) return { sent: false, reason: 'not_configured' };
    const url = new URL('/auth/v1/invite', this.env.SUPABASE_URL);
    if (this.env.INVITE_REDIRECT_URL) url.searchParams.set('redirect_to', this.env.INVITE_REDIRECT_URL);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          apikey: this.env.SUPABASE_SERVICE_ROLE_KEY!,
          Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, data: { invited_to: organisationName } }),
      });
      if (res.ok) return { sent: true };
      if (res.status === 422) return this.signInLink(email, fetchImpl);
      this.logger.warn({ status: res.status }, 'Invitation email was not sent');
      return { sent: false, reason: 'send_failed' };
    } catch (error) {
      this.logger.warn({ err: error }, 'Invitation email request failed');
      return { sent: false, reason: 'send_failed' };
    }
  }
}
