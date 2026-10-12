import { timingSafeEqual } from 'node:crypto';
import { type BeforeApplicationShutdown, Controller, Get, Headers, Inject, Injectable, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Database } from '@workeasy/db';
import { Public, TokenAuthorized } from '../common/access.js';
import { AppError, Errors } from '../common/errors.js';
import { audienceCountBacklog, dbPing, jobQueueDepth, jobQueueOldestDue, redisPing, registry } from '../common/metrics.js';
import { RATE_LIMIT_STORE, type RateLimitStore } from '../common/rate-limit.js';
import type { AppConfig } from '../config/env.js';
import { APP_CONFIG, DATABASE } from '../infrastructure/providers.js';

/** Set when the process starts shutting down: readiness turns 503 so load balancers stop routing to it first. */
@Injectable()
export class ShutdownState implements BeforeApplicationShutdown {
  draining = false;
  beforeApplicationShutdown(): void {
    this.draining = true;
  }
}

type Check = { status: 'ok' | 'failed'; latencyMs?: number };

/**
 * Health and metrics (Phase 7.12; docs/operations/observability.md).
 *  - GET /health        — liveness: the process is up (no dependency checked, so a database outage never restarts pods).
 *  - GET /health/ready  — readiness: PostgreSQL answers, the durable job queue is reachable, and the shared rate-limit
 *                         store (Redis) answers when one is configured; 503 while draining.
 *  - GET /metrics       — Prometheus text, only with `Authorization: Bearer <METRICS_TOKEN>`; 404 when no token is
 *                         configured (the endpoint does not exist). Counts and latencies only: no ids, no personal data.
 */
@Controller()
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly shutdown: ShutdownState,
    @Inject(RATE_LIMIT_STORE) private readonly rateLimits: RateLimitStore,
  ) {}

  @Get('health')
  @Public()
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  @Public()
  async ready() {
    if (this.shutdown.draining) throw new AppError('internal_error', 503, 'Shutting down');
    const database = await this.check(() => this.db.ping());
    const jobQueue = this.config.jobQueue === 'postgres' ? await this.check(() => this.db.system.jobQueueStats()) : undefined;
    const store = this.rateLimits;
    const rateLimitStore = store.ping ? await this.check(() => store.ping!()) : undefined;
    const checks = { database, ...(jobQueue ? { jobQueue } : {}), ...(rateLimitStore ? { rateLimitStore } : {}) };
    const failed = Object.entries(checks).filter(([, c]) => c.status !== 'ok').map(([k]) => k);
    // Names only (database, jobQueue, rateLimitStore): never connection strings or error text.
    if (failed.length) throw new AppError('internal_error', 503, 'A dependency is unavailable', Object.fromEntries(failed.map((k) => [k, ['unavailable']])));
    return { status: 'ready', checks };
  }

  @Get('metrics')
  @TokenAuthorized()
  async metrics(@Headers('authorization') authorization: string | undefined, @Res({ passthrough: true }) reply: FastifyReply) {
    const token = this.config.metricsToken;
    if (!token) throw Errors.notFound('Route');
    const given = Buffer.from(/^Bearer (.+)$/.exec(authorization ?? '')?.[1] ?? '');
    const expected = Buffer.from(token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw Errors.unauthenticated('Metrics token required');
    await this.collect();
    // Set only on success: errors stay JSON like every other route.
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return registry.render();
  }

  /** Gauges read at scrape time; a failure leaves the gauge out (or -1 for the database), never breaks the scrape. */
  private async collect(): Promise<void> {
    const t0 = performance.now();
    try {
      await this.db.ping();
      dbPing.set({}, (performance.now() - t0) / 1000);
    } catch {
      dbPing.set({}, -1);
    }
    if (this.rateLimits.ping) {
      const r0 = performance.now();
      try {
        await this.rateLimits.ping();
        redisPing.set({}, (performance.now() - r0) / 1000);
      } catch {
        redisPing.set({}, -1);
      }
    }
    try {
      jobQueueDepth.reset();
      jobQueueOldestDue.reset();
      for (const s of await this.db.system.jobQueueStats()) {
        jobQueueDepth.set({ job: s.name, status: s.status }, s.jobs);
        if (s.status === 'queued' && s.oldestDueSeconds !== null) jobQueueOldestDue.set({ job: s.name }, s.oldestDueSeconds);
      }
    } catch {
      // queue stats unavailable: gauges stay empty for this scrape
    }
    try {
      const due = await this.db.system.workspacesWithCountMaintenance(new Date(Date.now() - 24 * 3_600_000), 10_000);
      audienceCountBacklog.reset();
      audienceCountBacklog.set({ kind: 'rebuild' }, due.filter((d) => d.state !== 'valid').length);
      audienceCountBacklog.set({ kind: 'reconcile' }, due.filter((d) => d.state === 'valid').length);
    } catch {
      // not available
    }
  }

  private async check(fn: () => Promise<unknown>): Promise<Check> {
    const t0 = performance.now();
    try {
      await fn();
      return { status: 'ok', latencyMs: Math.round(performance.now() - t0) };
    } catch {
      return { status: 'failed' };
    }
  }
}
