import { Injectable } from '@nestjs/common';

/** One background job as the worker hands it to its handler. */
export interface WorkerJob {
  id: string;
  organisationId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  correlationId: string;
}

/**
 * Thrown by a handler when trying again cannot help (bad payload, record gone): the job fails at once instead of backing off.
 */
export class PermanentJobError extends Error {}

export type JobHandler = (job: WorkerJob) => Promise<Record<string, unknown> | void>;

/**
 * The kinds of background job and what runs each (docs/workflow-engine-plan.md, W2). Modules register their handlers when they start
 * (`onModuleInit`); a job of a kind nobody registered fails at once with "No handler". Tests register their own kinds.
 */
@Injectable()
export class WorkerJobRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  register(kind: string, handler: JobHandler): void {
    if (!/^[a-z][a-z_]*(\.[a-z][a-z_]*)*$/.test(kind) || kind.length > 60) throw new Error(`Bad job kind: ${kind}`);
    this.handlers.set(kind, handler);
  }

  unregister(kind: string): void {
    this.handlers.delete(kind);
  }

  get(kind: string): JobHandler | undefined {
    return this.handlers.get(kind);
  }

  kinds(): string[] {
    return [...this.handlers.keys()].sort();
  }
}
