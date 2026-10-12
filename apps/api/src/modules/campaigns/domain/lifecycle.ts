import type { CampaignAction, CampaignStatus, Permission } from '@workeasy/shared';

/**
 * Campaign lifecycle — the authoritative, server-side transition policy (docs/contracts/phase-6-campaign.md §2).
 * Pure: given the current state, a command and its context, decide what happens. The application layer applies the
 * decision (row lock, conditional update, events, audit) in one transaction. The frontend never evaluates this.
 *
 * Replaces the foundation's 13-state scaffold (ADR D-1): content completeness is readiness (readiness.ts), not state.
 */

/** Commands only the system may issue (scheduler/runner), never a user. */
export type SystemCommand = 'start' | 'complete' | 'fail';
export type CampaignCommand = CampaignAction | SystemCommand;

export const SYSTEM_COMMANDS: readonly SystemCommand[] = ['start', 'complete', 'fail'];
export const TERMINAL_STATUSES: readonly CampaignStatus[] = ['completed', 'cancelled'];

export type Actor = { type: 'user'; permissions: ReadonlySet<Permission | string> } | { type: 'system' };

export type RejectionCode =
  | 'INVALID_TRANSITION'
  | 'CAMPAIGN_NOT_EDITABLE'
  | 'CAMPAIGN_ACTIVE'
  | 'PERMISSION_DENIED'
  | 'version_conflict'
  | 'DELIVERY_NOT_AVAILABLE'
  | 'PREFLIGHT_FAILED';

export interface CampaignLifecycleState {
  status: CampaignStatus;
  /** Optimistic-concurrency counter of the campaign row. */
  version: number;
  deleted: boolean;
}

export interface CommandContext {
  actor: Actor;
  /** Required by the commands in EXPECTED_VERSION_COMMANDS. */
  expectedVersion?: number;
  /** Server-side delivery capability (contract §9.3). Required for schedule/send_now/reschedule/resume. */
  deliveryAvailable?: boolean;
  /** Number of readiness/pre-flight errors for the draft (contract §3). Required for schedule/send_now. */
  preflightErrors?: number;
}

export type LifecycleDecision =
  | { outcome: 'apply'; from: CampaignStatus; to: CampaignStatus; deleted: boolean }
  | { outcome: 'noop' }
  | { outcome: 'rejected'; code: RejectionCode; message: string };

// ─── the matrix (contract §2.3) ─────────────────────────────────────────────────────────────────────────────

/** A cell: a target state, an idempotent no-op, or a rejection with its contract code. */
type Cell = { to: CampaignStatus } | 'noop' | { reject: RejectionCode; message: string };

const invalid = (message = 'This action is not possible in the current state'): Cell => ({ reject: 'INVALID_TRANSITION', message });
const notEditable: Cell = { reject: 'CAMPAIGN_NOT_EDITABLE', message: 'Unschedule the campaign to edit it' };
const active: Cell = { reject: 'CAMPAIGN_ACTIVE', message: 'Cancel or unschedule the campaign first' };
const tooLate = invalid('The campaign has started; pause or cancel it instead');
const notSystem = invalid('Only the system can perform this transition');

/**
 * Row = current state, column = command. `delete` and `restore` act on the soft-delete flag, so their target state is
 * the current state. `clone` creates a NEW campaign; the source is unchanged.
 */
