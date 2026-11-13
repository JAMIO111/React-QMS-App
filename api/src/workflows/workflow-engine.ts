import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { PermanentJobError, WorkerJobRegistry } from '../worker/job-registry';
import { triggerFor } from './catalogue';
import { Conditions, evaluateConditions } from './conditions';
import type { Action, InnerAction } from './workflows.schemas';

export interface ConsumeResult {
  events: number;
  matched: number;
  actionsQueued: number;
}

const CONSUMER = 'workflows';

/**
 * The workflow engine (WF1). Each worker tick reads the outbox as the consumer "workflows" (every event once, from when the consumer was first used), finds
 * the active rules each event starts, evaluates their conditions against the record's facts (`app.system_workflow_facts`, read now), records a run for each
 * rule that matches (once per rule version and event) and queues one job per action. The job (`workflow.action`) sends the notices or gives the task, at most
 * once (the database refuses a second), and records the action's outcome on the run. A rule never raises, closes, approves or cancels anything.
 */
@Injectable()
export class WorkflowEngine implements OnModuleInit {
  private readonly log = new Logger(WorkflowEngine.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly jobs: WorkerJobRegistry,
  ) {}

  onModuleInit() {
    this.jobs.register('workflow.action', async (job) => {
      const runId = String(job.payload.runId ?? '');
      const index = Number(job.payload.index);
      const action = job.payload.action as Action | undefined;
      if (!runId || !Number.isInteger(index) || !action) throw new PermanentJobError('The job does not say which run and action');
      try {
        const result = await this.perform(runId, index, action, job.correlationId, undefined, job.organisationId);
        await this.done(runId, index, true, result, job.correlationId);
        return result;
      } catch (error) {
        // The last attempt records the failure on the run, so the run log shows it.
        if (error instanceof PermanentJobError || job.attempt >= job.maxAttempts) {
          await this.done(runId, index, false, { error: error instanceof Error ? error.message.slice(0, 300) : 'failed' }, job.correlationId).catch(() => undefined);
        }
        throw error;
      }
    });

    // A timer (WF3) runs at its time: it reads the record again, and does its actions only while the rule is on and the conditions still hold.
    this.jobs.register('workflow.timer', async (job) => {
      const runId = String(job.payload.runId ?? '');
      const index = Number(job.payload.index);
      const action = job.payload.action as Action | undefined;
      if (!runId || !Number.isInteger(index) || action?.type !== 'later') throw new PermanentJobError('The job does not say which run and timer');
      try {
        const result = await this.fire(runId, index, action, job.correlationId);
        await this.done(runId, index, !result.failed, result, job.correlationId);
        return result;
      } catch (error) {
        if (error instanceof PermanentJobError || job.attempt >= job.maxAttempts) {
          await this.done(runId, index, false, { fired: true, error: error instanceof Error ? error.message.slice(0, 300) : 'failed' }, job.correlationId).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  /** Reads and handles new events until none are left or `stopAt` comes. */
  async consume(correlationId: string, stopAt: number): Promise<ConsumeResult> {
    const out: ConsumeResult = { events: 0, matched: 0, actionsQueued: 0 };
    while (Date.now() < stopAt) {
      const events = await this.database.asApi(
        async (c) =>
          (
            await c.query(
              `select id::text as id, organisation_id, event_type, entity_type, entity_id, payload from app.system_outbox_read($1, 100)`,
              [CONSUMER],
            )
          ).rows as { id: string; organisation_id: string; event_type: string; entity_type: string; entity_id: string; payload: Record<string, unknown> }[],
        correlationId,
        'worker',
      );
      if (!events.length) break;
      for (const e of events) {
        out.events += 1;
        const trigger = triggerFor(e.event_type);
        if (trigger) {
          try {
            const r = await this.handle(e, correlationId);
            out.matched += r.matched;
            out.actionsQueued += r.queued;
          } catch (error) {
            // A failure is logged and the event acknowledged: one bad event never holds up the others.
            this.log.warn(`Workflow event ${e.id} could not be handled: ${(error as Error).message}`);
          }
        }
      }
      await this.database.asApi((c) => c.query(`select app.system_outbox_ack($1, $2::bigint[])`, [CONSUMER, events.map((e) => e.id)]), correlationId, 'worker');
    }
    return out;
  }

  private async handle(e: { id: string; organisation_id: string; event_type: string; entity_type: string; entity_id: string; payload: Record<string, unknown> }, correlationId: string) {
    const trigger = triggerFor(e.event_type)!;
    return this.database.asApi(
      async (c) => {
        const rules = (await c.query(`select rule_version_id, conditions, actions from app.system_workflow_rules_for($1, $2)`, [e.organisation_id, e.event_type])).rows as {
          rule_version_id: string;
          conditions: Conditions;
          actions: Action[];
        }[];
        if (!rules.length) return { matched: 0, queued: 0 };
        const facts = (await c.query(`select app.system_workflow_facts($1, $2, $3, $4::jsonb) as f`, [e.organisation_id, trigger.entityType, e.entity_id, JSON.stringify(e.payload ?? {})]))
          .rows[0].f as Record<string, unknown> | null;
        if (!facts) return { matched: 0, queued: 0 };
        let matched = 0;
        let queued = 0;
        for (const rule of rules) {
          if (!evaluateConditions(rule.conditions, facts, trigger)) continue;
          const run = (
            await c.query(`select run_id, created from app.system_record_workflow_run($1, $2, $3::bigint, $4, $5, $6, $7::jsonb)`, [
              e.organisation_id,
              rule.rule_version_id,
              e.id,
              e.event_type,
              trigger.entityType,
              e.entity_id,
              JSON.stringify(facts),
            ])
          ).rows[0] as { run_id: string; created: boolean };
          matched += 1;
          if (!run.created) continue;
          for (const [index, action] of rule.actions.entries()) {
            await c.query(`select app.system_enqueue_job('workflow.action', $1::jsonb, $2, $3)`, [
              JSON.stringify({ runId: run.run_id, index, action }),
              e.organisation_id,
              `wf:${rule.rule_version_id}:${e.id}:${index}`,
            ]);
            queued += 1;
          }
        }
        return { matched, queued };
      },
      correlationId,
      'worker',
    );
  }

  /** One action of a run. `facts` (a timer's fresh reading of the record) replaces the facts recorded on the run. */
  private perform(runId: string, index: number, action: Action | InnerAction, correlationId: string, facts?: Record<string, unknown>, organisationId?: string | null): Promise<Record<string, unknown>> {
    const f = facts ? JSON.stringify(facts) : null;
    return this.database.asApi(
      async (c) => {
        if (action.type === 'notify') {
          return (await c.query(`select app.system_workflow_notify($1, $2, $3::jsonb, $4, $5::jsonb) as r`, [runId, index, JSON.stringify(action.recipients), action.message, f])).rows[0].r;
        }
        if (action.type === 'task') {
          return (
            await c.query(`select app.system_workflow_task($1, $2, $3::jsonb, $4, $5, $6, $7::jsonb) as r`, [
              runId,
              index,
              JSON.stringify(action.assignee),
              action.title,
              action.detail ?? null,
              action.dueDays ?? null,
              f,
            ])
          ).rows[0].r;
        }
        if (action.type === 'hold_lot') {
          return (await c.query(`select app.system_workflow_hold_lot($1, $2, $3, $4::jsonb) as r`, [runId, index, action.reason, f])).rows[0].r;
        }
        if (action.type === 'later') {
          // Queue the timer once (the key is the run and the action); it runs after the days given.
          const due = new Date(Date.now() + action.afterDays * 24 * 60 * 60 * 1000);
          await c.query(`select app.system_enqueue_job('workflow.timer', $1::jsonb, $2, $3, $4::timestamptz)`, [
            JSON.stringify({ runId, index, action }),
            organisationId ?? null,
            `wf:timer:${runId}:${index}`,
            due.toISOString(),
          ]);
          return { waiting: true, due: due.toISOString() };
        }
        throw new PermanentJobError(`Unknown action ${(action as { type?: string }).type}`);
      },
      correlationId,
      'worker',
    );
  }

  /** A timer's time has come: read the record again; if the rule is on and the conditions still hold, do the inner actions (each at its own place, once). */
  private async fire(runId: string, index: number, action: Extract<Action, { type: 'later' }>, correlationId: string) {
    const now = (await this.database.asApi(async (c) => (await c.query(`select app.system_workflow_timer_facts($1) as t`, [runId])).rows[0].t, correlationId, 'worker')) as {
      active: boolean;
      reason?: string;
      eventType: string;
      facts: Record<string, unknown> | null;
    };
    if (!now.active) return { fired: true, still: false, stopped: now.reason ?? 'The rule is off now' };
    if (!now.facts) return { fired: true, still: false, stopped: 'The record is gone' };
    if (!evaluateConditions(action.conditions, now.facts, triggerFor(now.eventType))) return { fired: true, still: false };
    const results: Record<string, unknown>[] = [];
    let failed = false;
    for (const [j, inner] of action.actions.entries()) {
      try {
        const r = await this.perform(runId, 10 + index * 10 + j, inner, correlationId, now.facts);
        if (r.refused) failed = true;
        results.push(r);
      } catch (error) {
        failed = true;
        results.push({ error: error instanceof Error ? error.message.slice(0, 300) : 'failed' });
      }
    }
    return { fired: true, still: true, results, failed };
  }

  private done(runId: string, index: number, ok: boolean, result: Record<string, unknown>, correlationId: string) {
    return this.database.asApi(
      (c) => c.query(`select app.system_workflow_action_done($1, $2, $3, $4::jsonb)`, [runId, index, ok && !result.skipped && !result.refused, JSON.stringify(result)]),
      correlationId,
      'worker',
    );
  }
}
