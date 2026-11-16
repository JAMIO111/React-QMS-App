import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ENV, Env } from '../config/env';
import { MailTransport } from '../email/mail-transport';

export type EmailOutcome =
  | { sent: true; kind?: 'sign_in_link' | 'company_sign_in' }
  | { sent: false; reason: 'not_configured' | 'existing_account' | 'send_failed' | 'company_sign_in' };

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

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

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Optional() private readonly transport?: MailTransport,
  ) {}

  /** Where someone at a single sign-on domain starts: the company sign-in page with their domain filled in. */
  companySignInUrl(domain: string): string | undefined {
    const base = this.env.APP_BASE_URL ?? this.env.INVITE_REDIRECT_URL;
    if (!base) return undefined;
    try {
      const url = new URL('/sso', base);
      url.searchParams.set('domain', domain);
      return url.toString();
    } catch {
      return undefined;
    }
  }

  /**
   * An invitation to someone who signs in with their company account (docs/sso-plan.md SS6): never a Supabase invitation, which would make a
   * password account beside the company one. A plain email through the mail provider says where to sign in; the invitation waits for them
   * (it is matched by email when they arrive). Without a provider, nothing is sent and they find it when they sign in.
   */
  async sendCompanySignIn(email: string, organisationName: string, domain: string): Promise<EmailOutcome> {
    const link = this.companySignInUrl(domain);
    if (!link || !this.transport || this.transport.name === 'none') return { sent: false, reason: 'company_sign_in' };
    const text = `You have been invited to ${organisationName} on Fortress QMS.\n\nSign in with your company account here: ${link}\n\nYour invitation will be waiting for you.`;
    const html = `<p>You have been invited to <strong>${escapeHtml(organisationName)}</strong> on Fortress QMS.</p><p><a href="${escapeHtml(link)}">Sign in with your company account</a>. Your invitation will be waiting for you.</p>`;
    try {
      const outcome = await this.transport.send({ id: randomUUID(), to: email, subject: `You are invited to ${organisationName} on Fortress QMS`, text, html });
      return outcome.outcome === 'sent' ? { sent: true, kind: 'company_sign_in' } : { sent: false, reason: 'company_sign_in' };
    } catch (error) {
      this.logger.warn({ err: error }, 'Company sign-in invitation email failed');
      return { sent: false, reason: 'company_sign_in' };
    }
  }

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