const MATRIX: Record<CampaignStatus, Record<CampaignCommand, Cell>> = {
  draft: {
    update: { to: 'draft' },
    schedule: { to: 'scheduled' },
    send_now: { to: 'scheduled' },
    reschedule: invalid(),
    unschedule: 'noop',
    pause: invalid(),
    resume: invalid(),
    cancel: invalid(),
    return_to_draft: 'noop',
    clone: { to: 'draft' },
    delete: { to: 'draft' },
    restore: 'noop',
    start: notSystem,
    complete: notSystem,
    fail: notSystem,
  },
  scheduled: {
    update: notEditable,
    schedule: invalid(),
    send_now: invalid(),
    reschedule: { to: 'scheduled' },
    unschedule: { to: 'draft' },
    pause: invalid(),
    resume: invalid(),
    cancel: { to: 'cancelled' },
    return_to_draft: invalid(),
    clone: { to: 'scheduled' },
    delete: active,
    restore: 'noop',
    start: { to: 'sending' },
    complete: notSystem,
    fail: { to: 'failed' },
  },
  sending: {
    update: invalid(),
    schedule: invalid(),
    send_now: invalid(),
    reschedule: invalid(),
    unschedule: tooLate,
    pause: { to: 'paused' },
    resume: 'noop',
    cancel: { to: 'cancelled' },
    return_to_draft: invalid(),
    clone: { to: 'sending' },
    delete: active,
    restore: 'noop',
    start: 'noop',
    complete: { to: 'completed' },
    fail: { to: 'failed' },
  },
  paused: {
    update: invalid(),
    schedule: invalid(),
    send_now: invalid(),
    reschedule: invalid(),
    unschedule: tooLate,
    pause: 'noop',
    resume: { to: 'sending' },
    cancel: { to: 'cancelled' },
    return_to_draft: invalid(),
    clone: { to: 'paused' },
    delete: active,
    restore: 'noop',
    start: notSystem,
    complete: notSystem,
    // Only via resume's re-check (topic archived, channel or delivery disabled while paused).
    fail: { to: 'failed' },
  },
  completed: {
    update: invalid(),
    schedule: invalid(),
    send_now: invalid(),
    reschedule: invalid(),
    unschedule: invalid(),
    pause: invalid(),
    resume: invalid(),
    cancel: invalid(),
    return_to_draft: invalid(),
    clone: { to: 'completed' },
    delete: { to: 'completed' },
    restore: 'noop',
    start: notSystem,
    complete: 'noop',
    fail: notSystem,
  },
  cancelled: {
    update: invalid(),
    schedule: invalid(),
    send_now: invalid(),
    reschedule: invalid(),
    unschedule: invalid(),
    pause: invalid(),
    resume: invalid(),
    cancel: 'noop',
    return_to_draft: invalid(),
    clone: { to: 'cancelled' },
    delete: { to: 'cancelled' },
    restore: 'noop',
    start: notSystem,
    complete: notSystem,
    fail: notSystem,
  },
  failed: {
    update: invalid(),
    schedule: invalid(),
    send_now: invalid(),
    reschedule: invalid(),
    unschedule: invalid(),
    pause: invalid(),
    resume: invalid(),
    cancel: { to: 'cancelled' },
    return_to_draft: { to: 'draft' },
    clone: { to: 'failed' },
    delete: { to: 'failed' },
    restore: 'noop',
    start: notSystem,
    complete: notSystem,
    fail: 'noop',
  },
};

// ─── authorization (contract §8) ────────────────────────────────────────────────────────────────────────────

/** The campaign permission each user command needs. Composite read permissions for draft content: draftChangePermissions. */
export const COMMAND_PERMISSION: Record<CampaignAction, Permission> = {
  update: 'campaigns.update',
  return_to_draft: 'campaigns.update',
  schedule: 'campaigns.send',
  send_now: 'campaigns.send',
  reschedule: 'campaigns.send',
  unschedule: 'campaigns.send',
  pause: 'campaigns.send',
  resume: 'campaigns.send',
  cancel: 'campaigns.send',
  clone: 'campaigns.create',
  delete: 'campaigns.delete',
  restore: 'campaigns.delete',
};

/** Commands whose request must carry the campaign row version they were based on (contract §10.1, §15). */
export const EXPECTED_VERSION_COMMANDS: readonly CampaignCommand[] = ['update', 'schedule', 'send_now', 'reschedule', 'unschedule', 'cancel', 'delete'];

/** Commands that hand work to delivery and therefore need the delivery capability (contract §9.3). */
export const DELIVERY_COMMANDS: readonly CampaignCommand[] = ['schedule', 'send_now', 'reschedule', 'resume'];

const isSystemCommand = (c: CampaignCommand): c is SystemCommand => (SYSTEM_COMMANDS as readonly string[]).includes(c);

