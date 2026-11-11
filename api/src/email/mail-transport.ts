import type { Env } from '../config/env';

/** One email, ready to send. */
export interface MailMessage {
  /** The outbox row's id: sent as the provider's idempotency key, so a retry after a lost answer never sends twice. */
  id: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * What became of one send:
 * - `sent`: the provider accepted it;
 * - `unsent`: there is no provider (outbox only) — final, kept as it would have been sent;
 * - `failed`: tried again later (`retry`), or not (a refusal that will not change, e.g. a bad address).
 */
export type MailOutcome =
  | { outcome: 'sent'; provider: string; messageId?: string }
  | { outcome: 'unsent'; provider: string; reason: string }
  | { outcome: 'failed'; provider: string; error: string; retry: boolean };

export abstract class MailTransport {
  abstract readonly name: string;
  abstract send(message: MailMessage): Promise<MailOutcome>;
}

/** No provider (decision E1): the email is built and queued exactly as it would be sent, then marked not sent. Nothing leaves the server. */
export class OutboxOnlyTransport extends MailTransport {
  readonly name = 'none';
  async send(): Promise<MailOutcome> {
    return { outcome: 'unsent', provider: this.name, reason: 'No mail provider is set up (MAIL_PROVIDER)' };
  }
}

/**
 * Resend's HTTPS API (https://resend.com/docs/api-reference/emails/send-email). The key stays on the server; the outbox id is the idempotency key.
 * 429 and 5xx are tried again; other refusals are reported with Resend's message and not retried.
 */
export class ResendTransport extends MailTransport {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
  }

  async send(message: MailMessage): Promise<MailOutcome> {
    let res: Response;
    try {
      res = await this.fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `fortress-${message.id}` },
        body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      return { outcome: 'failed', provider: this.name, error: `Resend could not be reached: ${(e as Error).message}`.slice(0, 500), retry: true };
    }
    let body: { id?: unknown; message?: unknown; name?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // judged by the status
    }
    if (res.ok) return { outcome: 'sent', provider: this.name, messageId: typeof body.id === 'string' ? body.id : undefined };
    const why = typeof body.message === 'string' ? body.message : typeof body.name === 'string' ? body.name : res.statusText;
    return { outcome: 'failed', provider: this.name, error: `Resend refused it (${res.status}): ${why}`.slice(0, 500), retry: res.status === 429 || res.status >= 500 };
  }
}

/** The transport the configuration asks for. */
export function mailTransportFor(env: Env, fetchImpl: typeof fetch = fetch): MailTransport {
  if (env.MAIL_PROVIDER === 'resend' && env.RESEND_API_KEY && env.MAIL_FROM) return new ResendTransport(env.RESEND_API_KEY, env.MAIL_FROM, fetchImpl);
  return new OutboxOnlyTransport();
}
