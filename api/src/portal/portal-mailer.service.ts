import { randomUUID } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { renderBrandedEmail } from '../email/branded-email';
import { MailTransport } from '../email/mail-transport';
import { InvitationMailer } from '../members/invitation-mailer.service';

export interface PortalEmail {
  to: Array<{ email: string; name?: string | null }>;
  subject: string;
  heading: string;
  paragraphs: string[];
  quote?: { text: string; by?: string | null };
  /** An address inside the app, such as /portal/shared/<id>?org=<id>. */
  path: string;
  button: string;
  footerWho: string;
}

/**
 * Emails to external people about what is shared with them (docs/external-portal-plan.md PT2). Sent straight after the action, best effort: a failed
 * or unconfigured send never undoes the share or the comment (the person still finds it on their portal home). The transport is the one notification
 * email uses (MAIL_PROVIDER); with none set nothing leaves the server.
 */
@Injectable()
export class PortalMailer {
  private readonly log = new Logger(PortalMailer.name);

  constructor(
    private readonly invitations: InvitationMailer,
    @Optional() private readonly transport?: MailTransport,
  ) {}

  async send(email: PortalEmail): Promise<{ attempted: number; sent: number }> {
    const base = this.invitations.appBase();
    if (!this.transport || this.transport.name === 'none' || !base || email.to.length === 0) return { attempted: 0, sent: 0 };
    let url: string;
    try {
      url = new URL(email.path, base).toString();
    } catch {
      return { attempted: 0, sent: 0 };
    }
    let sent = 0;
    for (const person of email.to) {
      const { html, text } = renderBrandedEmail({
        appBaseUrl: base,
        preheader: email.heading,
        heading: email.heading,
        paragraphs: email.paragraphs,
        quote: email.quote ? { text: email.quote.text, by: email.quote.by ?? null } : null,
        button: { label: email.button, url },
        notes: [`This email was sent to ${person.email} because you have access to this portal. You can sign in to see everything shared with you.`],
        footer: `You received this email because ${email.footerWho} uses Fortress QMS to share quality matters with you.`,
      });
      try {
        const outcome = await this.transport.send({ id: randomUUID(), to: person.email, subject: email.subject, text, html });
        if (outcome.outcome === 'sent') sent += 1;
      } catch (error) {
        this.log.warn({ err: error }, 'Portal email failed');
      }
    }
    return { attempted: email.to.length, sent };
  }
}
