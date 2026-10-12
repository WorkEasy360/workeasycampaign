import type { Channel } from '@workeasy/shared';
import { isDeepStrictEqual } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import type { AudienceResolutionV1_1 } from '@workeasy/audience-core';
import type { CampaignExecutionModel, Database, Tx } from '@workeasy/db';
import type {
  CampaignVersionedCommandRequest,
  CampaignView,
  ExecutionSummary,
  ReadinessFinding,
  RescheduleCampaignRequest,
  ScheduleCampaignRequest,
} from '@workeasy/shared';
import { v7 as uuidv7 } from 'uuid';
import { AppError, Errors } from '../../../common/errors.js';
import type { TenantRequestContext } from '../../../common/request-context.js';
import { AUDIENCE_RESOLUTION, DATABASE } from '../../../infrastructure/providers.js';
import { inTenant } from '../../tenancy/application/tenant-tx.js';
import { channelSpec } from '../domain/channels.js';
import { type CampaignDraft, draftChangePermissions } from '../domain/draft.js';
import { type ExecutionEvent, nextExecutionState } from '../domain/execution.js';
import { type CampaignCommand, decideCommand } from '../domain/lifecycle.js';
import { readinessFindings, startFailure } from '../domain/readiness.js';
import { assertNewSnapshot, buildVersionSnapshot, contentHash, readVersionSnapshot } from '../domain/version.js';
import { campaignNotFound, rejectionError } from './campaign-errors.js';
import { CampaignsService } from './campaigns.service.js';
import { type CampaignRow, draftOf, executionSummary, lifecycleState } from './campaign-views.js';
import { EXECUTION_JOBS, type ExecutionJobName } from './execution-jobs.js';
import { ExecutionService } from './execution.service.js';
import { PREFLIGHT_RETRY_AFTER_SECONDS, PreflightService } from './preflight.service.js';

const ACTIVE_EXECUTION = ['pending', 'materializing', 'delivering', 'paused'];

/**
 * Lifecycle commands (milestone 6.8; contract §2.2, §15 rows 11–17 and 20). Each command: authorize (route), lock the
 * campaign row, let the domain decide (expectedVersion BEFORE any outcome for versioned commands), then write campaign
 * + version/execution + events + audit in ONE transaction. Executions are PERSISTED only: nothing here starts,
 * materializes, delivers, leases or releases anything (milestone 6.9, Gate G3). Production delivery stays disabled
 * (`CAMPAIGN_DELIVERY_MODE`, enforced by the domain).
 */
