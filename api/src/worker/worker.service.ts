import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { EmailService } from '../email/email.service';
import { CronService } from '../cron/cron.service';
import { PermanentJobError, WorkerJobRegistry } from './job-registry';
import { RemindersService } from '../reminders/reminders.service';
import { WorkflowEngine } from '../workflows/workflow-engine';
import { SupplierPerformanceService } from '../supplier-quality/supplier-performance.service';

export type TickSource = 'pg_cron' | 'vercel' | 'manual' | 'test';

export interface TickStep {
  name: string;
  ok: boolean;
  ms: number;
  result?: unknown;
  error?: string;
}

export interface TickOutcome {
  tickId: number;
  skipped: boolean;
  outcome: 'done' | 'partial' | 'error' | 'skipped';
  ms: number;
  steps: TickStep[];
}

export interface JobsResult {
  leased: number;
  done: number;
  retrying: number;
  failed: number;
}

const MAX_BUDGET = 50_000;

/**
 * The background worker (docs/workflow-engine-plan.md, WK1). Something calls `tick()` every minute: pg_cron in Supabase through pg_net (W1), or by hand.
 * One tick works at a time (a database lease); a tick that finds another still working is recorded as skipped and returns at once.
 *
 * Each tick, within its time budget, in this order: quality alerts past their expiry date expire; approved document revisions whose day has come take
 * effect; organisations whose reminder time has come get today's reminders (WK2); scheduled supplier scorecards are saved for periods that have ended (SQ5b); due background jobs run; email is fanned out and sent; import runs that are waiting are worked. Every step is on its own: one that fails is
 * recorded and the others still run. A later always-on worker would call `tick()` in a loop; nothing here assumes Vercel.
 */
@Injectable()
export class WorkerService {
  private readonly log = new Logger(WorkerService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly email: EmailService,
    private readonly cron: CronService,
    private readonly jobs: WorkerJobRegistry,
    private readonly reminders: RemindersService,
    private readonly workflows: WorkflowEngine,
    private readonly scorecards: SupplierPerformanceService,
  ) {}