/**
 * Decides a command. Order of checks (each step can end the decision):
 *  1. actor type (system commands are never accepted from users and vice versa)
 *  2. permission (users)
 *  3. expectedVersion for EXPECTED_VERSION_COMMANDS (contract §2.2 step 3) — before ANY transition outcome: a stale
 *     request gets version_conflict whether the transition would apply, no-op or be rejected. A stale client is never
 *     told "done" (or "invalid") about a campaign representation it has not seen; a retry after a committed first
 *     attempt gets version_conflict and reloads. Commands without a version (pause, resume, return_to_draft, restore)
 *     and system transitions (own conditional-update guards) skip this step.
 *  4. transition evaluation (contract §2.2 step 4): soft-deleted campaigns accept only restore (delete is a no-op);
 *     otherwise the lifecycle matrix — apply, no-op, or INVALID_TRANSITION / CAMPAIGN_NOT_EDITABLE / CAMPAIGN_ACTIVE
 *  5. delivery capability
 *  6. pre-flight errors (schedule / send_now)
 */
export function decideCommand(state: CampaignLifecycleState, command: CampaignCommand, ctx: CommandContext): LifecycleDecision {
  const system = isSystemCommand(command);
  if (system && ctx.actor.type !== 'system') return reject('PERMISSION_DENIED', 'Only the system can perform this transition');
  if (!system && ctx.actor.type !== 'user') return reject('INVALID_TRANSITION', 'The system does not issue user commands');
  if (!system && ctx.actor.type === 'user' && !ctx.actor.permissions.has(COMMAND_PERMISSION[command as CampaignAction])) {
    return reject('PERMISSION_DENIED', 'You do not have permission for this action');
  }

  const stale = versionCheck(state, command, ctx);
  if (stale) return stale;

  if (state.deleted) {
    if (command === 'restore') return applyChecks(command, ctx, { outcome: 'apply', from: state.status, to: state.status, deleted: false });
    if (command === 'delete') return { outcome: 'noop' };
    return reject('INVALID_TRANSITION', 'Deleted campaigns are read-only; restore it first');
  }

  const cell = MATRIX[state.status][command];
  if (cell === 'noop') return { outcome: 'noop' };
  if ('reject' in cell) return reject(cell.reject, cell.message);
  return applyChecks(command, ctx, { outcome: 'apply', from: state.status, to: cell.to, deleted: command === 'delete' });
}

/** Stale expectedVersion → version_conflict; null when the command carries no version or it matches. */
function versionCheck(state: CampaignLifecycleState, command: CampaignCommand, ctx: CommandContext): LifecycleDecision | null {
  if (!EXPECTED_VERSION_COMMANDS.includes(command)) return null;
  if (ctx.expectedVersion === undefined) throw new Error(`${command} requires expectedVersion`);
  return ctx.expectedVersion === state.version ? null : reject('version_conflict', 'The campaign changed since you loaded it; reload and try again');
}

function applyChecks(command: CampaignCommand, ctx: CommandContext, decision: Extract<LifecycleDecision, { outcome: 'apply' }>): LifecycleDecision {
  if (DELIVERY_COMMANDS.includes(command)) {
    if (ctx.deliveryAvailable === undefined) throw new Error(`${command} requires the delivery capability`);
    if (!ctx.deliveryAvailable) return reject('DELIVERY_NOT_AVAILABLE', 'Sending is not available yet');
  }
  if (command === 'schedule' || command === 'send_now') {
    if (ctx.preflightErrors === undefined) throw new Error(`${command} requires a pre-flight result`);
    if (ctx.preflightErrors > 0) return reject('PREFLIGHT_FAILED', 'Fix the problems found by the review before scheduling');
  }
  return decision;
}

const reject = (code: RejectionCode, message: string): LifecycleDecision => ({ outcome: 'rejected', code, message });

/** Is the draft editable? Only in `draft` and not deleted (contract §2.1). */
export const isDraftEditable = (state: Pick<CampaignLifecycleState, 'status' | 'deleted'>) => state.status === 'draft' && !state.deleted;

/** Terminal campaign states never leave (contract §2.1). `failed` is not terminal: it can return to draft. */
export const isTerminal = (status: CampaignStatus) => TERMINAL_STATUSES.includes(status);
