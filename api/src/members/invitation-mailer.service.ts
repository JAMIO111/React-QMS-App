import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, Env } from '../config/env';

export type EmailOutcome =
  | { sent: true }
  | { sent: false; reason: 'not_configured' | 'existing_account' | 'send_failed' };

/**
 * Sends invitation emails through Supabase Auth's admin invite endpoint (creates the account and
 * emails a sign-up link). Optional: without SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY the invitation
 * is still created and the person can accept it after signing up. People who already have an
 * account are not emailed here; they see the invitation when they next sign in.
 * The service-role key is used only for this call and never leaves the server.
 */
@Injectable()
export class InvitationMailer {
  private readonly logger = new Logger(InvitationMailer.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  get configured(): boolean {
    return Boolean(this.env.SUPABASE_URL && this.env.SUPABASE_SERVICE_ROLE_KEY);
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
      if (res.status === 422) return { sent: false, reason: 'existing_account' };
      this.logger.warn({ status: res.status }, 'Invitation email was not sent');
      return { sent: false, reason: 'send_failed' };
    } catch (error) {
      this.logger.warn({ err: error }, 'Invitation email request failed');
      return { sent: false, reason: 'send_failed' };
    }
  }
}
