import { CallHandler, ExecutionContext, Inject, Injectable, Logger, NestInterceptor, OnModuleDestroy } from '@nestjs/common';
import { waitUntil } from '@vercel/functions';
import { Observable, tap } from 'rxjs';
import { ENV, Env } from '../config/env';
import { DatabaseService } from '../database/database.service';
import { EmailRow, renderNotificationEmail } from './email-content';
import { MailTransport } from './mail-transport';

export interface DrainResult {
  queued: number;
  sent: number;
  unsent: number;
  failed: number;
  retrying: number;
  /** True when the time allowed ran out with emails still due (the next call or the cron carries on). */
  more: boolean;
}

/**
 * Email notifications (docs/email-oauth-plan.md, E3): the queue is worked right after the request that caused it, and by the cron. Everything that decides who
 * gets what is in the database (`app.system_queue_notification_emails`); this only renders and hands each email to the transport, then records the outcome.
 * Runs as the API login: it never reads business data beyond what the lease returns.
 */
@Injectable()
export class EmailService implements OnModuleDestroy {
  private readonly log = new Logger(EmailService.name);
  private running: Promise<void> | null = null;
  private again = false;
  /** Kick after requests: on everywhere except the test suite (tests switch it on where they mean to), so a background drain never outlives a test's database. */
  autoKick: boolean;

  constructor(
    private readonly database: DatabaseService,
    private readonly transport: MailTransport,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.autoKick = env.NODE_ENV !== 'test';
  }

  async onModuleDestroy(): Promise<void> {
    await this.settled();
  }

  /** Fan out new notices, then send what is due, until nothing is left or `budgetMs` has passed. Safe to call as often as you like, from anywhere. */
  async drain(options: { budgetMs?: number; batch?: number; correlationId?: string } = {}): Promise<DrainResult> {
    const started = Date.now();
    const budget = Math.min(Math.max(options.budgetMs ?? 20_000, 500), 55_000);
    const batch = Math.min(Math.max(options.batch ?? 25, 1), 100);
    const out: DrainResult = { queued: 0, sent: 0, unsent: 0, failed: 0, retrying: 0, more: false };
    out.queued = await this.database.asApi(
      async (c) => Number((await c.query('select app.system_queue_notification_emails(500) as n')).rows[0].n),
      options.correlationId ?? '',
      'email',
    );
    for (;;) {
      if (Date.now() - started > budget) {
        out.more = true;
        break;
      }
      const rows = await this.database.asApi(
        async (c) => (await c.query('select * from app.system_lease_emails($1::int, $2::int)', [batch, 120])).rows as EmailRow[],
        options.correlationId ?? '',
        'email',
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        const content = renderNotificationEmail(row, this.env.APP_BASE_URL);
        let result;
        try {
          result = await this.transport.send({ id: row.id, to: row.to_address, subject: content.subject, text: content.text, html: content.html });
        } catch (e) {
          result = { outcome: 'failed' as const, provider: this.transport.name, error: (e as Error).message.slice(0, 500), retry: true };
        }
        const outcome = result.outcome === 'failed' ? (result.retry ? 'failed' : 'refused') : result.outcome;
        const status = await this.database.asApi(
          async (c) =>
            (
              await c.query('select app.system_finish_email($1::uuid, $2, $3, $4, $5) as s', [
                row.id,
                outcome,
                result.provider,
                result.outcome === 'sent' ? (result.messageId ?? null) : null,
                result.outcome === 'failed' ? result.error : result.outcome === 'unsent' ? result.reason : null,
              ])
            ).rows[0].s as string,
          options.correlationId ?? '',
          'email',
        );
        if (status === 'sent') out.sent += 1;
        else if (status === 'unsent') out.unsent += 1;
        else if (status === 'failed') out.failed += 1;
        else out.retrying += 1;
      }
    }
    return out;
  }

  /**
   * Work the queue soon, without holding up the caller: one drain at a time in this process (a kick while one runs asks for another pass afterwards).
   * On Vercel the work is registered with `waitUntil`, so it finishes after the response is sent; elsewhere it simply runs in the background.
   */
  kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    const work = (async () => {
      do {
        this.again = false;
        await this.drain({ budgetMs: 10_000 });
      } while (this.again);
    })()
      .catch((e: unknown) => this.log.warn(`Email drain failed: ${(e as Error).message}`))
      .finally(() => {
        this.running = null;
      });
    this.running = work;
    try {
      waitUntil(work);
    } catch {
      // not on Vercel: the promise runs on its own
    }
  }

  /** For tests: wait for a kicked drain to finish. */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }
}

/** After every request that may have changed something (anything but GET / HEAD / OPTIONS) and succeeded, kick the email queue. */
@Injectable()
export class EmailKickInterceptor implements NestInterceptor {
  constructor(private readonly email: EmailService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const method = context.getType() === 'http' ? (context.switchToHttp().getRequest<{ method?: string }>().method ?? 'GET') : 'GET';
    if (!this.email.autoKick || ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return next.handle();
    return next.handle().pipe(tap({ complete: () => this.email.kick() }));
  }
}
