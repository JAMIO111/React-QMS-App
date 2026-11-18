import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ENV, Env } from '../config/env';
import { renderBrandedEmail } from '../email/branded-email';
import { MailTransport } from '../email/mail-transport';

export type EmailOutcome =
  | { sent: true; kind?: 'sign_in_link' | 'company_sign_in' }
  | { sent: false; reason: 'not_configured' | 'existing_account' | 'send_failed' | 'company_sign_in' };

/** What the invitation says besides the organisation (all optional). */
export interface InviteEmailDetails {
  inviterName?: string | null;
  message?: string | null;
  roleName?: string | null;
  expiresAt?: string | null;
  /** Set for an external person (docs/external-portal-plan.md): the supplier or customer they act for. The email then invites them to the portal. */
  portalParty?: string | null;
}

type LinkType = 'invite' | 'magiclink';
const NEXT: Record<LinkType, string> = { invite: '/set-password?mode=invite', magiclink: '/accept-invite' };

/**
 * Invitation emails.
 *
 * **Every link lands on the app's confirm page (`/auth/confirm`), which uses the one-time token only when the person presses Continue.** Company
 * email security (Microsoft Defender Safe Links and the like) opens each link in an email before the person does; a link that used the token by
 * itself was used up by that check, and the person's own click then said "expired or already used" (seen live 2026-11-17).
 *
 * - **With a mail provider** (`MAIL_PROVIDER=resend`): the link is made with Supabase's admin `generate_link` (which sends nothing) and the API
 *   sends its own branded email from the organisation's sender (`MAIL_FROM`), with who invited them, their message, the role and the expiry.
 * - **Without one**: Supabase sends its own email (invite, or a sign-in link for an existing account) with `redirect_to` = the confirm page; the
 *   Supabase templates in `supabase/templates/` add the token to that address (see `docs/email-setup.md`). Until those templates are installed,
 *   Supabase's default link still works, but can be used up by link scanners.
 *
 * Optional throughout: without SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY the invitation is still created and the person accepts it after signing up.
 * The service-role key is used only for these calls and never leaves the server.
 */
@Injectable()
export class InvitationMailer {
  private readonly logger = new Logger(InvitationMailer.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Optional() private readonly transport?: MailTransport,
  ) {}

  get configured(): boolean {
    return Boolean(this.env.SUPABASE_URL && this.env.SUPABASE_SERVICE_ROLE_KEY);
  }

  /** The app's address: APP_BASE_URL, else the origin of INVITE_REDIRECT_URL. */
  appBase(): string | undefined {
    if (this.env.APP_BASE_URL) return this.env.APP_BASE_URL;
    if (!this.env.INVITE_REDIRECT_URL) return undefined;
    try {
      return new URL(this.env.INVITE_REDIRECT_URL).origin;
    } catch {
      return undefined;
    }
  }

  /** The confirm page, going on to `next`; with a token when the API made the link itself. */
  confirmUrl(next: string, token?: { hash: string; type: LinkType }): string | undefined {
    const base = this.appBase();
    if (!base) return undefined;
    try {
      const url = new URL('/auth/confirm', base);
      if (token) {
        url.searchParams.set('token_hash', token.hash);
        url.searchParams.set('type', token.type);
      }
      url.searchParams.set('next', next);
      return url.toString();
    } catch {
      return undefined;
    }
  }

  /** Where the sign-in link for an existing account leads (after the confirm page). */
  acceptUrl(): string | undefined {
    return this.confirmUrl(NEXT.magiclink);
  }

  /** Where someone at a single sign-on domain starts: the company sign-in page with their domain filled in. */
  companySignInUrl(domain: string): string | undefined {
    const base = this.appBase();
    if (!base) return undefined;
    try {
      const url = new URL('/sso', base);
      url.searchParams.set('domain', domain);
      return url.toString();
    } catch {
      return undefined;
    }
  }

  private get canSendOwn(): boolean {
    return Boolean(this.transport && this.transport.name !== 'none' && this.appBase());
  }