@Injectable()
export class LifecycleService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIENCE_RESOLUTION) private readonly resolution: AudienceResolutionV1_1<Tx>,
    private readonly campaigns: CampaignsService,
    private readonly preflight: PreflightService,
    private readonly executions: ExecutionService,
  ) {}

  /** Follow-up execution work (6.9), dispatched only AFTER the command's transaction committed. */
  private follow(ctx: TenantRequestContext, job: ExecutionJobName, executionId: string): void {
    this.executions.dispatch(job, { orgId: ctx.access.orgId, workspaceId: ctx.access.workspaceId! }, executionId, {
      actor: { type: 'user', id: ctx.principal.userId },
      correlationId: ctx.meta.requestId,
    });
  }

  /**
   * Row 11: schedule (mode 'at') and send-now (mode 'now'). Order: cheap decision (version, state, delivery) →
   * pre-flight on the draft with the requested schedule (read-only, own transaction: no lock held during Audience
   * reads) → under the row lock the domain decides again with the pre-flight result; any draft change since the
   * pre-flight bumped the version, so it is a version_conflict, never a version of an unchecked draft. The version
   * freezes exactly the locked draft; the execution references it and is created `pending` only.
   */
  async schedule(ctx: TenantRequestContext, campaignId: string, req: ScheduleCampaignRequest): Promise<CampaignView> {
    const command: CampaignCommand = req.mode === 'now' ? 'send_now' : 'schedule';
    const base = { actor: this.campaigns.actor(ctx), expectedVersion: req.expectedVersion, deliveryAvailable: this.campaigns.deliveryAvailable };
    const row = await inTenant(this.db, ctx, ({ tx }) => this.read(tx, campaignId));
    const early = decideCommand(lifecycleState(row), command, { ...base, preflightErrors: 0 });
    if (early.outcome === 'rejected') throw rejectionError(early.code, early.message);
    if (early.outcome === 'noop') return this.campaigns.get(ctx, campaignId);

    const draft = draftOf(row);
    const schedule: CampaignDraft['schedule'] = {
      mode: req.mode,
      sendAt: req.mode === 'at' ? new Date(req.sendAt!).toISOString() : null,
      timezone: req.timezone ?? draft.schedule.timezone,
    };
    const checked = await this.preflight.evaluate(ctx, { ...draft, schedule });
    // Degraded mode (contract §3.3): a version is never frozen without an authoritative audience check. If that is the
    // only blocker, answer "retry shortly" (recovery was requested by the pre-flight); nothing is written.
    const blocking = errorsOf(checked.findings);
    if (checked.audienceUnavailable && blocking.every((f) => f.code === 'ELIGIBILITY_ESTIMATE_UNAVAILABLE')) {
      throw new AppError('PREFLIGHT_UNAVAILABLE', 409, 'The audience is being prepared. Try again shortly.', undefined, { 'retry-after': String(PREFLIGHT_RETRY_AFTER_SECONDS) }, blocking);
    }

    let startNow: string | null = null;
    const view = await this.campaigns.write(ctx, async (uow) => {
      const locked = await this.campaigns.lock(uow.tx, campaignId);
      const decision = decideCommand(lifecycleState(locked), command, { ...base, preflightErrors: checked.errors });
      if (decision.outcome === 'rejected') throw rejectionError(decision.code, decision.message, errorsOf(checked.findings));
      if (decision.outcome === 'noop') return this.campaigns.viewById(uow.tx, ctx, campaignId);

      const snapshot = buildVersionSnapshot({ ...draftOf(locked), schedule }, schedule);
      assertNewSnapshot(snapshot); // validated on write (contract §4.1), against its own schema id
      const hash = contentHash(snapshot);
      const [next] = await uow.tx.$queryRaw<{ number: number; run: number }[]>`
        SELECT coalesce((SELECT max(number) FROM campaign_versions WHERE campaign_id = ${campaignId}::uuid), 0) + 1 AS number,
               coalesce((SELECT max(run_number) FROM campaign_executions WHERE campaign_id = ${campaignId}::uuid), 0) + 1 AS run`;
      const number = Number(next!.number);
      const run = Number(next!.run);
      const versionId = uuidv7();
      const executionId = uuidv7();
      const reason = command === 'send_now' ? 'sent_now' : 'scheduled';
      const sendAt = schedule.sendAt ? new Date(schedule.sendAt) : new Date();
      await uow.tx.campaignVersion.create({
        data: { id: versionId, orgId: ctx.access.orgId, workspaceId: ctx.access.workspaceId!, campaignId, number, schema: snapshot.schema, snapshot, contentHash: hash, reason, createdByUserId: ctx.principal.userId },
      });
      await uow.tx.campaignExecution.create({
        data: { id: executionId, orgId: ctx.access.orgId, workspaceId: ctx.access.workspaceId!, campaignId, versionId, runNumber: run, status: 'pending', sendAt, initiatedByUserId: ctx.principal.userId },
      });
      await uow.tx.campaign.update({
        where: { id: campaignId },
        // The draft keeps the scheduled time, so after an unschedule the draft equals this version (contract §4.2).
        data: { status: decision.to, schedule, currentVersionId: versionId, currentExecutionId: executionId, updatedAt: new Date(), version: { increment: 1 } },
      });
      await uow.event('campaign.version_created', campaignId, { versionId, number, reason, contentHash: hash, schema: snapshot.schema });
      await uow.event('campaign.scheduled', campaignId, { versionId, executionId, sendAt: sendAt.toISOString(), mode: req.mode });
      await uow.audit({ action: 'campaign.scheduled', targetType: 'campaign', targetId: campaignId, metadata: { versionId, executionId, mode: req.mode } });
      if (req.mode === 'now') startNow = executionId;
      return this.campaigns.viewById(uow.tx, ctx, campaignId);
    });
    // Send-now starts right away (6.9). A later send time waits for the Phase 8 scheduler (due discovery is deferred).
    if (startNow) this.follow(ctx, EXECUTION_JOBS.start, startNow);
    return view;
  }

  /** Row 12. Only the execution's send time (and the draft's schedule) change; the version keeps the original intent. */
  async reschedule(ctx: TenantRequestContext, campaignId: string, req: RescheduleCampaignRequest): Promise<CampaignView> {
    return this.campaigns.write(ctx, async (uow) => {
      const row = await this.campaigns.lock(uow.tx, campaignId);
      const decision = decideCommand(lifecycleState(row), 'reschedule', {
        actor: this.campaigns.actor(ctx),
        expectedVersion: req.expectedVersion,
        deliveryAvailable: this.campaigns.deliveryAvailable,
      });
      if (decision.outcome === 'rejected') throw rejectionError(decision.code, decision.message);
      const execution = this.activeExecution(row, ['pending']);
      const draft = draftOf(row);
      const schedule: CampaignDraft['schedule'] = { mode: 'at', sendAt: new Date(req.sendAt).toISOString(), timezone: req.timezone ?? draft.schedule.timezone };
      if (decision.outcome === 'noop' || (execution.sendAt.toISOString() === schedule.sendAt && draft.schedule.timezone === schedule.timezone)) {
        return this.campaigns.viewById(uow.tx, ctx, campaignId); // same time: no-op (after the version check)
      }
      // Pre-flight re-runs the schedule checks only (contract §4.2).
      const scheduleErrors = readinessFindings({ ...draft, schedule }, { now: new Date(), deliveryAvailable: true }).filter((f) => f.section === 'schedule' && f.severity === 'error');
      if (scheduleErrors.length) throw rejectionError('PREFLIGHT_FAILED', 'Choose a valid send time', scheduleErrors);
      await this.updateExecution(uow.tx, execution, { sendAt: new Date(schedule.sendAt!) }, ['pending']);
      await uow.tx.campaign.update({ where: { id: campaignId }, data: { schedule, updatedAt: new Date(), version: { increment: 1 } } });
      await uow.event('campaign.rescheduled', campaignId, { executionId: execution.id, from: execution.sendAt.toISOString(), to: schedule.sendAt! });
      await uow.audit({ action: 'campaign.rescheduled', targetType: 'campaign', targetId: campaignId, metadata: { executionId: execution.id } });
      return this.campaigns.viewById(uow.tx, ctx, campaignId);
    });
  }

  /** Row 13. The pending execution is cancelled; the campaign returns to draft; the version stays in history. */
  async unschedule(ctx: TenantRequestContext, campaignId: string, req: CampaignVersionedCommandRequest): Promise<CampaignView> {
    let done: string | null = null;
    const view = await this.transition(ctx, campaignId, 'unschedule', req.expectedVersion, async (uow, row) => {
      const execution = this.activeExecution(row, ['pending']);
      done = execution.id;
      await this.updateExecution(uow.tx, execution, { event: 'cancel', cancelledAt: new Date(), cancelledByUserId: ctx.principal.userId }, ['pending']);
      await uow.tx.campaign.update({ where: { id: campaignId }, data: { status: 'draft', currentExecutionId: null, updatedAt: new Date(), version: { increment: 1 } } });
      await uow.event('campaign.unscheduled', campaignId, { executionId: execution.id, versionId: execution.versionId });
      await uow.audit({ action: 'campaign.unscheduled', targetType: 'campaign', targetId: campaignId, metadata: { executionId: execution.id } });
    });
    if (done) this.follow(ctx, EXECUTION_JOBS.finalize, done);
    return view;
  }

  /** Row 14. sending → paused; the execution remembers its phase. */
  /**
   * Phase 7.11 (amendment §R): set or clear a run's sending limit while it can still send (pending, materializing,
   * delivering, paused). Not a lifecycle transition: the campaign's version is unchanged; the engine reads the limit at
   * every batch. Audited.
   */
  async setSendingRate(ctx: TenantRequestContext, campaignId: string, executionId: string, maxPerHour: number | null): Promise<ExecutionSummary> {
    return inTenant(this.db, ctx, async (uow) => {
      const rows = await uow.tx.$queryRaw<{ id: string }[]>`SELECT id FROM campaign_executions WHERE id = ${executionId}::uuid AND campaign_id = ${campaignId}::uuid FOR UPDATE`;
      const campaign = await uow.tx.campaign.findFirst({ where: { id: campaignId, deletedAt: null }, select: { id: true } });
      if (!rows.length || !campaign) throw Errors.notFound('Execution');
      const e = await uow.tx.campaignExecution.findUniqueOrThrow({ where: { id: executionId } });
      if (!['pending', 'materializing', 'delivering', 'paused'].includes(e.status)) throw Errors.precondition('This run has finished; its sending speed can no longer change');
      if (e.maxPerHour === maxPerHour) return executionSummary(e);
      const updated = await uow.tx.campaignExecution.update({ where: { id: executionId }, data: { maxPerHour } });
      await uow.audit({ action: 'campaign.sending_rate_changed', targetType: 'campaign', targetId: campaignId, metadata: { executionId, from: e.maxPerHour, to: maxPerHour } });
      return executionSummary(updated);
    });
  }

  async pause(ctx: TenantRequestContext, campaignId: string): Promise<CampaignView> {
    return this.transition(ctx, campaignId, 'pause', undefined, async (uow, row) => {
      const execution = this.activeExecution(row, ['materializing', 'delivering']);
      const phase = execution.status as 'materializing' | 'delivering';
      await this.updateExecution(uow.tx, execution, { event: 'pause', pausedByUserId: ctx.principal.userId }, ['materializing', 'delivering']);
      await uow.tx.campaign.update({ where: { id: campaignId }, data: { status: 'paused', updatedAt: new Date(), version: { increment: 1 } } });
      await uow.event('campaign.paused', campaignId, { executionId: execution.id, phase });
      await uow.audit({ action: 'campaign.paused', targetType: 'campaign', targetId: campaignId, metadata: { executionId: execution.id } });
    });
  }

  /**
   * Row 15. paused → sending, after the start-time re-check (contract §2.3 ⁴): a channel, topic or delivery problem that
   * appeared while paused fails the execution as a configuration failure instead of resuming it.
   */
  async resume(ctx: TenantRequestContext, campaignId: string): Promise<CampaignView> {
    let next: { job: ExecutionJobName; id: string } | null = null;
    const view = await this.transition(ctx, campaignId, 'resume', undefined, async (uow, row) => {
      const execution = this.activeExecution(row, ['paused']);
      const version = await uow.tx.campaignVersion.findUniqueOrThrow({ where: { id: execution.versionId } });
      const snapshot = readVersionSnapshot(version.snapshot);
      const scope = { tx: uow.tx, orgId: ctx.access.orgId, workspaceId: ctx.access.workspaceId! };
      const topic = (await this.resolution.topicStatus(scope, snapshot.topic.topicIds[0])).available ? 'ok' : 'unavailable';
      const failure = startFailure({ channelEnabled: this.campaigns.channelAvailable(row.channel as Channel), topic, deliveryAvailable: this.campaigns.deliveryAvailable });
      if (failure) {
        await this.updateExecution(uow.tx, execution, { event: 'fail', failureClass: 'configuration', failureCode: failure }, ['paused']);
        await uow.tx.campaign.update({ where: { id: campaignId }, data: { status: 'failed', updatedAt: new Date(), version: { increment: 1 } } });
        await uow.event('campaign.failed', campaignId, { executionId: execution.id, failureClass: 'configuration', failureCode: failure });
        next = { job: EXECUTION_JOBS.finalize, id: execution.id };
        return;
      }
      const phase = execution.pausedPhase as 'materializing' | 'delivering';
      await this.updateExecution(uow.tx, execution, { event: 'resume' }, ['paused']);
      await uow.tx.campaign.update({ where: { id: campaignId }, data: { status: 'sending', updatedAt: new Date(), version: { increment: 1 } } });
      await uow.event('campaign.resumed', campaignId, { executionId: execution.id, phase });
      await uow.audit({ action: 'campaign.resumed', targetType: 'campaign', targetId: campaignId, metadata: { executionId: execution.id } });
      next = { job: EXECUTION_JOBS.run, id: execution.id }; // same execution, same snapshot, from its checkpoint
    });
    if (next) this.follow(ctx, (next as { job: ExecutionJobName }).job, (next as { id: string }).id);
    return view;
  }

  /**
   * Row 16. Terminal. A running materialization/delivery stops at its next page/batch lock (it re-checks the status);
   * the follow-up job cancels pending/queued recipients in chunks and releases the snapshot (contract §6.2, §6.4).
   */
  async cancel(ctx: TenantRequestContext, campaignId: string, req: CampaignVersionedCommandRequest): Promise<CampaignView> {
    let done: string | null = null;
    const view = await this.transition(ctx, campaignId, 'cancel', req.expectedVersion, async (uow, row) => {
      const execution = this.activeExecution(row, ACTIVE_EXECUTION);
      done = execution.id;
      const current = await this.updateExecution(uow.tx, execution, { event: 'cancel', cancelledAt: new Date(), cancelledByUserId: ctx.principal.userId }, ACTIVE_EXECUTION);
      await uow.tx.campaign.update({ where: { id: campaignId }, data: { status: 'cancelled', updatedAt: new Date(), version: { increment: 1 } } });
      const stage = row.status === 'scheduled' ? 'scheduled' : current.status === 'paused' ? 'paused' : (current.status as 'materializing' | 'delivering');
      const counts = { planned: current.planned, skipped: current.skipped, sent: current.sent, failed: current.failed, cancelled: current.cancelled, unknown: current.unknown };
      await uow.event('campaign.cancelled', campaignId, { executionId: execution.id, stage, counts });
      await uow.audit({ action: 'campaign.cancelled', targetType: 'campaign', targetId: campaignId, metadata: { executionId: execution.id, stage } });
    });
    if (done) this.follow(ctx, EXECUTION_JOBS.finalize, done);
    return view;
  }

  /** Row 17. failed → draft (the failed execution stays in history). */
  async returnToDraft(ctx: TenantRequestContext, campaignId: string): Promise<CampaignView> {
    return this.transition(ctx, campaignId, 'return_to_draft', undefined, async (uow, row) => {
      if (!row.currentExecutionId) throw new AppError('INVALID_TRANSITION', 409, 'The campaign has no failed execution');
      await uow.tx.campaign.update({ where: { id: campaignId }, data: { status: 'draft', currentExecutionId: null, updatedAt: new Date(), version: { increment: 1 } } });
      await uow.event('campaign.returned_to_draft', campaignId, { executionId: row.currentExecutionId });
      await uow.audit({ action: 'campaign.returned_to_draft', targetType: 'campaign', targetId: campaignId, metadata: { executionId: row.currentExecutionId } });
    });
  }

  /** Row 20. Copies a version's snapshot into the (editable) draft; an update for every rule and permission. */
  async restoreVersion(ctx: TenantRequestContext, campaignId: string, versionId: string, req: CampaignVersionedCommandRequest): Promise<CampaignView> {
    return this.campaigns.write(ctx, async (uow) => {
      const row = await this.campaigns.lock(uow.tx, campaignId);
      const decision = decideCommand(lifecycleState(row), 'update', { actor: this.campaigns.actor(ctx), expectedVersion: req.expectedVersion });
      if (decision.outcome === 'rejected') throw rejectionError(decision.code, decision.message);
      const version = await uow.tx.campaignVersion.findFirst({ where: { id: versionId, campaignId } });
      if (!version) throw Errors.notFound('Version');
      const s = readVersionSnapshot(version.snapshot);
      const before = draftOf(row);
      const after: CampaignDraft = {
        ...before,
        topicId: s.topic.topicIds[0],
        audience: { include: [...s.audience.include], exclude: [...s.audience.exclude] },
        sender: { ...s.sender },
        messages: [{ variantKey: 'default', content: structuredClone(s.messages[0].content) }],
        schedule: { ...s.schedule },
      };
      await this.campaigns.requirePermissions(ctx, draftChangePermissions(before, after), 'restore_version');
      const changes = (['topicId', 'audience', 'sender', 'messages', 'schedule'] as const)
        .filter((f) => !isDeepStrictEqual(after[f], before[f])) // key-order-insensitive (JSONB reorders keys)
        .map((f) => (f === 'topicId' ? 'topic' : f));
      await uow.tx.campaign.update({
        where: { id: campaignId },
        data: { topicId: after.topicId, audience: after.audience, sender: after.sender, messages: after.messages as object[], schedule: after.schedule, updatedAt: new Date(), version: { increment: 1 } },
      });
      await uow.event('campaign.updated', campaignId, { changes: [...changes, 'restoredFromVersion'] });
      await uow.audit({ action: 'campaign.version_restored', targetType: 'campaign', targetId: campaignId, metadata: { versionId, number: version.number, changes } });
      return this.campaigns.viewById(uow.tx, ctx, campaignId);
    });
  }

  // ─── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

  private async read(tx: Tx, campaignId: string): Promise<CampaignRow> {
    const row = (await tx.campaign.findUnique({ where: { id: campaignId }, include: { currentVersion: { select: { id: true, number: true, createdAt: true } }, currentExecution: true } })) as CampaignRow | null;
    if (!row) throw campaignNotFound();
    return row;
  }

  /** Lock → decide → (no-op | apply) → view, in one transaction. */
  private transition(
    ctx: TenantRequestContext,
    campaignId: string,
    command: CampaignCommand,
    expectedVersion: number | undefined,
    apply: (uow: Parameters<Parameters<CampaignsService['write']>[1]>[0], row: CampaignRow) => Promise<void>,
  ): Promise<CampaignView> {
    return this.campaigns.write(ctx, async (uow) => {
      const row = await this.campaigns.lock(uow.tx, campaignId);
      const decision = decideCommand(lifecycleState(row), command, {
        actor: this.campaigns.actor(ctx),
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        deliveryAvailable: this.campaigns.deliveryAvailable,
      });
      if (decision.outcome === 'rejected') throw rejectionError(decision.code, decision.message);
      if (decision.outcome === 'apply') await apply(uow, row);
      return this.campaigns.viewById(uow.tx, ctx, campaignId);
    });
  }

  /** The campaign's current execution, which the lifecycle says must be in one of `allowed`. */
  private activeExecution(row: CampaignRow, allowed: string[]): CampaignExecutionModel {
    const e = row.currentExecution;
    if (!e || !allowed.includes(e.status)) throw new AppError('INVALID_TRANSITION', 409, 'The campaign’s execution is not in a state that allows this');
    return e;
  }

  /**
   * Conditional update of the execution (lock order campaign → execution): applies only if it is still in an expected
   * status, so a concurrent system transition can never be overwritten. Status changes go through the execution
   * state machine.
   */
  private async updateExecution(
    tx: Tx,
    e: CampaignExecutionModel,
    change: { event?: ExecutionEvent; sendAt?: Date; cancelledAt?: Date; cancelledByUserId?: string; pausedByUserId?: string; failureClass?: string; failureCode?: string },
    expected: string[],
  ): Promise<CampaignExecutionModel> {
    const { event, ...columns } = change;
    // Lock the execution (lock order campaign → execution; the caller holds the campaign lock) and re-read it. The runner
    // bumps the execution version on every page and batch, so the copy loaded with the campaign row is routinely stale while
    // delivering; comparing against it made pause/cancel fail intermittently (regression test "actively delivering").
    // Holding the lock, the runner's next batch waits for this command, then sees the new status.
    await tx.$queryRaw`SELECT id FROM campaign_executions WHERE id = ${e.id}::uuid FOR UPDATE`;
    const fresh = await tx.campaignExecution.findUnique({ where: { id: e.id } });
    if (!fresh || !expected.includes(fresh.status)) throw new AppError('INVALID_TRANSITION', 409, 'The campaign’s execution is not in a state that allows this');
    e = fresh;
    let status: { status?: string; pausedPhase?: string | null } = {};
    if (event) {
      const next = nextExecutionState({ status: e.status as never, pausedPhase: e.pausedPhase as never, materializedAt: e.materializedAt }, event);
      if (!next.ok) throw new AppError('INVALID_TRANSITION', 409, 'The campaign’s execution is not in a state that allows this');
      status = { status: next.status, pausedPhase: next.pausedPhase };
    }
    const r = await tx.campaignExecution.updateMany({ where: { id: e.id, status: { in: expected }, version: e.version }, data: { ...columns, ...status, version: { increment: 1 } } });
    if (r.count !== 1) throw new AppError('INVALID_TRANSITION', 409, 'The campaign’s execution changed in the meantime; reload and try again');
    return e; // the locked, current row (pre-update values) — for counts in events and audit
  }
}

const errorsOf = (findings: ReadinessFinding[]) => findings.filter((f) => f.severity === 'error');