  async tick(options: { source: TickSource; budgetMs?: number; correlationId?: string }): Promise<TickOutcome> {
    const started = Date.now();
    const budget = Math.min(Math.max(options.budgetMs ?? 45_000, 1_000), MAX_BUDGET);
    const stopAt = started + budget;
    const correlationId = options.correlationId || `tick-${randomUUID()}`;
    const left = () => stopAt - Date.now();

    const begun = await this.database.asApi(
      async (c) => (await c.query(`select tick_id, acquired from app.system_worker_begin($1, $2::int)`, [options.source, Math.ceil(budget / 1000) + 30])).rows[0] as { tick_id: string; acquired: boolean },
      correlationId,
      'worker',
    );
    const tickId = Number(begun.tick_id);
    if (!begun.acquired) return { tickId, skipped: true, outcome: 'skipped', ms: Date.now() - started, steps: [] };

    const steps: TickStep[] = [];
    const step = async (name: string, work: () => Promise<unknown>, minimumMs = 1_000) => {
      if (left() < minimumMs) {
        steps.push({ name, ok: true, ms: 0, result: { skipped: 'out of time' } });
        return;
      }
      const t = Date.now();
      try {
        const result = await work();
        steps.push({ name, ok: true, ms: Date.now() - t, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        this.log.warn(`Worker step ${name} failed: ${message}`);
        steps.push({ name, ok: false, ms: Date.now() - t, error: message.slice(0, 300) });
      }
    };

    await step('quality-alerts', () => this.cron.expireQualityAlerts(correlationId));
    await step('documents', () => this.cron.settleDocuments(correlationId));
    await step('reminders', () => this.reminders.runDaily(correlationId), 3_000);
    await step('scorecards', () => this.scorecards.runSchedule(correlationId), 3_000);
    await step('workflows', () => this.workflows.consume(correlationId, Math.min(stopAt - 12_000, Date.now() + 10_000)), 3_000);
    await step('jobs', () => this.runJobs(correlationId, stopAt - 8_000), 3_000);
    await step('email', () => this.email.drain({ budgetMs: Math.min(15_000, left() - 2_000), correlationId }), 3_000);
    await step('imports', () => this.cron.integrationRuns(10, correlationId, Math.min(25_000, left() - 2_000)), 4_000);

    // Partial when a step failed; error when every step that ran failed.
    const failed = steps.filter((s) => !s.ok);
    const ran = steps.filter((s) => !s.ok || !(s.result as { skipped?: string } | undefined)?.skipped);
    const outcome: TickOutcome['outcome'] = !failed.length ? 'done' : failed.length === ran.length ? 'error' : 'partial';
    await this.database
      .asApi(
        (c) =>
          c.query(`select app.system_worker_end($1::bigint, $2, $3::jsonb, $4)`, [
            tickId,
            outcome,
            JSON.stringify(steps),
            failed.length ? failed.map((s) => `${s.name}: ${s.error}`).join('; ') : null,
          ]),
        correlationId,
        'worker',
      )
      .catch((e: unknown) => this.log.error(`Could not end tick ${tickId}: ${(e as Error).message}`));
    return { tickId, skipped: false, outcome, ms: Date.now() - started, steps };
  }

  /** Runs due jobs, a batch at a time, until none are due or `stopAt` comes. A job that throws is tried again later; one with no handler fails at once. */
  async runJobs(correlationId: string, stopAt: number): Promise<JobsResult> {
    const out: JobsResult = { leased: 0, done: 0, retrying: 0, failed: 0 };
    while (Date.now() < stopAt) {
      const batch = await this.database.asApi(
        async (c) =>
          (await c.query(`select id, organisation_id, kind, payload, attempts, max_attempts from app.system_lease_jobs(10, 120)`)).rows as {
            id: string;
            organisation_id: string | null;
            kind: string;
            payload: Record<string, unknown>;
            attempts: number;
            max_attempts: number;
          }[],
        correlationId,
        'worker',
      );
      if (!batch.length) break;
      out.leased += batch.length;
      for (const row of batch) {
        const handler = this.jobs.get(row.kind);
        let ok = false;
        let retry = true;
        let result: unknown = null;
        let error: string | null = null;
        if (!handler) {
          retry = false;
          error = `No handler for job kind ${row.kind}`;
        } else if (Date.now() >= stopAt) {
          error = 'The tick ran out of time before this job started';
        } else {
          try {
            result =
              (await handler({
                id: row.id,
                organisationId: row.organisation_id,
                kind: row.kind,
                payload: row.payload ?? {},
                attempt: row.attempts,
                maxAttempts: row.max_attempts,
                correlationId,
              })) ?? null;
            ok = true;
          } catch (e) {
            retry = !(e instanceof PermanentJobError);
            error = e instanceof Error ? e.message : 'unknown error';
          }
        }
        const status = await this.database.asApi(
          async (c) =>
            (await c.query(`select app.system_finish_job($1::uuid, $2, $3::jsonb, $4, $5) as s`, [row.id, ok, result === null ? null : JSON.stringify(result), error, retry])).rows[0]
              .s as string,
          correlationId,
          'worker',
        );
        if (status === 'done') out.done += 1;
        else if (status === 'queued') out.retrying += 1;
        else if (status === 'failed') out.failed += 1;
      }
    }
    return out;
  }

  /** Puts a job on the queue (the same idempotency key never queues twice). For modules that need work done in the background. */
  async enqueue(kind: string, payload: Record<string, unknown>, options: { organisationId?: string | null; idempotencyKey?: string; runAt?: Date; maxAttempts?: number } = {}): Promise<string> {
    return this.database.asApi(
      async (c) =>
        (
          await c.query(`select app.system_enqueue_job($1, $2::jsonb, $3::uuid, $4, $5::timestamptz, $6::int) as id`, [
            kind,
            JSON.stringify(payload ?? {}),
            options.organisationId ?? null,
            options.idempotencyKey ?? null,
            options.runAt?.toISOString() ?? null,
            options.maxAttempts ?? 5,
          ])
        ).rows[0].id as string,
      '',
      'worker',
    );
  }
}