  /**
   * An invitation to someone who signs in with their company account (docs/sso-plan.md SS6): never a Supabase invitation, which would make a
   * password account beside the company one. A branded email through the mail provider says where to sign in; the invitation waits for them
   * (it is matched by email when they arrive). Without a provider, nothing is sent and they find it when they sign in.
   */
  async sendCompanySignIn(email: string, organisationName: string, domain: string, details: InviteEmailDetails = {}): Promise<EmailOutcome> {
    const link = this.companySignInUrl(domain);
    if (!link || !this.transport || this.transport.name === 'none') return { sent: false, reason: 'company_sign_in' };
    const who = details.inviterName?.trim() || null;
    const { html, text } = renderBrandedEmail({
      appBaseUrl: this.appBase(),
      preheader: `Sign in with your ${organisationName} account to join on Fortress QMS.`,
      heading: `Join ${organisationName} on Fortress QMS`,
      paragraphs: [
        `${who ?? `Someone at ${organisationName}`} has invited you to join ${organisationName} on Fortress QMS.`,
        `${organisationName} signs in with company accounts, so there is no new password to remember: sign in with your usual work account and your invitation will be waiting.`,
      ],
      quote: details.message ? { text: details.message, by: who } : null,
      facts: [
        ['Organisation', organisationName],
        ['Invited by', who],
        ['Role', details.roleName],
      ],
      button: { label: 'Sign in with your company account', url: link },
      notes: [`This invitation was sent to ${email}. If you weren't expecting it, you can ignore this email.`],
      footer: `You received this email because ${who ?? 'someone'} at ${organisationName} invited ${email} to Fortress QMS.`,
    });
    try {
      const outcome = await this.transport.send({ id: randomUUID(), to: email, subject: subjectFor(organisationName, who), text, html });
      return outcome.outcome === 'sent' ? { sent: true, kind: 'company_sign_in' } : { sent: false, reason: 'company_sign_in' };
    } catch (error) {
      this.logger.warn({ err: error }, 'Company sign-in invitation email failed');
      return { sent: false, reason: 'company_sign_in' };
    }
  }

  async send(email: string, organisationName: string, fetchImpl: typeof fetch = fetch, details: InviteEmailDetails = {}): Promise<EmailOutcome> {
    if (!this.configured) return { sent: false, reason: 'not_configured' };
    if (this.canSendOwn) return this.sendOwn(email, organisationName, details, fetchImpl);

    // Supabase sends the email; its template adds the token to redirect_to (the confirm page).
    const url = new URL('/auth/v1/invite', this.env.SUPABASE_URL);
    const redirect = this.confirmUrl(NEXT.invite) ?? this.env.INVITE_REDIRECT_URL;
    if (redirect) url.searchParams.set('redirect_to', redirect);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: this.headers(),
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

  private headers() {
    return { apikey: this.env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' };
  }

  /** An existing account: Supabase emails a sign-in link (its template points it at the confirm page). */
  private async signInLink(email: string, fetchImpl: typeof fetch): Promise<EmailOutcome> {
    const redirect = this.acceptUrl();
    if (!redirect) return { sent: false, reason: 'existing_account' };
    const url = new URL('/auth/v1/otp', this.env.SUPABASE_URL);
    url.searchParams.set('redirect_to', redirect);
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ email, create_user: false }) });
      return res.ok ? { sent: true, kind: 'sign_in_link' } : { sent: false, reason: 'existing_account' };
    } catch (error) {
      this.logger.warn({ err: error }, 'Sign-in link request failed');
      return { sent: false, reason: 'existing_account' };
    }
  }

  /** Asks Supabase for a one-time token without sending anything (admin generate_link). null + status when refused. */
  private async generate(type: LinkType, email: string, organisationName: string, fetchImpl: typeof fetch): Promise<{ hash: string | null; status: number }> {
    const res = await fetchImpl(new URL('/auth/v1/admin/generate_link', this.env.SUPABASE_URL), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        type,
        email,
        ...(type === 'invite' ? { data: { invited_to: organisationName } } : {}),
        redirect_to: this.confirmUrl(NEXT[type]),
      }),
    });
    if (!res.ok) return { hash: null, status: res.status };
    const body = (await res.json().catch(() => ({}))) as { hashed_token?: string; properties?: { hashed_token?: string } };
    return { hash: body.hashed_token ?? body.properties?.hashed_token ?? null, status: res.status };
  }

  /** The API's own branded email through the mail provider, with a link the API made. */
  private async sendOwn(email: string, organisationName: string, details: InviteEmailDetails, fetchImpl: typeof fetch): Promise<EmailOutcome> {
    let type: LinkType = 'invite';
    try {
      let made = await this.generate('invite', email, organisationName, fetchImpl);
      if (!made.hash && made.status === 422) {
        type = 'magiclink'; // they already have an account: a sign-in link, and the invitation waits on /accept-invite
        made = await this.generate('magiclink', email, organisationName, fetchImpl);
      }
      if (!made.hash) {
        this.logger.warn({ status: made.status, type }, 'Could not make an invitation link');
        return { sent: false, reason: type === 'magiclink' ? 'existing_account' : 'send_failed' };
      }
      const link = this.confirmUrl(NEXT[type], { hash: made.hash, type })!;
      const { html, text } = invitationEmail({ email, organisationName, details, link, existing: type === 'magiclink', appBaseUrl: this.appBase() });
      const outcome = await this.transport!.send({ id: randomUUID(), to: email, subject: subjectFor(organisationName, details.inviterName?.trim() || null, Boolean(details.portalParty)), text, html });
      if (outcome.outcome === 'sent') return type === 'magiclink' ? { sent: true, kind: 'sign_in_link' } : { sent: true };
      this.logger.warn({ outcome }, 'Invitation email was not sent');
      return { sent: false, reason: 'send_failed' };
    } catch (error) {
      this.logger.warn({ err: error }, 'Invitation email failed');
      return { sent: false, reason: 'send_failed' };
    }
  }
}

