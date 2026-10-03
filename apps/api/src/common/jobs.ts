import { Logger } from '@nestjs/common';

/**
 * Background job dispatch. The application layer only says "run job X with this envelope"; how it runs is an
 * infrastructure choice. Today: in-process (the API runs the job after responding). Later: BullMQ in the worker,
 * with the same envelope ({ tenant, actor, correlationId, payload }, see apps/worker/src/jobs/tenant-job.ts).
 * Handlers must be idempotent/resumable because any runner may retry them.
 */
export interface JobDispatcher {
  dispatch(name: string, data: unknown): void;
}

export const JOB_DISPATCHER = Symbol('JOB_DISPATCHER');

export class InlineJobDispatcher implements JobDispatcher {
  private readonly logger = new Logger('InlineJobDispatcher');
  private readonly handlers = new Map<string, (data: unknown) => Promise<void>>();
  private running = new Set<Promise<void>>();

  register(name: string, handler: (data: unknown) => Promise<void>): void {
    this.handlers.set(name, handler);
  }

  dispatch(name: string, data: unknown): void {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`No handler registered for job ${name}`);
    const p = new Promise<void>((resolveRun) => setImmediate(resolveRun))
      .then(() => handler(data))
      .catch((err: unknown) => this.logger.error(`job ${name} failed: ${err instanceof Error ? err.stack : String(err)}`))
      .finally(() => this.running.delete(p));
    this.running.add(p);
  }

  /** Resolves when every dispatched job has finished (tests and graceful shutdown). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }
}
