import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { type ClaimedJob, type Database, enqueueJob } from '@workeasy/db';
import { jobLogEntry } from './observability.js';
import { jobDeadLetters, jobDuration, jobRetries, jobRuns } from './metrics.js';

/** Job names are code constants (registered handlers), never data: safe as a metric label. */
function recordJob(job: string, outcome: 'ok' | 'failed', ms: number): void {
  jobRuns.inc({ job, outcome });
  jobDuration.observe({ job }, ms / 1000);
}

/**
 * Background job dispatch. The application layer only says "run job X with this envelope"; how it runs is an
 * infrastructure choice (docs/architecture/durable-job-queue.md):
 *  - `InlineJobDispatcher` — in-process after the response (tests, single-process development);
 *  - `PgJobDispatcher` + `PgJobRunner` — the durable PostgreSQL queue (required in production): leased, heartbeated,
 *    retried with back-off, dead-lettered. Any process with the `jobs` role runs the runner.
 * Every envelope is `{ tenant, actor, correlationId, payload }` with ids only. Handlers must be idempotent and
 * resumable because any runner may retry them; a handler signals "never retry" by throwing `PermanentJobError`.
 */
export interface DispatchOptions {
  /** Not before now + delay (retries with back-off). */
  delayMs?: number;
  /** At most one queued or running job per key (durable queue only). */
  dedupeKey?: string;
  maxAttempts?: number;
}

export type JobHandler = (data: unknown) => Promise<void>;

export interface JobDispatcher {
  dispatch(name: string, data: unknown, opts?: DispatchOptions): void;
  register(name: string, handler: JobHandler): void;
}

export const JOB_DISPATCHER = Symbol('JOB_DISPATCHER');

/** Thrown by a handler for a job that must not be retried (invalid envelope, a state that can never succeed). */
export class PermanentJobError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export class InlineJobDispatcher implements JobDispatcher {
  private readonly logger = new Logger('InlineJobDispatcher');
  private readonly handlers = new Map<string, JobHandler>();
  private running = new Set<Promise<void>>();

  register(name: string, handler: JobHandler): void {
    this.handlers.set(name, handler);
  }

  dispatch(name: string, data: unknown, opts: DispatchOptions = {}): void {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`No handler registered for job ${name}`);
    if (opts.delayMs && opts.delayMs > 0) {
      // Development/test only: a delayed job lives in this process (the durable queue persists it instead).
      setTimeout(() => this.dispatch(name, data), opts.delayMs).unref();
      return;
    }
    let started = 0;
    const p = new Promise<void>((resolveRun) => setImmediate(resolveRun))
      .then(() => {
        started = performance.now();
        return handler(data);
      })
      .then(() => {
        this.logger.log(JSON.stringify(jobLogEntry(name, data, 'ok', performance.now() - started)));
        recordJob(name, 'ok', performance.now() - started);
      })
      .catch((err: unknown) => {
        recordJob(name, 'failed', performance.now() - started);
        // The structured entry (ids only) plus the stack for diagnosis; job errors carry codes, never payload values.
        this.logger.error(JSON.stringify(jobLogEntry(name, data, 'failed', performance.now() - started)));
        this.logger.error(`job ${name} failed: ${err instanceof Error ? err.stack : String(err)}`);
      })
      .finally(() => this.running.delete(p));
    this.running.add(p);
  }

  /** Resolves when every dispatched job has finished (tests and graceful shutdown). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }
}

/**
 * Enqueues into the durable PostgreSQL queue, in a short transaction under the envelope's tenant (the database refuses
 * an envelope whose tenant differs from the session's). `dispatch` keeps the fire-and-forget signature of existing
 * after-commit call sites; a failed enqueue is logged as an alert (the recovery sweep re-dispatches campaign work).
 * Code that must be atomic with its writes uses `enqueueJob(tx, …)` from @workeasy/db inside its own transaction.
 */
export class PgJobDispatcher implements JobDispatcher {
  private readonly logger = new Logger('PgJobDispatcher');
  readonly handlers = new Map<string, JobHandler>();
  private pending = new Set<Promise<unknown>>();

  constructor(private readonly db: Database) {}

  register(name: string, handler: JobHandler): void {
    this.handlers.set(name, handler);
  }

