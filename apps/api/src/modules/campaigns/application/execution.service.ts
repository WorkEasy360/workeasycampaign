import { randomUUID } from 'node:crypto';
import { failureKind } from '@workeasy/channels';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AudienceResolutionError, type AudienceResolutionV1_2, type EligibilityEvaluator } from '@workeasy/audience-core';
import type { CampaignExecutionModel, Database, SendRateBucket, Tx } from '@workeasy/db';
import type { CampaignCounts, Channel, EligibilityResult } from '@workeasy/shared';
import { uuidV7 } from '../../../common/uuid-v7.js';
import { JOB_DISPATCHER, type JobDispatcher } from '../../../common/jobs.js';
import { messagesSentUsage, recordUsage } from '../../../common/usage.js';
import { deliveryOutcomes, executionRetries, executionStalled, providerFailures, schedulerLag, schedulerTicks } from '../../../common/metrics.js';
import type { AppConfig } from '../../../config/env.js';
import { APP_CONFIG, AUDIENCE_RESOLUTION, DATABASE, ELIGIBILITY_EVALUATOR } from '../../../infrastructure/providers.js';
import { type AuditEntry, recordAudit } from '../../audit/audit.js';
import { appendDomainEvent, type EventOrigin } from '../../events/domain-events.js';
import type { DomainEventPayload, DomainEventType } from '../../events/catalogue.js';
import { isChannelAvailable } from '../domain/channels.js';
import { isDeliveryAvailable } from '../domain/delivery-mode.js';
import { campaignStatusFor, isSnapshotReleasable, nextExecutionState } from '../domain/execution.js';
import { startFailure } from '../domain/readiness.js';
import { readVersionSnapshot } from '../domain/version.js';
import { CAMPAIGN_DELIVERY_PORT, type CampaignDeliveryPort } from './delivery.js';
import { EXECUTION_JOBS, type ExecutionJobEnvelope, type ExecutionJobName, executionJobEnvelope } from './execution-jobs.js';

/** Contract §6.2 / §10.3 parameters. Tunable for tests through `configure` (never by clients). */
export interface ExecutionTuning {
  /** Snapshot page and Checkpoint A batch (contract §6.1: 1,000; Eligibility sub-batches internally to 500). */
  pageSize: number;
  /** Recipients claimed per delivery batch (Checkpoint B batch, contract §6.3: ≤ 1,000). */
  deliveryBatch: number;
  /** Execution lease; renewed with every page / batch. */
  leaseMs: number;
  /** Recipient claim lease (contract §10.3: 5 min). */
  recipientLeaseMs: number;
  /** Page-level retries of a transient failure (contract §6.2: 0.5 s, 1 s, 2 s). */
  pageRetryDelaysMs: number[];
  /** Job-level retries after the page retries (contract §6.2: 1, 2, 4, 8, 16 min), then health = stalled. */
  jobRetryDelaysMs: number[];
  /** Delivery attempts per recipient before `failed` (contract §10.3: 5). */
  maxDeliveryAttempts: number;
  /** Clock-skew tolerance for "due" (send-now uses the API host's clock). */
  dueToleranceMs: number;
}

const DEFAULT_TUNING: ExecutionTuning = {
  pageSize: 1_000,
  deliveryBatch: 1_000,
  leaseMs: 60_000,
  recipientLeaseMs: 300_000,
  pageRetryDelaysMs: [500, 1_000, 2_000],
  jobRetryDelaysMs: [60_000, 120_000, 240_000, 480_000, 960_000],
  maxDeliveryAttempts: 5,
  dueToleranceMs: 5_000,
};

/** Capture runs in its own dedicated transaction with the statement budget of Audience decision K (300 s + margin). */
const CAPTURE_TX_TIMEOUT_MS = 330_000;
/** Capture errors that are configuration failures (contract §11): the execution fails, nothing is retried. */
const CONFIGURATION_CAPTURE_ERRORS = new Set(['AUDIENCE_SOURCE_NOT_FOUND', 'AUDIENCE_TOO_LARGE', 'AUDIENCE_DEFINITION_INVALID']);
const NON_FINAL_RECIPIENT = ['pending', 'queued', 'sending'];

type Stop = 'continue' | 'stop';

/**
 * Fault-injection points for crash/resume tests (contract §6.4 trigger 4). Each is called at the named point; a hook
 * that throws simulates the process dying there (an infrastructure failure: the run aborts and is retried or swept).
 * Production never sets them; they never skip or alter a step.
 */
export type CrashPoint = 'beforeCapture' | 'afterCapture' | 'inPage' | 'afterPage' | 'beforeRelease' | 'beforeCheckpointB' | 'beforeComplete';
interface JobUnit {
  tx: Tx;
  scope: { tx: Tx; orgId: string; workspaceId: string };
  event<T extends DomainEventType>(type: T, aggregateId: string, payload: DomainEventPayload<T>): Promise<string>;
  /** Audit record with actor_type 'system' and the job's correlation id (no IP / user agent). */
  audit(entry: AuditEntry): Promise<void>;
}

class ConfigurationFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * A sending-rate limit (Phase 7.11: provider, workspace or this run) has no token for longer than an in-process wait.
 * Not a failure: the run continues as a durable delayed job when tokens are available again.
 */
class SendRateWait extends Error {
  constructor(readonly waitMs: number) {
    super(`send rate: next token in ${waitMs} ms`);
  }
}

/** Waits up to this long in-process for the next token; longer waits free the worker (delayed job). */
const IN_PROCESS_RATE_WAIT_MS = 2_000;

/**
 * The provider asked us to slow down (`throttled`) or cannot send at all right now (`configuration`: credentials,
 * domain, account). The batch stops; the run is retried later as a durable delayed job (Phase 7.7 taxonomy).
 */
class ProviderBackpressure extends Error {
  constructor(
    readonly kind: 'throttled' | 'configuration',
    readonly code: string,
    readonly retryAfterMs: number,
  ) {
    super(`provider ${kind}: ${code}`);
  }
}

/**
 * Campaign execution engine (milestone 6.9, Gate G3 — TEST MODE ONLY; contract §5, §6, §7, §10, §11; architecture
 * §22). Immutable CampaignVersion → execution → Audience snapshot (capture) → paged materialization with Checkpoint A →
 * recipients → Checkpoint B → NullDeliveryPort → terminal recipients → completion → snapshot release.
 *
 * Guards (the database is the source of truth): the execution row lock + state check before every page/batch; an
 * execution lease (acquire / renew / expire) so two runners never work one execution; `UNIQUE (execution_id,
 * contact_id)` + ON CONFLICT DO NOTHING for exactly-once recipients; recipient claims with FOR UPDATE SKIP LOCKED and
 * outcome writes conditional on the claim; capture idempotent per execution id. Audience data is reached only through
 * the Audience ports; nothing here reads Audience tables. Delivery happens only through `CampaignDeliveryPort`, which is
 * wired only in `test` mode (NullDeliveryPort: no I/O).
 */
