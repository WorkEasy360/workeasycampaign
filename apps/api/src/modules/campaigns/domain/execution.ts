import type { CampaignStatus, ExecutionStatus, RecipientStatus } from '@workeasy/shared';

/**
 * Execution and recipient state machines (contract §5, §6.4, §7). Pure transition tables; the application layer applies
 * them with conditional updates under the execution row lock.
 */

export type ExecutionEvent =
  | 'start' // pending → materializing (commit S1)
  | 'materialized' // materializing → delivering (last snapshot page committed)
  | 'all_final' // delivering → completed
  | 'pause'
  | 'resume'
  | 'cancel' // includes unschedule of a pending execution
  | 'fail'; // configuration failure

export const EXECUTION_TERMINAL: readonly ExecutionStatus[] = ['completed', 'cancelled', 'failed'];
const ACTIVE: readonly ExecutionStatus[] = ['pending', 'materializing', 'delivering', 'paused'];

export interface ExecutionState {
  status: ExecutionStatus;
  /** Which phase a paused execution returns to. */
  pausedPhase: 'materializing' | 'delivering' | null;
  materializedAt: Date | null;
}

export type ExecutionTransition =
  | { ok: true; status: ExecutionStatus; pausedPhase: ExecutionState['pausedPhase'] }
  | { ok: false; reason: 'INVALID_TRANSITION' };

export function nextExecutionState(state: ExecutionState, event: ExecutionEvent): ExecutionTransition {
  const to = (status: ExecutionStatus, pausedPhase: ExecutionState['pausedPhase'] = null): ExecutionTransition => ({ ok: true, status, pausedPhase });
  const s = state.status;
  switch (event) {
    case 'start':
      return s === 'pending' ? to('materializing') : invalid();
    case 'materialized':
      return s === 'materializing' ? to('delivering') : invalid();
    case 'all_final':
      return s === 'delivering' ? to('completed') : invalid();
    case 'pause':
      return s === 'materializing' || s === 'delivering' ? to('paused', s) : invalid();
    case 'resume':
      return s === 'paused' && state.pausedPhase ? to(state.pausedPhase) : invalid();
    case 'cancel':
      return ACTIVE.includes(s) ? to('cancelled') : invalid();
    case 'fail':
      return ACTIVE.includes(s) ? to('failed') : invalid();
  }
}

const invalid = (): ExecutionTransition => ({ ok: false, reason: 'INVALID_TRANSITION' });

/** Campaign status is a projection of the current execution (contract §2.1). `null` = no active/last execution. */
export function campaignStatusFor(execution: Pick<ExecutionState, 'status'> | null): CampaignStatus {
  if (!execution) return 'draft';
  switch (execution.status) {
    case 'pending':
      return 'scheduled';
    case 'materializing':
    case 'delivering':
      return 'sending';
    case 'paused':
      return 'paused';
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
  }
}

/**
 * Snapshot release guard (contract §6.4): an execution's audience snapshot may be released only when the execution can
 * never read it again. Permanent: no transition leads from `delivering` or a terminal state back to `materializing`.
 */
export const isSnapshotReleasable = (state: Pick<ExecutionState, 'status' | 'materializedAt'>) =>
  state.materializedAt !== null || EXECUTION_TERMINAL.includes(state.status);

// ─── recipients (contract §7.1) ─────────────────────────────────────────────────────────────────────────────

export const RECIPIENT_FINAL: readonly RecipientStatus[] = ['skipped', 'sent', 'failed', 'skipped_at_send', 'unknown', 'cancelled'];

const RECIPIENT_TRANSITIONS: Record<RecipientStatus, readonly RecipientStatus[]> = {
  pending: ['queued', 'cancelled', 'sent'], // 'sent' only via the test NullDeliveryPort (no provider, no Checkpoint B)
  skipped: [],
  queued: ['sending', 'skipped_at_send', 'cancelled'],
  sending: ['sent', 'queued', 'failed', 'unknown'], // queued = retryable error (attempts + 1)
  sent: [],
  failed: [],
  skipped_at_send: [],
  unknown: [], // final until reconciled from provider callbacks (Phase 8)
  cancelled: [],
};

export const canRecipientTransition = (from: RecipientStatus, to: RecipientStatus) => RECIPIENT_TRANSITIONS[from].includes(to);
export const isRecipientFinal = (status: RecipientStatus) => RECIPIENT_FINAL.includes(status);

/** Materialization (Checkpoint A) creates recipients only in these two states. */
export const initialRecipientStatus = (eligible: boolean): RecipientStatus => (eligible ? 'pending' : 'skipped');