  dispatch(name: string, data: unknown, opts: DispatchOptions = {}): void {
    const tenant = (data as { tenant?: { orgId?: string; workspaceId?: string | null } } | null)?.tenant;
    if (!tenant?.orgId) throw new Error(`Job ${name} has no tenant`); // a programming error: never enqueue unscoped
    const p = this.db
      .withTenant({ orgId: tenant.orgId, workspaceId: tenant.workspaceId ?? null, userId: null }, (tx) =>
        enqueueJob(tx, {
          name,
          payload: data as { tenant: { orgId: string; workspaceId: string | null } },
          ...(opts.delayMs && opts.delayMs > 0 ? { runAfter: new Date(Date.now() + opts.delayMs) } : {}),
          ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
          ...(opts.dedupeKey ? { dedupeKey: opts.dedupeKey } : {}),
        }),
      )
      .catch((err: unknown) => this.logger.error(JSON.stringify({ alert: 'job_enqueue_failed', job: name, err: err instanceof Error ? err.message.slice(0, 200) : 'unknown' })))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Resolves when every enqueue started so far has finished (tests and shutdown). */
  async flushed(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

export interface RunnerOptions {
  /** Jobs run at once in this process. */
  concurrency: number;
  /** Lease per claim; heartbeats renew it every third of it. */
  leaseSeconds: number;
  /** Idle poll interval (grows ×2 up to `maxPollMs` while the queue is empty). */
  pollMs: number;
  maxPollMs: number;
  /** Retry back-off: base × 2^(attempt−1), ±20 % jitter, capped. */
  backoffBaseSeconds: number;
  backoffMaxSeconds: number;
}

export const DEFAULT_RUNNER_OPTIONS: RunnerOptions = { concurrency: 4, leaseSeconds: 60, pollMs: 500, maxPollMs: 5_000, backoffBaseSeconds: 5, backoffMaxSeconds: 600 };

/**
 * Runs jobs from the durable queue (docs/architecture/durable-job-queue.md §3): claims due jobs for the registered
 * names, runs each handler under a heartbeated lease, then completes it — or fails it with back-off, or straight to the
 * dead letters for a `PermanentJobError`. A lost lease (the job was reclaimed after this process stalled) is logged and
 * the outcome is not recorded (the new holder owns the job). Shutdown stops claiming and waits for running jobs up to
 * a deadline; an unfinished job's lease expires and it is retried.
 */
export class PgJobRunner {
  private readonly logger = new Logger('PgJobRunner');
  readonly worker = `${process.pid}:${randomUUID()}`;
  private active = new Set<Promise<void>>();
  private stopping = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly db: Database,
    private readonly handlers: ReadonlyMap<string, JobHandler>,
    private readonly opts: RunnerOptions = DEFAULT_RUNNER_OPTIONS,
  ) {}

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run();
  }

  /** Claims and runs one batch now (tests); returns how many jobs were claimed. */
  async tick(): Promise<number> {
    const free = this.opts.concurrency - this.active.size;
    if (free <= 0 || !this.handlers.size) return 0;
    const jobs = await this.db.system.claimJobs(this.worker, [...this.handlers.keys()], free, this.opts.leaseSeconds);
    for (const j of jobs) this.track(j);
    return jobs.length;
  }

  /** Resolves when the jobs claimed so far have finished (tests). */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active]);
  }

  async stop(deadlineMs = 25_000): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
    this.loop = null;
    await Promise.race([this.idle(), new Promise((r) => setTimeout(r, deadlineMs).unref())]);
  }

  private async run(): Promise<void> {
    let delay = this.opts.pollMs;
    while (!this.stopping) {
      let claimed = 0;
      try {
        claimed = await this.tick();
      } catch (err) {
        this.logger.error(JSON.stringify({ alert: 'job_claim_failed', err: err instanceof Error ? err.message.slice(0, 200) : 'unknown' }));
      }
      if (claimed > 0) {
        delay = this.opts.pollMs;
        continue;
      }
      await new Promise<void>((r) => {
        this.wake = r;
        setTimeout(r, this.active.size >= this.opts.concurrency ? this.opts.pollMs : delay).unref();
      });
      this.wake = null;
      delay = Math.min(delay * 2, this.opts.maxPollMs);
    }
  }

  private track(job: ClaimedJob): void {
    const p = this.execute(job).finally(() => this.active.delete(p));
    this.active.add(p);
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const handler = this.handlers.get(job.name);
    const label = handler ? job.name : 'other'; // metric label: registered job names only
    let leaseLost = false;
    const beat = setInterval(() => {
      void this.db.system
        .extendJobLease(job.id, this.worker, this.opts.leaseSeconds)
        .then((ok) => {
          if (!ok) leaseLost = true;
        })
        .catch(() => undefined); // a missed beat is retried on the next interval; the lease has 3× headroom
    }, Math.max(1_000, (this.opts.leaseSeconds * 1_000) / 3));
    beat.unref();
    const started = performance.now();
    try {
      if (!handler) throw new PermanentJobError('NO_HANDLER');
      await handler(job.payload);
      clearInterval(beat);
      const ok = await this.db.system.completeJob(job.id, this.worker);
      this.logger.log(JSON.stringify({ ...jobLogEntry(job.name, job.payload, 'ok', performance.now() - started), attempt: job.attempts, ...(ok ? {} : { leaseLost: true }) }));
      recordJob(label, 'ok', performance.now() - started);
    } catch (err) {
      clearInterval(beat);
      const permanent = err instanceof PermanentJobError;
      const code = permanent ? err.code : err instanceof Error ? (err.name || 'Error').slice(0, 60) : 'UNKNOWN';
      const backoff = Math.min(this.opts.backoffMaxSeconds, this.opts.backoffBaseSeconds * 2 ** Math.max(0, job.attempts - 1)) * (0.8 + Math.random() * 0.4);
      const status = leaseLost ? null : await this.db.system.failJob(job.id, this.worker, code, backoff, permanent).catch(() => null);
      const entry = { ...jobLogEntry(job.name, job.payload, 'failed', performance.now() - started), attempt: job.attempts, code, next: status ?? 'lease_lost' };
      recordJob(label, 'failed', performance.now() - started);
      if (status === 'dead') jobDeadLetters.inc({ job: label });
      else if (status === 'queued') jobRetries.inc({ job: label });
      if (status === 'dead') this.logger.error(JSON.stringify({ ...entry, alert: 'job_dead_lettered' }));
      else this.logger.warn(JSON.stringify(entry));
      if (!permanent) this.logger.debug(`job ${job.name} failed: ${err instanceof Error ? err.stack : String(err)}`);
    }
  }
}