@Injectable()
export class ExecutionService {
  private readonly log = new Logger('CampaignExecution');
  private tuning: ExecutionTuning = { ...DEFAULT_TUNING };
  private readonly timers = new Set<NodeJS.Timeout>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private schedulerBusy = false;
  /** Observability hook (benchmarks): durations of capture (S2), each page transaction, Checkpoint B and each delivery batch. */
  onTiming: ((kind: 'capture' | 'page' | 'checkpointB' | 'deliveryBatch', ms: number) => void) | null = null;
  /** Tests only (see CrashPoint). */
  testHooks: Partial<Record<CrashPoint, (info: { executionId: string }) => Promise<void> | void>> = {};

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIENCE_RESOLUTION) private readonly resolution: AudienceResolutionV1_2<Tx>,
    @Inject(ELIGIBILITY_EVALUATOR) private readonly eligibility: EligibilityEvaluator<Tx>,
    @Inject(JOB_DISPATCHER) private readonly jobs: JobDispatcher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(CAMPAIGN_DELIVERY_PORT) private readonly delivery: CampaignDeliveryPort | null,
  ) {}

  /**
   * The sending-rate buckets that apply to this run (Phase 7.11; amendment §R): the provider account, the workspace's
   * fair share and the run's own limit. Empty = unlimited (no token round-trip at all).
   */
  rateBuckets(e: Pick<CampaignExecutionModel, 'id' | 'workspaceId' | 'maxPerHour'>): SendRateBucket[] {
    const b: SendRateBucket[] = [];
    const { providerPerSecond, workspacePerSecond } = this.config.sendRates;
    if (providerPerSecond) b.push({ scope: 'provider:default', ratePerSecond: providerPerSecond, burst: providerPerSecond });
    if (workspacePerSecond) b.push({ scope: `workspace:${e.workspaceId}`, ratePerSecond: workspacePerSecond, burst: workspacePerSecond });
    if (e.maxPerHour) {
      // A burst of ~10 seconds' worth (at least 1): smooth, never the whole hour at once.
      b.push({ scope: `execution:${e.id}`, ratePerSecond: e.maxPerHour / 3600, burst: Math.min(Math.max(Math.round(e.maxPerHour / 360), 1), this.tuning.deliveryBatch) });
    }
    return b;
  }

  /** What this deployment has configured (channel availability; messaging amendment). */
  get deployment() {
    return { mode: this.config.campaignDeliveryMode, smsConfigured: !!this.config.smsProvider, whatsappConfigured: !!this.config.whatsappProvider };
  }

  /** Tests only: shorter backoffs / smaller pages. */
  configure(t: Partial<ExecutionTuning>): void {
    this.tuning = { ...this.tuning, ...t };
  }

  /** Delivery is possible only in `test` mode with the NullDeliveryPort wired (contract §9.3). */
  get deliveryAvailable(): boolean {
    // The wired port must match the configured mode (a test port never runs under "live", nor the reverse).
    return isDeliveryAvailable(this.config.campaignDeliveryMode) && this.delivery?.mode === this.config.campaignDeliveryMode;
  }

  registerHandlers(): void {
    this.jobs.register(EXECUTION_JOBS.start, (d) => this.handle(EXECUTION_JOBS.start, d, (env) => this.start(env)));
    this.jobs.register(EXECUTION_JOBS.run, (d) => this.handle(EXECUTION_JOBS.run, d, (env) => this.run(env)));
    this.jobs.register(EXECUTION_JOBS.finalize, (d) => this.handle(EXECUTION_JOBS.finalize, d, (env) => this.finalize(env)));
    this.jobs.register(EXECUTION_JOBS.release, (d) => this.handle(EXECUTION_JOBS.release, d, (env) => this.release(env, null)));
  }

  /** Builds and dispatches a job envelope (from an authorized command or another job — never from client input). */
  dispatch(name: ExecutionJobName, tenant: { orgId: string; workspaceId: string }, executionId: string, opts: { actor?: ExecutionJobEnvelope['actor']; correlationId?: string; attempt?: number; delayMs?: number } = {}): void {
    const env: ExecutionJobEnvelope = {
      tenant,
      actor: opts.actor ?? { type: 'system', id: null },
      correlationId: opts.correlationId ?? randomUUID(),
      payload: { executionId, attempt: opts.attempt ?? 0 },
    };
    this.jobs.dispatch(name, env, opts.delayMs ? { delayMs: opts.delayMs } : {});
  }

  stopTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
  }

  /**
   * The scheduler (Phase 7.5): a tick at start and every `intervalMs`. Ticks never overlap within a process; across
   * processes they may — harmless, see `startDue`.
   */
  startScheduler(intervalMs: number): void {
    if (intervalMs <= 0 || this.schedulerTimer) return;
    const tick = () => {
      if (this.schedulerBusy) return;
      this.schedulerBusy = true;
      void this.startDue()
        .then((r) => {
          schedulerTicks.inc({ outcome: 'ok' });
          schedulerLag.set({}, r.maxLagMs / 1000);
        })
        .catch((err: unknown) => {
          schedulerTicks.inc({ outcome: 'failed' });
          this.log.error(JSON.stringify({ alert: 'campaign_scheduler_failed', err: errMsg(err) }));
        })
        .finally(() => {
          this.schedulerBusy = false;
        });
    };
    tick();
    this.schedulerTimer = setInterval(tick, intervalMs);
    this.schedulerTimer.unref();
  }

  /**
   * Starts every due scheduled execution (one page of at most `limit` per call, oldest first). Durable by construction:
   * the only state is the execution row (pending + send_at) in PostgreSQL — never a timer, the browser or process
   * uptime — so a restart, a missed tick or downtime is caught up by the next tick. Several schedulers may run at once:
   * `start` re-checks status and send time under the campaign → execution lock, so a duplicate dispatch is a no-op,
   * and an unschedule/reschedule/cancel that wins the lock is respected. Returns how many were due and the largest lag
   * (how late the oldest one is) for monitoring.
   */
  async startDue(now = new Date(), limit = 500): Promise<{ due: number; maxLagMs: number }> {
    const due = await this.db.system.dueCampaignExecutions(now, limit);
    let maxLagMs = 0;
    const byWorkspace = new Map<string, { orgId: string; workspaceId: string; ids: string[] }>();
    for (const d of due) {
      maxLagMs = Math.max(maxLagMs, now.getTime() - d.sendAt.getTime());
      const key = `${d.orgId}/${d.workspaceId}`;
      if (!byWorkspace.has(key)) byWorkspace.set(key, { orgId: d.orgId, workspaceId: d.workspaceId, ids: [] });
      byWorkspace.get(key)!.ids.push(d.executionId);
    }
    for (const ws of byWorkspace.values()) {
      const env = this.systemEnvelope(ws, randomUUID());
      // Each started execution keeps the correlation of the request that scheduled it (its whole history joins).
      const correlation = new Map(
        (await this.unit(env, (u) =>
          u.tx.$queryRaw<{ execution_id: string; correlation_id: string }[]>`
            SELECT e.id::text AS execution_id, d.correlation_id::text AS correlation_id
              FROM campaign_executions e
              JOIN LATERAL (SELECT correlation_id FROM domain_events
                             WHERE org_id = e.org_id AND aggregate_type = 'campaign' AND aggregate_id = e.campaign_id AND type = 'campaign.scheduled' AND payload->>'executionId' = e.id::text
                             LIMIT 1) d ON true
             WHERE e.id = ANY(${ws.ids}::uuid[])`,
        )).map((r) => [r.execution_id, r.correlation_id] as const),
      );
      for (const id of ws.ids) this.dispatch(EXECUTION_JOBS.start, { orgId: ws.orgId, workspaceId: ws.workspaceId }, id, correlation.has(id) ? { correlationId: correlation.get(id)! } : {});
    }
    if (due.length) this.log.log(JSON.stringify({ msg: 'campaign_scheduler_tick', due: due.length, maxLagMs }));
    return { due: due.length, maxLagMs };
  }

  /** Recovery sweep at start and every `intervalMs` (contract §6.4: 15 min). Off when intervalMs is 0 (tests call sweep()). */
  startSweeps(intervalMs: number): void {
    if (intervalMs <= 0 || this.sweepTimer) return;
    void this.sweep().catch((err: unknown) => this.log.error(JSON.stringify({ alert: 'campaign_recovery_sweep_failed', err: errMsg(err) })));
    this.sweepTimer = setInterval(() => void this.sweep().catch((err: unknown) => this.log.error(JSON.stringify({ alert: 'campaign_recovery_sweep_failed', err: errMsg(err) }))), intervalMs);
    this.sweepTimer.unref();
  }

  private async handle(name: string, data: unknown, fn: (env: ExecutionJobEnvelope) => Promise<unknown>): Promise<void> {
    const parsed = executionJobEnvelope.safeParse(data);
    if (!parsed.success) {
      // Programming error or tampering: never run unscoped, never retry.
      this.log.error(JSON.stringify({ alert: 'campaign_job_invalid_envelope', job: name }));
      return;
    }
    await fn(parsed.data);
  }

  // ─── units of work (system actor; tenant = the envelope's workspace, enforced by RLS) ─────────────────────────

  private unit<T>(env: ExecutionJobEnvelope, fn: (u: JobUnit) => Promise<T>, timeout = 60_000): Promise<T> {
    const { orgId, workspaceId } = env.tenant;
    // Event contract v1 (docs/events.md): system transitions are actor 'system', source 'campaign_runner', correlated
    // with the request that scheduled the execution (carried by every job of that execution).
    const origin: EventOrigin = { orgId, actorType: 'system', actorId: null, source: 'campaign_runner', correlationId: env.correlationId };
    return this.db.withTenant(
      { orgId, workspaceId, userId: null },
      (tx) =>
        fn({
          tx,
          scope: { tx, orgId, workspaceId },
          event: (type, aggregateId, payload) => appendDomainEvent(tx, origin, { type, aggregateId, workspaceId, payload }),
          audit: (entry) =>
            recordAudit(tx, { orgId, principal: null, meta: { requestId: env.correlationId, ipAddress: null, userAgent: null } }, { workspaceId, ...entry }),
        }),
      { timeout },
    );
  }

  /**
   * The execution row under lock, re-resolved inside the envelope's tenant (RLS): a forged envelope, a foreign id or an
   * id of another workspace yields null — indistinguishable from "does not exist", and the job stops without effect.
   */
  private async lockExecution(u: JobUnit, executionId: string): Promise<CampaignExecutionModel | null> {
    const rows = await u.tx.$queryRaw<{ id: string }[]>`SELECT id FROM campaign_executions WHERE id = ${executionId}::uuid FOR UPDATE`;
    if (!rows.length) return null;
    const e = await u.tx.campaignExecution.findUniqueOrThrow({ where: { id: executionId } });
    if (e.orgId !== u.scope.orgId || e.workspaceId !== u.scope.workspaceId) return null; // defence in depth (RLS already)
    return e;
  }

  /**
   * Lock order campaign → execution (the order lifecycle commands use). Required for every transaction that updates the
   * campaign as well as the execution (completion, configuration failure): taking the execution first and the campaign
   * second could deadlock with a concurrent pause/cancel.
   */
  private async lockCampaignThenExecution(u: JobUnit, executionId: string): Promise<CampaignExecutionModel | null> {
    const peek = await u.tx.campaignExecution.findUnique({ where: { id: executionId }, select: { campaignId: true } });
    if (!peek) return null;
    await u.tx.$queryRaw`SELECT id FROM campaigns WHERE id = ${peek.campaignId}::uuid FOR UPDATE`;
    return this.lockExecution(u, executionId);
  }

  private async bump(u: JobUnit, e: CampaignExecutionModel, data: Record<string, unknown>): Promise<void> {
    await u.tx.campaignExecution.update({ where: { id: e.id }, data: { ...data, version: { increment: 1 } } });
  }

  private async setCampaignStatus(u: JobUnit, campaignId: string, execStatus: CampaignExecutionModel['status']): Promise<void> {
    await u.tx.campaign.update({
      where: { id: campaignId },
      data: { status: campaignStatusFor({ status: execStatus as never }), updatedAt: new Date(), version: { increment: 1 } },
    });
  }

  // ─── S1: start (contract §6.1) ────────────────────────────────────────────────────────────────────────────────

  async start(env: ExecutionJobEnvelope): Promise<'started' | 'failed' | 'noop'> {
    const id = env.payload.executionId;
    const outcome = await this.unit(env, async (u) => {
      const peek = await u.tx.campaignExecution.findUnique({ where: { id }, select: { campaignId: true } });
      if (!peek) return 'noop' as const;
      await u.tx.$queryRaw`SELECT id FROM campaigns WHERE id = ${peek.campaignId}::uuid FOR UPDATE`; // lock order campaign → execution
      const e = await this.lockExecution(u, id);
      if (!e || e.status !== 'pending' || e.sendAt.getTime() > Date.now() + this.tuning.dueToleranceMs) return 'noop' as const;
      const campaign = await u.tx.campaign.findUniqueOrThrow({ where: { id: e.campaignId } });
      const version = await u.tx.campaignVersion.findUniqueOrThrow({ where: { id: e.versionId } });
      if (campaign.workspaceId !== e.workspaceId || version.workspaceId !== e.workspaceId || version.campaignId !== e.campaignId) return 'noop' as const;
      const snapshot = readVersionSnapshot(version.snapshot);
      const topic = (await this.resolution.topicStatus(u.scope, snapshot.topic.topicIds[0])).available ? 'ok' : 'unavailable';
      const failure = startFailure({ channelEnabled: isChannelAvailable(snapshot.channel, this.deployment), topic, deliveryAvailable: this.deliveryAvailable });
      if (failure) {
        await this.failInTx(u, e, failure);
        return 'failed' as const;
      }
      const next = nextExecutionState({ status: 'pending', pausedPhase: null, materializedAt: null }, 'start');
      if (!next.ok) return 'noop' as const;
      await this.bump(u, e, { status: next.status, startedAt: new Date(), health: 'ok', lastProgressAt: new Date() });
      await this.setCampaignStatus(u, e.campaignId, next.status);
      await u.event('campaign.started', e.campaignId, { executionId: e.id });
      // Usage (Phase 7.13): one campaign run, recorded with the start itself (exactly once).
      await recordUsage(u.tx, [{ schema: 'usage.record.v1', recordId: `campaign.executions:${e.id}`, meter: 'campaign.executions', orgId: e.orgId, workspaceId: e.workspaceId, quantity: 1, at: new Date().toISOString() }]);
      await u.audit({ action: 'campaign.execution_started', targetType: 'campaign', targetId: e.campaignId, metadata: { executionId: e.id, versionId: e.versionId } });
      return 'started' as const;
    });
    if (outcome === 'started') this.dispatch(EXECUTION_JOBS.run, env.tenant, id, { correlationId: env.correlationId });
    if (outcome === 'failed') this.dispatch(EXECUTION_JOBS.finalize, env.tenant, id, { correlationId: env.correlationId });
    return outcome;
  }

  /** Configuration failure (contract §11): execution failed + campaign failed + campaign.failed, in the caller's lock. */
  private async failInTx(u: JobUnit, e: CampaignExecutionModel, code: string): Promise<void> {
    const next = nextExecutionState({ status: e.status as never, pausedPhase: e.pausedPhase as never, materializedAt: e.materializedAt }, 'fail');
    if (!next.ok) return;
    await this.bump(u, e, { status: 'failed', pausedPhase: null, failureClass: 'configuration', failureCode: code, leaseOwner: null, leaseUntil: null });
    await this.setCampaignStatus(u, e.campaignId, 'failed');
    await u.event('campaign.failed', e.campaignId, { executionId: e.id, failureClass: 'configuration', failureCode: code });
    await u.audit({ action: 'campaign.execution_failed', outcome: 'failure', targetType: 'campaign', targetId: e.campaignId, metadata: { executionId: e.id, failureClass: 'configuration', failureCode: code } });
  }

  // ─── run: lease → materialize → deliver → complete ────────────────────────────────────────────────────────────

  async run(env: ExecutionJobEnvelope): Promise<'done' | 'stopped' | 'busy' | 'retrying' | 'stalled'> {
    const id = env.payload.executionId;
    const owner = `${process.pid}:${randomUUID()}`;
    const acquired = await this.unit(env, async (u) => {
      const rows = await u.tx.$queryRaw<{ id: string }[]>`
        UPDATE campaign_executions SET lease_owner = ${owner}, lease_until = now() + make_interval(secs => ${this.tuning.leaseMs / 1000}::float8),
               version = version + 1
         WHERE id = ${id}::uuid AND status IN ('materializing', 'delivering') AND (lease_until IS NULL OR lease_until < now())
        RETURNING id`;
      return rows.length === 1;
    });
    if (!acquired) return 'busy'; // another runner holds a live lease, or the execution is not runnable (paused, terminal, foreign)
    let result: 'done' | 'stopped' | 'retrying' | 'stalled' = 'stopped';
    let armRetry: (() => void) | null = null;
    try {
      for (;;) {
        const status = await this.unit(env, async (u) => (await u.tx.campaignExecution.findUnique({ where: { id }, select: { status: true } }))?.status);
        if (status === 'materializing') {
          if ((await this.materialize(env, owner)) === 'stop') break;
        } else if (status === 'delivering') {
          if (!this.deliveryAvailable) {
            this.log.warn(JSON.stringify({ msg: 'delivery not available; execution left delivering', executionId: id }));
            break;
          }
          result = (await this.deliver(env, owner)) === 'continue' ? 'done' : 'stopped';
          break;
        } else break;
      }
    } catch (err) {
      if (err instanceof ConfigurationFailure) {
        await this.unit(env, async (u) => {
          const e = await this.lockCampaignThenExecution(u, id);
          if (e && e.leaseOwner === owner && !['completed', 'cancelled', 'failed'].includes(e.status)) await this.failInTx(u, e, err.code);
        });
        this.dispatch(EXECUTION_JOBS.finalize, env.tenant, id, { correlationId: env.correlationId });
        return 'stopped';
      }
      const retry = await this.scheduleRetry(env, owner, err);
      result = retry.status;
      armRetry = retry.arm;
    } finally {
      // Give back the execution lease and any claimed-but-not-handed-off recipients ('queued'), so a retry or another
      // runner continues at once. Hand-offs in flight ('sending') keep their claim: their outcome is not known here.
      await this.unit(env, async (u) => {
        await u.tx.$executeRaw`UPDATE campaign_recipients SET lease_owner = NULL, lease_until = NULL, updated_at = now()
                                 WHERE execution_id = ${id}::uuid AND status = 'queued' AND lease_owner = ${owner}`;
        await u.tx.$executeRaw`UPDATE campaign_executions SET lease_owner = NULL, lease_until = NULL WHERE id = ${id}::uuid AND lease_owner = ${owner}`;
      }).catch(() => undefined); // a lease that cannot be given back simply expires
    }
    // Only now — with our lease given back — may the retry start (else it could find our lease and end as busy).
    armRetry?.();
    return result;
  }

  /** Infrastructure failure (contract §11): never fails the execution; job retried with backoff, then health = stalled. */
  private async scheduleRetry(env: ExecutionJobEnvelope, owner: string, err: unknown): Promise<{ status: 'retrying' | 'stalled'; arm: (() => void) | null }> {
    // A sending-rate wait is the plan, not a failure: continue when tokens are available, at the same attempt.
    if (err instanceof SendRateWait) {
      executionRetries.inc({ reason: 'send_rate' });
      return { status: 'retrying', arm: () => this.dispatch(EXECUTION_JOBS.run, env.tenant, env.payload.executionId, { correlationId: env.correlationId, attempt: env.payload.attempt, delayMs: err.waitMs }) };
    }
    // A provider throttle is not a failure: wait as asked, without counting towards the stall budget.
    if (err instanceof ProviderBackpressure && err.kind === 'throttled') {
      executionRetries.inc({ reason: 'provider_throttled' });
      this.log.warn(JSON.stringify({ msg: 'campaign delivery throttled by the provider', executionId: env.payload.executionId, code: err.code, retryAfterMs: err.retryAfterMs }));
      return { status: 'retrying', arm: () => this.dispatch(EXECUTION_JOBS.run, env.tenant, env.payload.executionId, { correlationId: env.correlationId, attempt: env.payload.attempt, delayMs: err.retryAfterMs }) };
    }
    executionRetries.inc({ reason: err instanceof ProviderBackpressure ? 'provider_configuration' : 'infrastructure' });
    if (err instanceof ProviderBackpressure) this.log.error(JSON.stringify({ alert: 'campaign_delivery_provider_configuration', executionId: env.payload.executionId, code: err.code }));
    const attempt = env.payload.attempt;
    const delays = this.tuning.jobRetryDelaysMs;
    const stalled = attempt >= delays.length;
    this.log.warn(JSON.stringify({ msg: 'campaign execution infrastructure failure', executionId: env.payload.executionId, attempt, stalled, err: errMsg(err) }));
    await this.unit(env, (u) =>
      u.tx.$executeRaw`UPDATE campaign_executions SET health = ${stalled ? 'stalled' : 'retrying'}, version = version + 1
                        WHERE id = ${env.payload.executionId}::uuid AND status IN ('materializing', 'delivering') AND (lease_owner = ${owner} OR lease_owner IS NULL)`,
    ).catch(() => undefined);
    if (stalled) {
      executionStalled.inc();
      this.log.error(JSON.stringify({ alert: 'campaign_execution_stalled', executionId: env.payload.executionId }));
      return { status: 'stalled', arm: null }; // the recovery sweep resumes it later from its checkpoint
    }
    // The retry is a delayed job (Phase 7.6): with the durable queue it is persisted, so it survives a restart.
    const arm = () => this.dispatch(EXECUTION_JOBS.run, env.tenant, env.payload.executionId, { correlationId: env.correlationId, attempt: attempt + 1, delayMs: delays[attempt] });
    return { status: 'retrying', arm };
  }

  /** Page-level retries (contract §6.2) for one unit of transient work; configuration failures are never retried. */
  private async withPageRetries<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof ConfigurationFailure || i >= this.tuning.pageRetryDelaysMs.length) throw err;
        await new Promise((r) => setTimeout(r, this.tuning.pageRetryDelaysMs[i]));
      }
    }
  }

  // ─── materialization (S2, S3, pages with Checkpoint A) ────────────────────────────────────────────────────────

  private async materialize(env: ExecutionJobEnvelope, owner: string): Promise<Stop> {
    const id = env.payload.executionId;
    const e0 = await this.unit(env, (u) => u.tx.campaignExecution.findUnique({ where: { id } }));
    if (!e0 || e0.status !== 'materializing' || e0.leaseOwner !== owner) return 'stop';
    const version = await this.unit(env, (u) => u.tx.campaignVersion.findUniqueOrThrow({ where: { id: e0.versionId } }));
    const snapshot = readVersionSnapshot(version.snapshot);

    if (!e0.audienceSnapshotId) {
      await this.testHooks.beforeCapture?.({ executionId: id });
      // S2 — its own dedicated transaction, no campaign locks held (cancel/pause never wait behind it). Idempotent per
      // captureKey = execution id: a retry after a crash between S2 and S3 receives the SAME snapshot.
      let ref;
      const c0 = performance.now();
      try {
        ref = await this.withPageRetries(() =>
          this.db.withTenant({ ...env.tenant, userId: null }, (tx) =>
            this.resolution.capture({ tx, ...env.tenant }, snapshot.audience, id, { kind: 'campaign_execution', id }),
            { timeout: CAPTURE_TX_TIMEOUT_MS },
          ).catch((err: unknown) => {
            if (err instanceof AudienceResolutionError && CONFIGURATION_CAPTURE_ERRORS.has(err.code)) throw new ConfigurationFailure(err.code);
            throw err;
          }),
        );
      } catch (err) {
        if (err instanceof AudienceResolutionError && err.code === 'AUDIENCE_SNAPSHOT_NOT_FOUND') return 'stop'; // key released (cancelled)
        throw err;
      }
      this.onTiming?.('capture', performance.now() - c0);
      await this.testHooks.afterCapture?.({ executionId: id });
      // S3 — record it, only if still materializing under our lease (else the release procedure handles the snapshot).
      const recorded = await this.unit(env, async (u) => {
        const e = await this.lockExecution(u, id);
        if (!e || e.status !== 'materializing' || e.leaseOwner !== owner) return false;
        if (!e.audienceSnapshotId) {
          await this.bump(u, e, {
            audienceSnapshotId: ref.snapshotId,
            capturedAt: new Date(ref.capturedAt),
            audienceSize: ref.size,
            lastProgressAt: new Date(),
            leaseUntil: new Date(Date.now() + this.tuning.leaseMs),
          });
        }
        return true;
      });
      if (!recorded) return 'stop';
    }

    const topicId = snapshot.topic.topicIds[0];
    for (;;) {
      const p0 = performance.now();
      const r = await this.withPageRetries(() => this.materializePage(env, owner, topicId, snapshot.channel));
      this.onTiming?.('page', performance.now() - p0);
      if (r !== 'stop') await this.testHooks.afterPage?.({ executionId: id });
      if (r === 'more') continue;
      if (r === 'done') {
        await this.testHooks.beforeRelease?.({ executionId: id });
        await this.release(env, 'materialized'); // trigger 1: right after the transition committed (never inside it)
        return 'continue';
      }
      return 'stop';
    }
  }

  /** One page = one transaction (contract §6.1): lock, page, Checkpoint A, insert recipients, advance cursor + counts. */
  private materializePage(env: ExecutionJobEnvelope, owner: string, topicId: string, channel: Channel): Promise<'more' | 'done' | 'stop'> {
    const id = env.payload.executionId;
    return this.unit(env, async (u) => {
      const e = await this.lockExecution(u, id);
      if (!e || e.status !== 'materializing' || e.leaseOwner !== owner || !e.audienceSnapshotId) return 'stop';
      let page;
      try {
        page = await this.resolution.page(u.scope, e.audienceSnapshotId, { cursor: e.materializationCursor, limit: this.tuning.pageSize });
      } catch (err) {
        if (err instanceof AudienceResolutionError && err.code === 'AUDIENCE_SNAPSHOT_NOT_FOUND') return 'stop'; // never re-capture
        throw err;
      }
      // Checkpoint A — live Eligibility v1.1 with the FROZEN version's parameters.
      const results = page.contactIds.length
        ? (await this.eligibility.evaluateInBatches(u.scope, { contactIds: page.contactIds, channel, purpose: 'marketing', topicId, topicPolicy: 'block_unsubscribed' })).results
        : [];
      const inserted = await this.insertRecipients(u, e, results);
      await this.testHooks.inPage?.({ executionId: id }); // inside the page transaction: a throw rolls the whole page back
      const byReason = mergeReasonCounts(e.skippedByReason as Record<string, number>, inserted.reasons);
      const last = page.cursor === null;
      const counts = { planned: e.planned + inserted.planned, skipped: e.skipped + inserted.skipped };
      if (!last) {
        await this.bump(u, e, {
          materializationCursor: page.cursor,
          ...counts,
          skippedByReason: byReason,
          lastProgressAt: new Date(),
          health: 'ok',
          leaseUntil: new Date(Date.now() + this.tuning.leaseMs),
        });
        return 'more';
      }
      const next = nextExecutionState({ status: 'materializing', pausedPhase: null, materializedAt: null }, 'materialized');
      if (!next.ok) return 'stop';
      const now = new Date();
      await this.bump(u, e, {
        status: next.status,
        materializationCursor: null,
        materializedAt: now,
        ...counts,
        skippedByReason: byReason,
        lastProgressAt: now,
        health: 'ok',
        leaseUntil: new Date(Date.now() + this.tuning.leaseMs),
      });
      await u.event('campaign.audience_materialized', e.campaignId, {
        executionId: e.id,
        capturedAt: (e.capturedAt ?? now).toISOString(),
        audienceSize: e.audienceSize ?? 0,
        planned: counts.planned,
        skipped: counts.skipped,
        skippedByReason: byReason,
      });
      return 'done';
    }, 120_000);
  }

  /**
   * Exactly-once recipients: `UNIQUE (execution_id, contact_id)` + ON CONFLICT DO NOTHING; only rows inserted NOW are
   * counted (a re-run page inserts nothing). Eligible → pending + address identity; ineligible → skipped (final) with
   * the evaluator's reason codes only — no address, name or content is stored. Returns the COUNTS of what was inserted
   * (computed in PostgreSQL): one small row per page instead of one object per recipient (Gate E: allocation per page).
   */
  private async insertRecipients(u: JobUnit, e: CampaignExecutionModel, results: EligibilityResult[]): Promise<{ planned: number; skipped: number; reasons: Record<string, number> }> {
    if (!results.length) return { planned: 0, skipped: 0, reasons: {} };
    // One JSON parameter, [[id, contact, address|null, status, "CODE,CODE"], …] in page order (Gate E, 2026-10-10): five
    // array parameters were each converted element by element into a PostgreSQL array literal by the driver.
    const rows = JSON.stringify(
      results.map((r) => [uuidV7(), r.contactId, r.eligible ? r.addressIdentityId : null, r.eligible ? 'pending' : 'skipped', r.eligible ? '' : [...new Set(r.reasons.map((x) => x.code))].join(',')]),
    );
    const [r] = await u.tx.$queryRaw<{ planned: number; skipped: number; reasons: Record<string, number> }[]>`
      WITH ins AS (
      INSERT INTO campaign_recipients (id, org_id, workspace_id, execution_id, contact_id, address_identity_id, status, reason_codes, final_at)
      SELECT x.id, ${e.orgId}::uuid, ${e.workspaceId}::uuid, ${e.id}::uuid, x.contact_id, x.address_identity_id, x.status,
             CASE WHEN x.reasons = '' THEN ARRAY[]::text[] ELSE string_to_array(x.reasons, ',') END,
             CASE WHEN x.status = 'skipped' THEN now() END
        FROM (SELECT (e->>0)::uuid AS id, (e->>1)::uuid AS contact_id, (e->>2)::uuid AS address_identity_id, e->>3 AS status, e->>4 AS reasons, n
                FROM jsonb_array_elements(${rows}::jsonb) WITH ORDINALITY AS t(e, n)) AS x
       ORDER BY x.n
      ON CONFLICT (execution_id, contact_id) DO NOTHING
      RETURNING status, reason_codes)
      SELECT (SELECT count(*)::int FROM ins WHERE status = 'pending') AS planned,
             (SELECT count(*)::int FROM ins WHERE status = 'skipped') AS skipped,
             (SELECT coalesce(jsonb_object_agg(code, n), '{}'::jsonb)
                FROM (SELECT code, count(*)::int AS n FROM ins, unnest(ins.reason_codes) AS code WHERE ins.status = 'skipped' GROUP BY code) g) AS reasons`;
    return r ?? { planned: 0, skipped: 0, reasons: {} };
  }

  // ─── delivery: claim → Checkpoint B → NullDeliveryPort → outcome (contract §6.3, §7.1, §10.3) ─────────────────

  private async deliver(env: ExecutionJobEnvelope, owner: string): Promise<Stop> {
    const id = env.payload.executionId;
    /**
     * Keyset over pending recipients within this run (they are created only during materialization and claimed in id
     * order): each claim starts after the last claimed id instead of walking every dead index entry left by earlier
     * claims (MEASURED: O(N²) buffer hits without it — 27 M at 100k). A full re-scan happens before concluding.
     */
    let afterId: string | null = null;
    for (;;) {
      // Sending rate (Phase 7.11): tokens are taken in the claim transaction BEFORE recipients are claimed, so a batch is
      // never larger than what may be sent now. Unused tokens are refunded after the batch.
      // (Assigned inside the claim transaction's callback; the cast keeps TypeScript from narrowing it to null.)
      let rate = null as { buckets: SendRateBucket[]; granted: number; waitMs: number } | null;
      // Claim (one transaction): execution still delivering under our lease; recipients pending, or queued/sending whose
      // claim expired (an interrupted runner) — FOR UPDATE SKIP LOCKED.
      const claimed = await this.withPageRetries(() =>
        this.unit(env, async (u) => {
          const e = await this.lockExecution(u, id);
          if (!e || e.status !== 'delivering' || e.leaseOwner !== owner) return null;
          let limit = this.tuning.deliveryBatch;
          const buckets = this.rateBuckets(e);
          if (buckets.length) {
            const t = await this.db.system.takeSendTokens(buckets, limit);
            rate = { buckets, granted: t.granted, waitMs: t.waitMs };
            if (t.granted === 0) {
              await this.bump(u, e, { lastProgressAt: new Date(), leaseUntil: new Date(Date.now() + this.tuning.leaseMs + Math.min(t.waitMs, IN_PROCESS_RATE_WAIT_MS)) });
              return 'rate' as const;
            }
            limit = t.granted;
          }
          // Two index-ordered claims on (execution_id, status, id) — one OR across statuses would scan and sort every
          // recipient of the execution per batch (MEASURED at 100k: 128 MB of temp files). Pending first; then claims
          // that expired (an interrupted runner), only if the batch is not full.
          const rows = afterId
            ? await u.tx.$queryRaw<{ id: string; contact_id: string; status: string }[]>`
                SELECT id, contact_id, status FROM campaign_recipients
                 WHERE execution_id = ${id}::uuid AND status = 'pending' AND id > ${afterId}::uuid
                 ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED`
            : await u.tx.$queryRaw<{ id: string; contact_id: string; status: string }[]>`
                SELECT id, contact_id, status FROM campaign_recipients
                 WHERE execution_id = ${id}::uuid AND status = 'pending'
                 ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
          const lastPending = rows.at(-1)?.id ?? null;
          if (lastPending) afterId = lastPending;
          if (rows.length < limit) {
            rows.push(
              ...(await u.tx.$queryRaw<{ id: string; contact_id: string; status: string }[]>`
                SELECT id, contact_id, status FROM campaign_recipients
                 WHERE execution_id = ${id}::uuid AND status IN ('queued', 'sending') AND (lease_until IS NULL OR lease_until < now())
                 ORDER BY id LIMIT ${limit - rows.length} FOR UPDATE SKIP LOCKED`),
            );
          }
          // An interrupted hand-off ('sending', claim expired): the receiver deduplicates by key (idempotentSend), so it
          // goes through Checkpoint B and the same key again; otherwise its outcome is unknown and is never resent.
          const unknown = this.delivery?.idempotentSend ? [] : rows.filter((r) => r.status === 'sending').map((r) => r.id);
          const take = rows.filter((r) => !unknown.includes(r.id));
          if (unknown.length) {
            await u.tx.$executeRaw`UPDATE campaign_recipients SET status = 'unknown', final_at = now(), updated_at = now(), lease_owner = NULL, lease_until = NULL WHERE id = ANY(${unknown}::uuid[])`;
            await this.bump(u, e, { unknown: e.unknown + unknown.length });
          }
          if (take.length) {
            await u.tx.$executeRaw`
              UPDATE campaign_recipients SET status = 'queued', lease_owner = ${owner},
                     lease_until = now() + make_interval(secs => ${this.tuning.recipientLeaseMs / 1000}::float8), updated_at = now()
               WHERE id = ANY(${take.map((r) => r.id)}::uuid[])`;
          }
          await this.bump(u, e, { lastProgressAt: new Date(), leaseUntil: new Date(Date.now() + this.tuning.leaseMs) });
          return take;
        }),
      );
      if (claimed === null) return 'stop';
      if (claimed === 'rate') {
        const waitMs = Math.max(rate!.waitMs, 1);
        if (waitMs > IN_PROCESS_RATE_WAIT_MS) throw new SendRateWait(waitMs);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (!claimed.length && rate) await this.db.system.refundSendTokens(rate.buckets, rate.granted);
      if (!claimed.length && afterId !== null) {
        afterId = null; // safety net: one full scan before concluding nothing is left
        continue;
      }
      if (!claimed.length) {
        await this.testHooks.beforeComplete?.({ executionId: id });
        if (await this.complete(env, owner)) return 'continue';
        // Not complete: recipients are still claimed by an interrupted runner (their claim has not expired). Wait for the
        // earliest expiry while holding our execution lease, then claim again (contract §10.3: an expired 'sending' claim
        // is re-handed off with the same key, deduplicated by the receiver).
        const waitMs = await this.unit(env, async (u) => {
          const e = await this.lockExecution(u, id);
          if (!e || e.status !== 'delivering' || e.leaseOwner !== owner) return null;
          const [m] = await u.tx.$queryRaw<{ ms: number | null }[]>`
            SELECT (extract(epoch FROM min(lease_until) - now()) * 1000)::float8 AS ms FROM campaign_recipients
             WHERE execution_id = ${id}::uuid AND status IN ('queued', 'sending') AND lease_until > now()`;
          await this.bump(u, e, { leaseUntil: new Date(Date.now() + this.tuning.leaseMs + this.tuning.recipientLeaseMs) });
          return m?.ms ?? 0;
        });
        if (waitMs === null) return 'stop';
        await new Promise((r) => setTimeout(r, Math.min(Math.max(waitMs + 20, 20), this.tuning.recipientLeaseMs + 20)));
        continue;
      }
      await this.testHooks.beforeCheckpointB?.({ executionId: id });

      // Checkpoint B — FRESH live eligibility immediately before hand-off; fail closed (an error leaves them queued).
      const version = await this.unit(env, async (u) => {
        const e = await u.tx.campaignExecution.findUniqueOrThrow({ where: { id }, select: { versionId: true } });
        return u.tx.campaignVersion.findUniqueOrThrow({ where: { id: e.versionId } });
      });
      const frozen = readVersionSnapshot(version.snapshot);
      const topicId = frozen.topic.topicIds[0];
      const channel = frozen.channel;
      const b0 = performance.now();
      const fresh = await this.withPageRetries(() =>
        this.unit(env, async (u) =>
          (await this.eligibility.evaluateInBatches(u.scope, { contactIds: claimed.map((r) => r.contact_id), channel, purpose: 'marketing', topicId, topicPolicy: 'block_unsubscribed' })).results,
        ),
      );
      this.onTiming?.('checkpointB', performance.now() - b0);
      const byContact = new Map(fresh.map((r) => [r.contactId, r]));
      const toSend = await this.unit(env, async (u) => {
        const e = await this.lockExecution(u, id);
        if (!e || e.status !== 'delivering' || e.leaseOwner !== owner) {
          // Paused or cancelled since the claim: hand nothing off; give our claims back (still queued) so a resumed
          // runner re-claims them at once and a cancel follow-up cancels them.
          await u.tx.$executeRaw`UPDATE campaign_recipients SET lease_owner = NULL, lease_until = NULL, updated_at = now()
                                  WHERE id = ANY(${claimed.map((r) => r.id)}::uuid[]) AND status = 'queued' AND lease_owner = ${owner}`;
          return null;
        }
        const blocked: { id: string; codes: string[] }[] = [];
        const ok: { id: string; address: string }[] = [];
        for (const r of claimed) {
          const x = byContact.get(r.contact_id);
          if (x?.eligible && x.addressIdentityId) ok.push({ id: r.id, address: x.addressIdentityId });
          else blocked.push({ id: r.id, codes: x ? [...new Set(x.reasons.map((y) => y.code))] : ['CONTACT_DELETED'] });
        }
        // Set-based writes keyed by the primary key (`r.id = ANY` gives the planner the index condition).
        if (blocked.length) {
          const ids = blocked.map((b) => b.id);
          await u.tx.$executeRaw`
            UPDATE campaign_recipients r SET status = 'skipped_at_send', reason_codes = string_to_array(x.codes, ','), final_at = now(),
                   updated_at = now(), lease_owner = NULL, lease_until = NULL
              FROM unnest(${ids}::uuid[], ${blocked.map((b) => b.codes.join(','))}::text[]) AS x(id, codes)
             WHERE r.id = ANY(${ids}::uuid[]) AND r.id = x.id AND r.status = 'queued' AND r.lease_owner = ${owner}`;
        }
        if (ok.length) {
          const ids = ok.map((o) => o.id);
          await u.tx.$executeRaw`
            UPDATE campaign_recipients r SET status = 'sending', address_identity_id = x.address, attempts = r.attempts + 1, updated_at = now()
              FROM unnest(${ids}::uuid[], ${ok.map((o) => o.address)}::uuid[]) AS x(id, address)
             WHERE r.id = ANY(${ids}::uuid[]) AND r.id = x.id AND r.status = 'queued' AND r.lease_owner = ${owner}`;
        }
        if (blocked.length) {
          await this.bump(u, e, {
            skipped: e.skipped + blocked.length,
            skippedByReason: mergeReasons(e.skippedByReason as Record<string, number>, blocked.map((b) => b.codes)),
            lastProgressAt: new Date(),
          });
        }
        return ok;
      });
      if (toSend === null) {
        if (rate) await this.db.system.refundSendTokens(rate.buckets, rate.granted).catch(() => undefined);
        return 'stop';
      }

      // Hand-off OUTSIDE any transaction (Phase 8 shape): recipient id = idempotency key.
      // Outcome taxonomy (Phase 7.7, docs/architecture/delivery-providers.md): unknown → final 'unknown' (never resent);
      // rejected → failed; transient → queued (retried); throttled / configuration → this batch stops, the recipients not
      // handed off go back to queued WITHOUT consuming an attempt, and the run backs off as a durable delayed job.
      const outcomes: { id: string; status: 'sent' | 'queued' | 'failed' | 'unknown' | 'requeue'; code: string | null }[] = [];
      let backpressure: ProviderBackpressure | null = null;
      for (const s of toSend) {
        if (backpressure) {
          outcomes.push({ id: s.id, status: 'requeue', code: null });
          continue;
        }
        const r = await this.delivery!.deliver({ channel, orgId: env.tenant.orgId, workspaceId: env.tenant.workspaceId, executionId: id, recipientId: s.id, addressIdentityId: s.address, idempotencyKey: s.id });
        if (r.ok) {
          outcomes.push({ id: s.id, status: 'sent', code: null });
          continue;
        }
        const kind = failureKind(r);
        providerFailures.inc({ kind });
        if (kind === 'throttled' || kind === 'configuration') {
          backpressure = new ProviderBackpressure(kind, r.code, kind === 'throttled' ? Math.max(1, r.retryAfterSeconds ?? 60) * 1_000 : 0);
          outcomes.push({ id: s.id, status: 'requeue', code: r.code });
        } else outcomes.push({ id: s.id, status: kind === 'unknown' ? 'unknown' : kind === 'transient' ? 'queued' : 'failed', code: r.code });
      }
      // Outcomes: conditional on the claim (status 'sending' and our lease) — independent of a later pause/cancel, the
      // hand-off has happened.
      await this.withPageRetries(() =>
        this.unit(env, async (u) => {
          const e = await this.lockExecution(u, id);
          if (!e) return;
          const sentIds = outcomes.filter((o) => o.status === 'sent').map((o) => o.id);
          const unknownIds = outcomes.filter((o) => o.status === 'unknown').map((o) => o.id);
          const requeueIds = outcomes.filter((o) => o.status === 'requeue').map((o) => o.id);
          const others = outcomes.filter((o) => o.status === 'queued' || o.status === 'failed');
          // Unknown outcome (the provider may have accepted it): final, never resent (contract §10.3).
          const unknown = unknownIds.length
            ? await u.tx.$executeRaw`UPDATE campaign_recipients SET status = 'unknown', final_at = now(), updated_at = now(), lease_owner = NULL, lease_until = NULL
                                      WHERE id = ANY(${unknownIds}::uuid[]) AND status = 'sending' AND lease_owner = ${owner}`
            : 0;
          // Back-pressure: not handed off (or refused for a reason that is not about this recipient) — attempt refunded.
          if (requeueIds.length) {
            await u.tx.$executeRaw`UPDATE campaign_recipients SET status = 'queued', attempts = greatest(attempts - 1, 0), lease_owner = NULL, lease_until = NULL, updated_at = now()
                                    WHERE id = ANY(${requeueIds}::uuid[]) AND status = 'sending' AND lease_owner = ${owner}`;
          }
          const sent = sentIds.length
            ? await u.tx.$executeRaw`UPDATE campaign_recipients SET status = 'sent', final_at = now(), updated_at = now(), lease_owner = NULL, lease_until = NULL
                                      WHERE id = ANY(${sentIds}::uuid[]) AND status = 'sending' AND lease_owner = ${owner}`
            : 0;
          let failed = 0;
          if (others.length) {
            // Retryable → back to queued with the claim dropped, so the next batch re-claims it (attempts already +1);
            // permanent, or the attempt limit reached → failed (final).
            const ids = others.map((o) => o.id);
            const rows = await u.tx.$queryRaw<{ status: string }[]>`
              UPDATE campaign_recipients r
                 SET status = CASE WHEN x.permanent OR r.attempts >= ${this.tuning.maxDeliveryAttempts} THEN 'failed' ELSE 'queued' END,
                     failure_code = x.code,
                     final_at = CASE WHEN x.permanent OR r.attempts >= ${this.tuning.maxDeliveryAttempts} THEN now() END,
                     lease_owner = NULL, lease_until = NULL, updated_at = now()
                FROM unnest(${ids}::uuid[], ${others.map((o) => o.code ?? 'UNKNOWN')}::text[], ${others.map((o) => o.status === 'failed')}::boolean[]) AS x(id, code, permanent)
               WHERE r.id = ANY(${ids}::uuid[]) AND r.id = x.id AND r.status = 'sending' AND r.lease_owner = ${owner}
              RETURNING r.status`;
            failed = rows.filter((r) => r.status === 'failed').length;
          }
          // Usage (Phase 7.13): live deliveries only, in the same transaction as the outcomes.
          await recordUsage(u.tx, messagesSentUsage(this.delivery!.mode, env.tenant, id, sentIds.slice(0, sent), new Date()));
          await this.bump(u, e, { sent: e.sent + sent, failed: e.failed + failed, unknown: e.unknown + unknown, lastProgressAt: new Date(), health: 'ok', leaseUntil: new Date(Date.now() + this.tuning.leaseMs) });
        }),
      );
      this.onTiming?.('deliveryBatch', performance.now() - b0);
      for (const o of outcomes) deliveryOutcomes.inc({ outcome: o.status === 'queued' ? 'retry' : o.status === 'requeue' ? 'requeued' : o.status });
      // Tokens not used by a hand-off (skipped at Checkpoint B, requeued by back-pressure) go back to the buckets.
      if (rate) {
        // Every request that reached the provider used a token (a refused one too); requeued-without-request did not.
        const handedOff = outcomes.filter((o) => o.status !== 'requeue' || o.code !== null).length;
        await this.db.system.refundSendTokens(rate.buckets, rate.granted - handedOff).catch(() => undefined);
      }
      if (backpressure) throw backpressure;
    }
  }

  /**
   * Completion is DERIVED from persisted recipient rows (never from "the loop ended"): no recipient may be pending,
   * queued or sending; counts are recomputed from the rows and stored. Then campaign completed + campaign.completed.
   */
  private async complete(env: ExecutionJobEnvelope, owner: string): Promise<boolean> {
    const id = env.payload.executionId;
    const done = await this.unit(env, async (u) => {
      const e = await this.lockCampaignThenExecution(u, id);
      if (!e || e.status !== 'delivering' || e.leaseOwner !== owner) return false;
      const agg = await u.tx.$queryRaw<{ status: string; n: bigint }[]>`SELECT status, count(*)::bigint AS n FROM campaign_recipients WHERE execution_id = ${id}::uuid GROUP BY status`;
      const by = Object.fromEntries(agg.map((r) => [r.status, Number(r.n)])) as Record<string, number>;
      if (NON_FINAL_RECIPIENT.some((s) => (by[s] ?? 0) > 0)) return false;
      const reasons = await u.tx.$queryRaw<{ code: string; n: bigint }[]>`
        SELECT code, count(*)::bigint AS n FROM campaign_recipients, unnest(reason_codes) AS code
         WHERE execution_id = ${id}::uuid AND status IN ('skipped', 'skipped_at_send') GROUP BY code`;
      const total = Object.values(by).reduce((a, x) => a + x, 0);
      const counts: CampaignCounts = {
        planned: total - (by.skipped ?? 0),
        skipped: (by.skipped ?? 0) + (by.skipped_at_send ?? 0),
        sent: by.sent ?? 0,
        failed: by.failed ?? 0,
        cancelled: by.cancelled ?? 0,
        unknown: by.unknown ?? 0,
      };
      const next = nextExecutionState({ status: 'delivering', pausedPhase: null, materializedAt: e.materializedAt }, 'all_final');
      if (!next.ok) return false;
      await this.bump(u, e, {
        status: next.status,
        completedAt: new Date(),
        ...counts,
        skippedByReason: Object.fromEntries(reasons.map((r) => [r.code, Number(r.n)])),
        health: 'ok',
        leaseOwner: null,
        leaseUntil: null,
      });
      await this.setCampaignStatus(u, e.campaignId, next.status);
      await u.event('campaign.completed', e.campaignId, { executionId: e.id, counts });
      await u.audit({ action: 'campaign.execution_completed', targetType: 'campaign', targetId: e.campaignId, metadata: { executionId: e.id, counts } });
      return true;
    });
    if (done) await this.release(env, null); // normally already released at materialization; idempotent
    return done;
  }

  // ─── terminal follow-up and snapshot release (contract §6.2 Cancel, §6.4) ─────────────────────────────────────

  /**
   * A cancelled or failed execution: pending/queued recipients → cancelled in chunks of 1,000 (they will never be
   * handed off); a hand-off interrupted by a crash ('sending', claim expired) → unknown (never resent after a stop).
   * Then the release procedure. Idempotent.
   */
  async finalize(env: ExecutionJobEnvelope): Promise<void> {
    const id = env.payload.executionId;
    for (;;) {
      const more = await this.unit(env, async (u) => {
        const e = await this.lockExecution(u, id);
        if (!e || !['cancelled', 'failed'].includes(e.status)) return false;
        // Claim first (one index-ordered SELECT … FOR UPDATE SKIP LOCKED per status on (execution_id, status, id)), then
        // update the claimed ids by primary key — the shape delivery uses. Never `UPDATE … WHERE id IN (SELECT … FOR
        // UPDATE SKIP LOCKED)`: with stale statistics (reltuples -1 after a bulk load, before autoanalyze) the planner
        // chose a nested-loop semi join that re-ran the locking subquery once per row of the workspace (MEASURED, 6.13
        // lifecycle-at-scale: the first chunk after cancel at 100k ran into the 15 s statement timeout; finalize never
        // completed and 64,000 recipients stayed open).
        const claim = async (status: 'pending' | 'queued' | 'sending', limit: number): Promise<string[]> => {
          if (limit <= 0) return [];
          const rows =
            status === 'sending'
              ? await u.tx.$queryRaw<{ id: string }[]>`
                  SELECT id FROM campaign_recipients WHERE execution_id = ${id}::uuid AND status = 'sending'
                     AND (lease_until IS NULL OR lease_until < now()) ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED`
              : await u.tx.$queryRaw<{ id: string }[]>`
                  SELECT id FROM campaign_recipients WHERE execution_id = ${id}::uuid AND status = ${status}
                   ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
          return rows.map((r) => r.id);
        };
        const pending = await claim('pending', this.tuning.pageSize);
        const cancelled = [...pending, ...(await claim('queued', this.tuning.pageSize - pending.length))];
        const unknown = await claim('sending', this.tuning.pageSize);
        if (cancelled.length) {
          await u.tx.$executeRaw`UPDATE campaign_recipients SET status = 'cancelled', final_at = now(), updated_at = now(), lease_owner = NULL, lease_until = NULL
                                  WHERE id = ANY(${cancelled}::uuid[])`;
        }
        if (unknown.length) {
          await u.tx.$executeRaw`UPDATE campaign_recipients SET status = 'unknown', final_at = now(), updated_at = now(), lease_owner = NULL, lease_until = NULL
                                  WHERE id = ANY(${unknown}::uuid[])`;
        }
        if (cancelled.length || unknown.length) await this.bump(u, e, { cancelled: e.cancelled + cancelled.length, unknown: e.unknown + unknown.length });
        return cancelled.length + unknown.length > 0;
      });
      if (!more) break;
    }
    await this.release(env, null);
  }

  /**
   * Release procedure (contract §6.4), identical for every trigger: R1 under the execution lock (the same lock every
   * page takes) only if releasable; then purge continuation in new transactions. `reason` null = derived from state.
   */
  async release(env: ExecutionJobEnvelope, reason: 'materialized' | 'cancelled' | 'failed' | null): Promise<boolean> {
    const id = env.payload.executionId;
    const r = await this.unit(env, async (u) => {
      const e = await this.lockExecution(u, id);
      if (!e || !e.startedAt || !isSnapshotReleasable({ status: e.status as never, materializedAt: e.materializedAt })) return null;
      const why = reason ?? (e.status === 'cancelled' ? 'cancelled' : e.status === 'failed' ? 'failed' : 'materialized');
      const res = await this.resolution.releaseByKey(u.scope, e.id, why);
      if (!e.snapshotReleasedAt) await this.bump(u, e, { snapshotReleasedAt: new Date() });
      return { res, why };
    });
    if (!r) return false;
    let { res } = r;
    while (res.membersRemaining) res = await this.unit(env, (u) => this.resolution.releaseByKey(u.scope, id, r.why));
    return true;
  }

  // ─── recovery sweep (contract §6.4 "Recovery sweep", §11) ─────────────────────────────────────────────────────

  /**
   * Finds, per tenant, executions to recover and dispatches the matching job; then the Audience-side snapshot sweep.
   * Discovery returns workspace pairs only; everything else runs inside withTenant for that workspace. Not a scheduler:
   * executions scheduled for a later time are never started here (Phase 8).
   */
  async sweep(now = new Date()): Promise<{ workspaces: number; start: number; run: number; finalize: number; release: number; orphansReleased: number; purged: number }> {
    const report = { workspaces: 0, start: 0, run: 0, finalize: 0, release: 0, orphansReleased: 0, purged: 0 };
    const staleBefore = new Date(now.getTime() - 60_000);
    const pairs = await this.db.system.workspacesWithCampaignRecovery(staleBefore);
    report.workspaces = pairs.length;
    for (const ws of pairs) {
      const env = this.systemEnvelope(ws, randomUUID());
      const found = await this.unit(env, async (u) => ({
        run: await u.tx.$queryRaw<{ id: string }[]>`SELECT id FROM campaign_executions WHERE status IN ('materializing', 'delivering') AND (lease_until IS NULL OR lease_until < now())`,
        start: await u.tx.$queryRaw<{ id: string }[]>`
          SELECT e.id FROM campaign_executions e JOIN campaign_versions v ON v.id = e.version_id
           WHERE e.status = 'pending' AND v.reason = 'sent_now' AND e.send_at <= ${staleBefore}`,
        finalize: await u.tx.$queryRaw<{ id: string }[]>`
          SELECT e.id FROM campaign_executions e WHERE e.status IN ('cancelled', 'failed')
             AND EXISTS (SELECT 1 FROM campaign_recipients r WHERE r.execution_id = e.id AND r.status IN ('pending', 'queued', 'sending'))`,
        release: await u.tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM campaign_executions WHERE started_at IS NOT NULL AND snapshot_released_at IS NULL
             AND (materialized_at IS NOT NULL OR status IN ('completed', 'cancelled', 'failed'))`,
      }));
      // Recovered jobs keep the execution's correlation (the request that scheduled it), so its whole history joins.
      const ids = [...found.run, ...found.start, ...found.finalize, ...found.release].map((r) => r.id);
      const correlation = new Map(
        ids.length
          ? (await this.unit(env, (u) =>
              u.tx.$queryRaw<{ execution_id: string; correlation_id: string }[]>`
                SELECT e.id::text AS execution_id, d.correlation_id::text AS correlation_id
                  FROM campaign_executions e
                  JOIN LATERAL (SELECT correlation_id FROM domain_events
                                 WHERE org_id = e.org_id AND aggregate_type = 'campaign' AND aggregate_id = e.campaign_id AND type = 'campaign.scheduled' AND payload->>'executionId' = e.id::text
                                 LIMIT 1) d ON true
                 WHERE e.id = ANY(${ids}::uuid[])`,
            )).map((r) => [r.execution_id, r.correlation_id] as const)
          : [],
      );
      const send = (job: ExecutionJobName, id: string) => this.dispatch(job, ws, id, correlation.has(id) ? { correlationId: correlation.get(id)! } : {});
      for (const r of found.run) send(EXECUTION_JOBS.run, r.id), report.run++;
      for (const r of found.start) send(EXECUTION_JOBS.start, r.id), report.start++;
      for (const r of found.finalize) send(EXECUTION_JOBS.finalize, r.id), report.finalize++;
      for (const r of found.release) send(EXECUTION_JOBS.release, r.id), report.release++;
    }
    // Audience side (contract §6.4 step 2): orphans and incomplete purges, through the Audience port only.
    const cleanup = await this.db.system.workspacesWithSnapshotCleanup('campaign_execution', new Date(now.getTime() - 3_600_000));
    for (const ws of cleanup) {
      const env = this.systemEnvelope(ws, randomUUID());
      const unreleased = await this.unit(env, (u) => this.resolution.listUnreleased(u.scope, 'campaign_execution', new Date(now.getTime() - 3_600_000), 100));
      for (const s of unreleased) {
        const owner = await this.unit(env, (u) => u.tx.campaignExecution.findUnique({ where: { id: s.ownerId }, select: { status: true, materializedAt: true, startedAt: true } }));
        if (!owner) {
          let res = await this.unit(env, (u) => this.resolution.releaseByKey(u.scope, s.captureKey, 'orphan_sweep'));
          while (res.membersRemaining) res = await this.unit(env, (u) => this.resolution.releaseByKey(u.scope, s.captureKey, 'orphan_sweep'));
          report.orphansReleased++;
        } else if (isSnapshotReleasable({ status: owner.status as never, materializedAt: owner.materializedAt })) {
          await this.release({ ...env, payload: { executionId: s.ownerId, attempt: 0 } }, null);
          report.release++;
        } // else: live execution (materializing / paused while materializing) — leave it
      }
      const unpurged = await this.unit(env, (u) => this.resolution.listReleasedUnpurged(u.scope, 'campaign_execution', 100));
      for (const s of unpurged) {
        let res = await this.unit(env, (u) => this.resolution.releaseByKey(u.scope, s.captureKey, 'orphan_sweep'));
        while (res.membersRemaining) res = await this.unit(env, (u) => this.resolution.releaseByKey(u.scope, s.captureKey, 'orphan_sweep'));
        report.purged++;
      }
    }
    this.log.log(JSON.stringify({ msg: 'campaign recovery sweep', ...report }));
    return report;
  }

  private systemEnvelope(ws: { orgId: string; workspaceId: string }, correlationId: string): ExecutionJobEnvelope {
    return { tenant: ws, actor: { type: 'system', id: null }, correlationId, payload: { executionId: randomUUID(), attempt: 0 } };
  }
}

function mergeReasons(base: Record<string, number>, codeLists: string[][]): Record<string, number> {
  const out = { ...base };
  for (const codes of codeLists) for (const c of codes) out[c] = (out[c] ?? 0) + 1;
  return out;
}

function mergeReasonCounts(base: Record<string, number>, add: Record<string, number>): Record<string, number> {
  const out = { ...base };
  for (const [c, n] of Object.entries(add)) out[c] = (out[c] ?? 0) + n;
  return out;
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300));