const subjectFor = (organisationName: string, who: string | null, portal = false) =>
  portal
    ? `${who ?? organisationName} invited you to the ${organisationName} supplier and customer portal`
    : who ? `${who} invited you to join ${organisationName} on Fortress QMS` : `You're invited to join ${organisationName} on Fortress QMS`;

const longDate = (iso?: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

/** The invitation itself, for a new person (set a password) or someone who already has a Fortress QMS account (sign in). */
export function invitationEmail(input: { email: string; organisationName: string; details: InviteEmailDetails; link: string; existing: boolean; appBaseUrl?: string }) {
  const { email, organisationName: org, details, link, existing } = input;
  const who = details.inviterName?.trim() || null;
  const expires = longDate(details.expiresAt);
  if (details.portalParty) {
    return renderBrandedEmail({
      appBaseUrl: input.appBaseUrl,
      preheader: `Accept your invitation to the ${org} portal for ${details.portalParty}.`,
      heading: `${org} has invited you to its portal`,
      paragraphs: [
        `${who ?? `Someone at ${org}`} has invited you to the ${org} portal on Fortress QMS, on behalf of ${details.portalParty}. There you can see and respond to the quality matters ${org} shares with ${details.portalParty}.`,
        existing
          ? 'You already have a Fortress QMS account, so there is nothing to set up: sign in and accept the invitation.'
          : 'Accept the invitation to set your password. It takes less than a minute.',
      ],
      quote: details.message ? { text: details.message, by: who } : null,
      facts: [
        ['Portal of', org],
        ['For', details.portalParty],
        ['Invited by', who],
        ['Invitation expires', expires],
      ],
      button: { label: existing ? 'Sign in and accept' : 'Accept invitation', url: link },
      notes: [
        `This invitation was sent to ${email}. If you weren't expecting it, you can ignore this email: nothing is set up until you accept.`,
        `For your security the link works once. If it has expired, ask ${who ?? 'the person who invited you'} to send it again.`,
      ],
      footer: `You received this email because ${who ?? 'someone'} at ${org} invited ${email} to the ${org} portal on Fortress QMS.`,
    });
  }
  return renderBrandedEmail({
    appBaseUrl: input.appBaseUrl,
    preheader: existing ? `Sign in to accept your invitation to ${org}.` : `Accept your invitation to ${org} and set your password.`,
    heading: `Join ${org} on Fortress QMS`,
    paragraphs: [
      `${who ?? `Someone at ${org}`} has invited you to join ${org} on Fortress QMS, where the team manages non-conformances, audits, documents and quality records.`,
      existing
        ? 'You already have a Fortress QMS account, so there is nothing to set up: sign in and accept the invitation.'
        : 'Accept the invitation to set your password. It takes less than a minute.',
    ],
    quote: details.message ? { text: details.message, by: who } : null,
    facts: [
      ['Organisation', org],
      ['Invited by', who],
      ['Role', details.roleName],
      ['Invitation expires', expires],
    ],
    button: { label: existing ? 'Sign in and accept' : 'Accept invitation', url: link },
    notes: [
      `This invitation was sent to ${email}. If you weren't expecting it, you can ignore this email: nothing is set up until you accept.`,
      `For your security the link works once. If it has expired, ask ${who ?? 'the person who invited you'} to send it again.`,
    ],
    footer: `You received this email because ${who ?? 'someone'} at ${org} invited ${email} to Fortress QMS.`,
  });
}
