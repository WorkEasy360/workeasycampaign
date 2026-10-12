import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { EligibilityEvaluator } from '@workeasy/audience-core';
import { type CountMaintenanceLogger, type CountMaintenanceReport, createAudienceReadSide, runCountMaintenance } from '@workeasy/audience-infra';
import { createDatabase, type Database, type Tx } from '@workeasy/db';

/**
 * Worker composition root for the Audience read side (docs/contracts/phase-5-audience.md §9.8): the only worker file
 * allowed to import @workeasy/audience-infra. Jobs receive the core port (`EligibilityEvaluator<Tx>`) through
 * AUDIENCE_ELIGIBILITY and call it inside their `withTenant` transaction; they never see Audience tables or adapters.
 *
 * Not registered in WorkerModule yet: no job consumes it before delivery (Phase 8), and registering it would make the
 * worker require DATA_FINGERPRINT_SECRET at boot. The delivery milestone adds `audienceEligibilityProvider` to the
 * module's providers.
 */
export const AUDIENCE_ELIGIBILITY = Symbol('AUDIENCE_ELIGIBILITY');

export function audienceEligibility(env: { DATA_FINGERPRINT_SECRET?: string }): EligibilityEvaluator<Tx> {
  const secret = env.DATA_FINGERPRINT_SECRET;
  if (!secret) throw new Error('DATA_FINGERPRINT_SECRET is required to evaluate eligibility in the worker');
  return createAudienceReadSide({ fingerprintSecret: secret }).eligibility;
}

export const audienceEligibilityProvider = {
  provide: AUDIENCE_ELIGIBILITY,
  useFactory: () => audienceEligibility(process.env),
};

/**
 * Audience count bitmap maintenance (Phase 6.3 G2; docs/audit/phase-6.3-g2-closure.md): the smallest job the bitmap
 * needs, not a scheduler. Every `tickMs` (default 1 h) one run rebuilds every bitmap that is not valid and reconciles
 * every valid bitmap not reconciled within 24 h; a reconciliation difference is logged as an ALERT (error level,
 * `alert` field, ids only) and rebuilt. Runs never overlap; a failed run is logged and the next tick retries. While a
 * bitmap is not valid, counts use the exact query, so a late run costs latency, never correctness.
 */
export interface AudienceCountMaintenanceConfig {
  databaseUrl: string;
  tickMs?: number;
  reconcileEveryMs?: number;
}

export class AudienceCountMaintenance {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private readonly db: Database;
  private readonly log = new Logger('AudienceCountMaintenance');

  constructor(private readonly config: AudienceCountMaintenanceConfig) {
    if (!config.databaseUrl) throw new Error('DATABASE_URL is required for audience count maintenance');
    this.db = createDatabase({ url: config.databaseUrl, maxConnections: 2, applicationName: 'workeasy-worker-audience-count' });
  }

  /**
   * `keepProcessAlive`: the worker service passes true — its only work is this timer, so an unref'd timer let the
   * process exit (code 0) right after the first run and maintenance never ran again (found in the container smoke test,
   * 2026-10-10). Embedded uses (tests) keep the default and never hold their process open.
   */
  start(options: { keepProcessAlive?: boolean } = {}): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.config.tickMs ?? 3_600_000);
    if (!options.keepProcessAlive) this.timer.unref();
    void this.runOnce();
  }

  /** True while the periodic timer is scheduled (tests). */
  get scheduled(): boolean {
    return this.timer !== null;
  }

  /** Whether the timer keeps the process alive (tests). */
  get holdsProcess(): boolean {
    return this.timer?.hasRef() ?? false;
  }

  /** One maintenance run; returns null if a run is already in progress. */
  async runOnce(): Promise<CountMaintenanceReport | null> {
    if (this.running) return null;
    const run = runCountMaintenance(this.db, this.logger(), { reconcileEveryMs: this.config.reconcileEveryMs ?? 24 * 3_600_000 })
      .then((report) => {
        this.log.log(JSON.stringify({ msg: 'audience count maintenance run', ...report }));
        return report;
      })
      .catch((err: unknown) => {
        this.log.error(JSON.stringify({ alert: 'audience_count_maintenance_error', err: err instanceof Error ? err.message : String(err) }));
        return null;
      })
      .finally(() => (this.running = null));
    this.running = run;
    return run;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
    await this.db.disconnect();
  }

  private logger(): CountMaintenanceLogger {
    return {
      info: (o, msg) => this.log.log(JSON.stringify({ msg, ...o })),
      error: (o, msg) => this.log.error(JSON.stringify({ msg, ...o })),
    };
  }
}

/** Registered in WorkerModule: starts with the worker, stops (waiting for a running pass) on shutdown. */
@Injectable()
export class AudienceCountMaintenanceJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly job = new AudienceCountMaintenance({ databaseUrl: process.env.DATABASE_URL ?? '' });
  onApplicationBootstrap(): void {
    this.job.start({ keepProcessAlive: true });
  }
  async onApplicationShutdown(): Promise<void> {
    await this.job.stop();
  }
}
