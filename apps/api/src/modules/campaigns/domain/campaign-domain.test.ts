import { CAMPAIGN_ACTIONS, CAMPAIGN_STATUSES, type CampaignStatus, EXECUTION_STATUSES, RECIPIENT_STATUSES } from '@workeasy/shared';
import { describe, expect, it } from 'vitest';
import { campaignActions } from './actions.js';
import { channelSpec, isChannelAvailable } from './channels.js';
import { resolveDeliveryMode } from './delivery-mode.js';
import { type CampaignDraft, draftChangePermissions } from './draft.js';
import { CAMPAIGN_EVENT_TYPES, type CampaignEventPayloads } from './events.js';
import { campaignStatusFor, canRecipientTransition, type ExecutionEvent, isRecipientFinal, isSnapshotReleasable, nextExecutionState } from './execution.js';
import { type Actor, type CampaignCommand, type CampaignLifecycleState, decideCommand, isDraftEditable } from './lifecycle.js';
import { preflightFindings, readinessFindings, startFailure, summarize } from './readiness.js';
import { assertSnapshotV2, buildVersionSnapshot, canonicalJson, contentHash, readVersionSnapshot, VersionError } from './version.js';

// ─── fixtures ───────────────────────────────────────────────────────────────────────────────────────────────

const ALL = new Set([
  'campaigns.read',
  'campaigns.create',
  'campaigns.update',
  'campaigns.delete',
  'campaigns.send',
]);
const manager: Actor = { type: 'user', permissions: ALL };
const editor: Actor = { type: 'user', permissions: new Set(['campaigns.read', 'campaigns.create', 'campaigns.update', 'campaigns.delete']) };
const viewer: Actor = { type: 'user', permissions: new Set(['campaigns.read']) };
const system: Actor = { type: 'system' };
const SYSTEM_COMMANDS = ['start', 'complete', 'fail'] as const;

const st = (status: CampaignStatus, over: Partial<CampaignLifecycleState> = {}): CampaignLifecycleState => ({ status, version: 7, deleted: false, ...over });
const okCtx = (actor: Actor) => ({ actor, expectedVersion: 7, deliveryAvailable: true, preflightErrors: 0 });
const decide = (status: CampaignStatus, command: CampaignCommand, actor: Actor = manager) =>
  decideCommand(st(status), command, okCtx(SYSTEM_COMMANDS.includes(command as never) ? system : actor));

const NOW = new Date('2026-10-03T12:00:00Z');
const readyDraft = (over: Partial<CampaignDraft> = {}): CampaignDraft => ({
  name: 'October newsletter',
  channel: 'email',
  topicId: '11111111-1111-4111-8111-111111111111',
  audience: { include: [{ type: 'list', listId: '22222222-2222-4222-8222-222222222222' }], exclude: [] },
  sender: { senderIdentityId: null, fromName: 'Acme', replyTo: null },
  messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Hello', preheader: '', body: { format: 'text', text: 'Body' } } }],
  schedule: { mode: 'now', sendAt: null, timezone: 'Asia/Kolkata' },
  ...over,
});
const codes = (f: { code: string }[]) => f.map((x) => x.code);

// ─── lifecycle: the contract's matrix (docs/contracts/phase-6-campaign.md §2.3), transcribed independently ─────

/** ✓ = allowed (target in TARGET), ∅ = idempotent no-op, ✗ = INVALID_TRANSITION, NE = CAMPAIGN_NOT_EDITABLE, A = CAMPAIGN_ACTIVE, — = not issued by that actor */
const CONTRACT: Record<CampaignStatus, Record<string, string>> = {
  //            update schedule resched unsched pause resume cancel rtd   clone delete restore start complete fail
  draft:     { update: '✓', schedule: '✓', reschedule: '✗', unschedule: '∅', pause: '✗', resume: '✗', cancel: '✗', return_to_draft: '∅', clone: '✓', delete: '✓', restore: '∅', start: '—', complete: '—', fail: '—' },
  scheduled: { update: 'NE', schedule: '✗', reschedule: '✓', unschedule: '✓', pause: '✗', resume: '✗', cancel: '✓', return_to_draft: '✗', clone: '✓', delete: 'A', restore: '∅', start: '✓', complete: '—', fail: '✓' },
  sending:   { update: '✗', schedule: '✗', reschedule: '✗', unschedule: '✗', pause: '✓', resume: '∅', cancel: '✓', return_to_draft: '✗', clone: '✓', delete: 'A', restore: '∅', start: '∅', complete: '✓', fail: '✓' },
  paused:    { update: '✗', schedule: '✗', reschedule: '✗', unschedule: '✗', pause: '∅', resume: '✓', cancel: '✓', return_to_draft: '✗', clone: '✓', delete: 'A', restore: '∅', start: '—', complete: '—', fail: '✓' },
  completed: { update: '✗', schedule: '✗', reschedule: '✗', unschedule: '✗', pause: '✗', resume: '✗', cancel: '✗', return_to_draft: '✗', clone: '✓', delete: '✓', restore: '∅', start: '—', complete: '∅', fail: '—' },
  cancelled: { update: '✗', schedule: '✗', reschedule: '✗', unschedule: '✗', pause: '✗', resume: '✗', cancel: '∅', return_to_draft: '✗', clone: '✓', delete: '✓', restore: '∅', start: '—', complete: '—', fail: '—' },
  failed:    { update: '✗', schedule: '✗', reschedule: '✗', unschedule: '✗', pause: '✗', resume: '✗', cancel: '✓', return_to_draft: '✓', clone: '✓', delete: '✓', restore: '∅', start: '—', complete: '—', fail: '∅' },
};
/** Where an allowed command leads (clone/delete leave the source's status unchanged). */
const TARGET: Partial<Record<CampaignCommand, (from: CampaignStatus) => CampaignStatus>> = {
  update: () => 'draft',
  schedule: () => 'scheduled',
  send_now: () => 'scheduled',
  reschedule: () => 'scheduled',
  unschedule: () => 'draft',
  pause: () => 'paused',
  resume: () => 'sending',
  cancel: () => 'cancelled',
  return_to_draft: () => 'draft',
  clone: (from) => from,
  delete: (from) => from,
  start: () => 'sending',
  complete: () => 'completed',
  fail: () => 'failed',
};

describe('campaign lifecycle — every cell of the contract matrix', () => {
  const cells = CAMPAIGN_STATUSES.flatMap((status) =>
    [...CAMPAIGN_ACTIONS.filter((a) => a !== 'send_now'), ...SYSTEM_COMMANDS].map((command) => [status, command] as const),
  );

  it.each(cells)('%s × %s', (status, command) => {
    const expected = CONTRACT[status][command];
    const d = decide(status, command);
    switch (expected) {
      case '✓':
        expect(d).toEqual({ outcome: 'apply', from: status, to: TARGET[command]!(status), deleted: command === 'delete' });
        break;
      case '∅':
        expect(d).toEqual({ outcome: 'noop' });
        break;
      case '✗':
      case '—':
        expect(d).toMatchObject({ outcome: 'rejected', code: 'INVALID_TRANSITION' });
        break;
      case 'NE':
        expect(d).toMatchObject({ outcome: 'rejected', code: 'CAMPAIGN_NOT_EDITABLE' });
        break;
      case 'A':
        expect(d).toMatchObject({ outcome: 'rejected', code: 'CAMPAIGN_ACTIVE' });
        break;
      default:
        throw new Error(`unknown symbol ${expected}`);
    }
  });

  it('send_now behaves exactly like schedule in every state', () => {
    for (const s of CAMPAIGN_STATUSES) expect(decide(s, 'send_now')).toEqual(decide(s, 'schedule'));
  });

  it('only the 7 contract states exist; no readiness word is a state', () => {
    expect([...CAMPAIGN_STATUSES]).toEqual(['draft', 'scheduled', 'sending', 'paused', 'completed', 'cancelled', 'failed']);
    for (const removed of ['configured', 'content_ready', 'validated', 'pending_approval', 'queued', 'awaiting_winner', 'paused_by_system', 'stopped']) {
      expect(CAMPAIGN_STATUSES as readonly string[]).not.toContain(removed);
    }
  });

  it('completed and cancelled are terminal: no command moves them to another state', () => {
    for (const s of ['completed', 'cancelled'] as const) {
      for (const c of [...CAMPAIGN_ACTIONS, ...SYSTEM_COMMANDS]) {
        const d = decide(s, c);
        if (d.outcome === 'apply') expect(d.to).toBe(s);
      }
    }
  });

  it('failed is not terminal: it can return to draft or be cancelled', () => {
    expect(decide('failed', 'return_to_draft')).toMatchObject({ outcome: 'apply', to: 'draft' });
    expect(decide('failed', 'cancel')).toMatchObject({ outcome: 'apply', to: 'cancelled' });
  });

  it('pause and resume round-trip; repeating either is a no-op', () => {
    expect(decide('sending', 'pause')).toMatchObject({ to: 'paused' });
    expect(decide('paused', 'pause')).toEqual({ outcome: 'noop' });
    expect(decide('paused', 'resume')).toMatchObject({ to: 'sending' });
    expect(decide('sending', 'resume')).toEqual({ outcome: 'noop' });
  });

  it('only a draft is editable', () => {
    for (const s of CAMPAIGN_STATUSES) expect(isDraftEditable({ status: s, deleted: false })).toBe(s === 'draft');
    expect(isDraftEditable({ status: 'draft', deleted: true })).toBe(false);
  });
});

describe('optimistic concurrency', () => {
  it('a stale expectedVersion is a conflict, never a silent overwrite', () => {
    for (const command of ['update', 'schedule', 'send_now'] as const) {
      expect(decideCommand(st('draft'), command, { ...okCtx(manager), expectedVersion: 6 })).toMatchObject({ outcome: 'rejected', code: 'version_conflict' });
    }
    expect(decideCommand(st('scheduled'), 'reschedule', { ...okCtx(manager), expectedVersion: 6 })).toMatchObject({ code: 'version_conflict' });
    expect(decideCommand(st('scheduled'), 'cancel', { ...okCtx(manager), expectedVersion: 8 })).toMatchObject({ code: 'version_conflict' });
    expect(decideCommand(st('completed'), 'delete', { ...okCtx(manager), expectedVersion: 1 })).toMatchObject({ code: 'version_conflict' });
  });

  /**
   * A campaign row as the application layer will drive it: commands are serialized by the row lock, `apply` bumps the
   * version, no-ops and rejections write nothing.
   */
  const row = (status: CampaignStatus, version = 7, deleted = false) => {
    const s: CampaignLifecycleState = { status, version, deleted };
    return {
      get state() {
        return { ...s };
      },
      run(command: CampaignCommand, expectedVersion?: number) {
        const d = decideCommand({ ...s }, command, { ...okCtx(manager), expectedVersion });
        if (d.outcome === 'apply') Object.assign(s, { status: d.to, deleted: d.deleted, version: s.version + 1 });
        return d;
      },
    };
  };
  const conflict = { outcome: 'rejected', code: 'version_conflict' };

  it('1. retrying the exact successful command with the same expectedVersion: version_conflict, nothing written', () => {
    for (const [from, command, to] of [['scheduled', 'unschedule', 'draft'], ['scheduled', 'cancel', 'cancelled'], ['completed', 'delete', 'completed']] as const) {
      const r = row(from);
      expect(r.run(command, 7)).toMatchObject({ outcome: 'apply' });
      const after = r.state;
      expect(after).toMatchObject({ status: to, version: 8 });
      expect(r.run(command, 7)).toMatchObject(conflict);
      expect(r.state).toEqual(after);
    }
  });

  it('2. stale expectedVersion whose requested result equals the current state: version_conflict, never a no-op', () => {
    // unschedule: the campaign was unscheduled, edited and is now a different draft (v12)
    expect(row('draft', 12).run('unschedule', 7)).toMatchObject(conflict);
    // cancel on a campaign someone else cancelled; delete on one someone else deleted
    expect(row('cancelled', 9).run('cancel', 7)).toMatchObject(conflict);
    expect(row('completed', 9, true).run('delete', 7)).toMatchObject(conflict);
    // …and the same requests with the current version are honest no-ops
    expect(row('draft', 12).run('unschedule', 12)).toEqual({ outcome: 'noop' });
    expect(row('cancelled', 9).run('cancel', 9)).toEqual({ outcome: 'noop' });
    expect(row('completed', 9, true).run('delete', 9)).toEqual({ outcome: 'noop' });
  });

  it('3. another user changes the campaign between read and command: the stale command is refused', () => {
    const r = row('draft');
    const readByA = r.state.version;
    expect(r.run('update', readByA)).toMatchObject({ outcome: 'apply' }); // user B edits
    expect(r.run('schedule', readByA)).toMatchObject(conflict); // A would snapshot content A never saw
    expect(r.run('update', readByA)).toMatchObject(conflict); // A would overwrite B's edit
    expect(r.state).toMatchObject({ status: 'draft', version: 8 });
  });

  it('4. two concurrent commands with the same expectedVersion: exactly one applies', () => {
    for (const [from, a, b] of [['draft', 'update', 'update'], ['draft', 'update', 'schedule'], ['scheduled', 'cancel', 'cancel'], ['scheduled', 'unschedule', 'unschedule'], ['scheduled', 'reschedule', 'cancel'], ['completed', 'delete', 'delete']] as const) {
      const r = row(from);
      const first = r.run(a, 7);
      const second = r.run(b, 7);
      expect(first.outcome).toBe('apply');
      expect(second).toMatchObject(conflict); // the loser sees the newly committed version first
      expect(r.state.version).toBe(8);
    }
  });

  it('7. second schedule: INVALID_TRANSITION only at the current version; stale → version_conflict', () => {
    const s = row('draft');
    expect(s.run('schedule', 7)).toMatchObject({ outcome: 'apply', to: 'scheduled' });
    expect(s.run('schedule', 7)).toMatchObject(conflict); // stale request fails the version check first
    expect(s.run('schedule', 8)).toMatchObject({ outcome: 'rejected', code: 'INVALID_TRANSITION' }); // reached transition evaluation
    // Same Idempotency-Key → replay of the first response: application layer (6.6), never reaches this function.
  });

  it('5. retry after the original committed but the response was lost: conflict (client reloads and sees the outcome)', () => {
    const r = row('sending');
    expect(r.run('cancel', 7)).toMatchObject({ outcome: 'apply' }); // committed; response lost
    expect(r.run('cancel', 7)).toMatchObject(conflict);
    expect(r.state).toMatchObject({ status: 'cancelled', version: 8 }); // reload shows the cancel took effect
    // commands without expectedVersion are idempotent at any version
    const p = row('sending');
    expect(p.run('pause')).toMatchObject({ outcome: 'apply' });
    expect(p.run('pause')).toEqual({ outcome: 'noop' });
    expect(p.state.version).toBe(8);
  });

  it('6. terminal states where the request is already satisfied: no-op only with the current version', () => {
    expect(row('cancelled', 7).run('cancel', 7)).toEqual({ outcome: 'noop' });
    expect(row('cancelled', 8).run('cancel', 7)).toMatchObject(conflict);
    // a terminal state that does not satisfy the request: INVALID_TRANSITION at the current version, conflict when stale
    expect(row('completed', 8).run('cancel', 8)).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(row('completed', 8).run('cancel', 7)).toMatchObject(conflict);
    // restore carries no version: "not deleted → no-op" at any version
    expect(row('completed', 8).run('restore')).toEqual({ outcome: 'noop' });
    // system transitions are idempotent (conditional updates, no version)
    expect(decideCommand(st('completed', { version: 8 }), 'complete', { actor: system })).toEqual({ outcome: 'noop' });
  });

  it('contract §2.2 order: for every version-carrying command, in every state, expectedVersion is checked before transition evaluation', () => {
    const VERSIONED = ['update', 'schedule', 'send_now', 'reschedule', 'unschedule', 'cancel', 'delete'] as const;
    let seen = { apply: 0, noop: 0, rejected: 0 };
    for (const s of CAMPAIGN_STATUSES) {
      for (const deleted of [false, true]) {
        for (const c of VERSIONED) {
          const current = decideCommand(st(s, { deleted }), c, okCtx(manager));
          const stale = decideCommand(st(s, { deleted }), c, { ...okCtx(manager), expectedVersion: 6 });
          seen = { ...seen, [current.outcome]: seen[current.outcome] + 1 };
          // whatever the current-version outcome (apply / ∅ / INVALID_TRANSITION / NOT_EDITABLE / ACTIVE), stale → conflict
          expect(stale).toMatchObject(conflict);
        }
      }
    }
    expect(seen.apply && seen.noop && seen.rejected).toBeTruthy(); // all three outcome kinds were exercised
  });

  it('cases 1–5 explicitly (current vs stale × invalid / no-op / valid)', () => {
    // 1 / 2: invalid transition (and the 422 variants)
    expect(row('completed').run('update', 7)).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(row('completed').run('update', 6)).toMatchObject(conflict);
    expect(row('scheduled').run('update', 7)).toMatchObject({ code: 'CAMPAIGN_NOT_EDITABLE' });
    expect(row('scheduled').run('update', 6)).toMatchObject(conflict);
    expect(row('sending').run('delete', 7)).toMatchObject({ code: 'CAMPAIGN_ACTIVE' });
    expect(row('sending').run('delete', 6)).toMatchObject(conflict);
    expect(row('draft', 7, true).run('update', 7)).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(row('draft', 7, true).run('update', 6)).toMatchObject(conflict);
    // 3 / 4: no-op
    expect(row('draft').run('unschedule', 7)).toEqual({ outcome: 'noop' });
    expect(row('draft').run('unschedule', 6)).toMatchObject(conflict);
    // 5: valid transition increments the version
    const r = row('scheduled');
    expect(r.run('unschedule', 7)).toEqual({ outcome: 'apply', from: 'scheduled', to: 'draft', deleted: false });
    expect(r.state.version).toBe(8);
    // commands without expectedVersion: transition outcome at any version
    expect(row('completed', 9).run('pause')).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(row('paused', 9).run('pause')).toEqual({ outcome: 'noop' });
  });

  it('a command that needs expectedVersion cannot be decided without one (programming error)', () => {
    expect(() => decideCommand(st('draft'), 'update', { actor: manager })).toThrow(/expectedVersion/);
  });

  it('pause, resume, return to draft and restore do not need a version', () => {
    expect(decideCommand(st('sending'), 'pause', { actor: manager })).toMatchObject({ outcome: 'apply' });
    expect(decideCommand(st('failed'), 'return_to_draft', { actor: manager })).toMatchObject({ outcome: 'apply' });
  });
});

describe('authorization is part of the decision', () => {
  it('a viewer can perform no command', () => {
    for (const c of CAMPAIGN_ACTIONS) {
      for (const s of CAMPAIGN_STATUSES) {
        const d = decideCommand(st(s), c, okCtx(viewer));
        expect(d).toMatchObject({ outcome: 'rejected', code: 'PERMISSION_DENIED' });
      }
    }
  });

  it('an editor edits, clones and deletes but cannot schedule, send, pause, resume or cancel', () => {
    expect(decideCommand(st('draft'), 'update', okCtx(editor))).toMatchObject({ outcome: 'apply' });
    expect(decideCommand(st('draft'), 'clone', okCtx(editor))).toMatchObject({ outcome: 'apply' });
    for (const [s, c] of [['draft', 'schedule'], ['draft', 'send_now'], ['sending', 'pause'], ['paused', 'resume'], ['scheduled', 'cancel'], ['scheduled', 'unschedule'], ['scheduled', 'reschedule']] as const) {
      expect(decideCommand(st(s), c, okCtx(editor))).toMatchObject({ code: 'PERMISSION_DENIED' });
    }
  });

  it('users cannot issue system transitions and the system cannot issue user commands', () => {
    for (const c of SYSTEM_COMMANDS) expect(decideCommand(st('scheduled'), c, okCtx(manager))).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(decideCommand(st('draft'), 'schedule', okCtx(system))).toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('the composite rule: adding a list, tag or topic to a draft needs its read permission', () => {
    const before = { topicId: null, audience: { include: [], exclude: [] } };
    const after = { topicId: 't1', audience: { include: [{ type: 'list' as const, listId: 'l1' }], exclude: [{ type: 'tag' as const, tagId: 'g1' }] } };
    expect([...draftChangePermissions(before, after)].sort()).toEqual(['lists.read', 'tags.read', 'topics.read']);
    expect([...draftChangePermissions(after, after)]).toEqual([]);
  });
});

describe('readiness is separate from the lifecycle', () => {
  it('schedule is refused while pre-flight has errors; the campaign stays a draft', () => {
    expect(decideCommand(st('draft'), 'schedule', { ...okCtx(manager), preflightErrors: 2 })).toMatchObject({ outcome: 'rejected', code: 'PREFLIGHT_FAILED' });
  });

  it('delivery capability is enforced by the decision, not by the UI', () => {
    for (const [s, c] of [['draft', 'schedule'], ['draft', 'send_now'], ['scheduled', 'reschedule'], ['paused', 'resume']] as const) {
      expect(decideCommand(st(s), c, { ...okCtx(manager), deliveryAvailable: false })).toMatchObject({ code: 'DELIVERY_NOT_AVAILABLE' });
    }
    // Stopping is always possible.
    expect(decideCommand(st('sending'), 'pause', { ...okCtx(manager), deliveryAvailable: false })).toMatchObject({ outcome: 'apply' });
    expect(decideCommand(st('sending'), 'cancel', { ...okCtx(manager), deliveryAvailable: false })).toMatchObject({ outcome: 'apply' });
  });

  it('a draft can be ready or not ready; readiness never appears in the status', () => {
    expect(summarize(readinessFindings(readyDraft(), { now: NOW, deliveryAvailable: true })).readiness).toBe('ready');
    expect(summarize(readinessFindings(readyDraft({ name: ' ' }), { now: NOW, deliveryAvailable: true })).readiness).toBe('not_ready');
  });
});

describe('allowedActions / blockedActions', () => {
  const caps = (over: Partial<{ deliveryAvailable: boolean; readinessErrors: number }> = {}) => ({ deliveryAvailable: true, readinessErrors: 0, ...over });

  it('are derived from the same decisions as the commands (never a superset)', () => {
    for (const s of CAMPAIGN_STATUSES) {
      for (const deleted of [false, true]) {
        const state = st(s, { deleted });
        const { allowedActions } = campaignActions(state, { permissions: ALL, ...caps() });
        for (const a of allowedActions) expect(decideCommand(state, a, okCtx(manager)).outcome).toBe('apply');
        for (const a of CAMPAIGN_ACTIONS.filter((x) => !allowedActions.includes(x))) {
          expect(decideCommand(state, a, okCtx(manager)).outcome).not.toBe('apply');
        }
      }
    }
  });

  it('explain why a lifecycle-legal action is blocked', () => {
    const disabled = campaignActions(st('draft'), { permissions: ALL, ...caps({ deliveryAvailable: false }) });
    expect(disabled.allowedActions).toEqual(['update', 'clone', 'delete']);
    expect(disabled.blockedActions).toEqual([
      { action: 'schedule', reason: 'DELIVERY_NOT_AVAILABLE' },
      { action: 'send_now', reason: 'DELIVERY_NOT_AVAILABLE' },
    ]);
    const notReady = campaignActions(st('draft'), { permissions: ALL, ...caps({ readinessErrors: 1 }) });
    expect(notReady.blockedActions.map((b) => b.reason)).toEqual(['READINESS_ERRORS', 'READINESS_ERRORS']);
    const asEditor = campaignActions(st('draft'), { permissions: (editor as Extract<Actor, { type: 'user' }>).permissions, ...caps() });
    expect(asEditor.blockedActions.map((b) => [b.action, b.reason])).toEqual([['schedule', 'PERMISSION_DENIED'], ['send_now', 'PERMISSION_DENIED']]);
  });

  it('no-ops are not offered, and deleted campaigns offer only restore', () => {
    expect(campaignActions(st('paused'), { permissions: ALL, ...caps() }).allowedActions).not.toContain('pause');
    expect(campaignActions(st('completed', { deleted: true }), { permissions: ALL, ...caps() }).allowedActions).toEqual(['restore']);
  });
});

describe('deletion', () => {
  it('deleted campaigns are read-only except restore; delete again is a no-op', () => {
    const deleted = st('completed', { deleted: true });
    expect(decideCommand(deleted, 'restore', okCtx(manager))).toEqual({ outcome: 'apply', from: 'completed', to: 'completed', deleted: false });
    expect(decideCommand(deleted, 'delete', okCtx(manager))).toEqual({ outcome: 'noop' });
    expect(decideCommand(deleted, 'clone', okCtx(manager))).toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});

// ─── version ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('campaign versions (v2 written; v1 historical — content amendment C3/C4)', () => {
  const at = { mode: 'at' as const, sendAt: '2026-10-05T03:30:00+05:30', timezone: 'Asia/Kolkata' };

  it('builds a complete, valid snapshot with every contract field', () => {
    const v = buildVersionSnapshot(readyDraft({ sender: { senderIdentityId: null, fromName: 'Acme\u0007 Team', replyTo: ' Hello@Acme.TEST ' } }), at);
    expect(() => assertSnapshotV2(v)).not.toThrow();
    expect(v).toEqual({
      schema: 'campaign.version.v2', // content amendment C3: new versions are v2; v1 text content inside, personalization 'none'
      channel: 'email',
      purpose: 'marketing',
      topic: { topicIds: ['11111111-1111-4111-8111-111111111111'], policy: 'block_unsubscribed' },
      audience: { include: [{ type: 'list', listId: '22222222-2222-4222-8222-222222222222' }], exclude: [] },
      sender: { senderIdentityId: null, fromName: 'Acme Team', replyTo: 'hello@acme.test' },
      messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Hello', preheader: '', body: { format: 'text', text: 'Body' } } }],
      tracking: { opens: false, clicks: false },
      compliance: { unsubscribeLink: 'required', listUnsubscribeHeader: 'required' },
      personalization: { mode: 'none' },
      schedule: { mode: 'at', sendAt: '2026-10-04T22:00:00.000Z', timezone: 'Asia/Kolkata' },
      abTest: null,
    });
  });

  it('send-now snapshots have no send time', () => {
    expect(buildVersionSnapshot(readyDraft(), { mode: 'now', sendAt: null, timezone: 'UTC' }).schedule).toEqual({ mode: 'now', sendAt: null, timezone: 'UTC' });
  });

  it('is immutable: deep-frozen, and later draft edits do not reach it', () => {
    const draft = readyDraft();
    const v = buildVersionSnapshot(draft, at);
    expect(() => {
      (v.messages[0].content as { subject: string }).subject = 'changed';
    }).toThrow(TypeError);
    expect(() => {
      (v.audience.include as unknown[]).push({ type: 'list', listId: 'x' });
    }).toThrow(TypeError);
    (draft.audience.include as unknown[]).push({ type: 'tag', tagId: 'later' });
    expect(v.audience.include).toHaveLength(1);
  });

  it('content hash is deterministic, independent of key order, and changes with content', () => {
    const a = buildVersionSnapshot(readyDraft(), at);
    const b = buildVersionSnapshot(readyDraft(), at);
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash(a)).toMatch(/^[0-9a-f]{64}$/);
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(reverseKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)])) : v;
    const reordered = reverseKeys(a);
    expect(Object.keys(reordered as object)[0]).toBe('abTest');
    expect(canonicalJson(reordered)).toBe(canonicalJson(a));
    expect(contentHash(readVersionSnapshot(reordered))).toBe(contentHash(a));
    const c = buildVersionSnapshot(readyDraft({ name: 'renamed' }), at);
    expect(contentHash(c)).toBe(contentHash(a)); // the campaign name is not part of the version content
    const d = buildVersionSnapshot(readyDraft({ messages: [{ variantKey: 'default', content: { subject: 'Other', body: { text: 'Body' } } }] }), at);
    expect(contentHash(d)).not.toBe(contentHash(a));
  });

  it('refuses to version an incomplete draft', () => {
    expect(() => buildVersionSnapshot(readyDraft({ topicId: null }), at)).toThrow(VersionError);
    expect(() => buildVersionSnapshot(readyDraft({ audience: { include: [], exclude: [] } }), at)).toThrow(VersionError);
    expect(() => buildVersionSnapshot(readyDraft({ messages: [] }), at)).toThrow(VersionError);
    expect(() => buildVersionSnapshot(readyDraft({ channel: 'sms' }), at)).toThrow(VersionError);
    expect(() => buildVersionSnapshot(readyDraft(), { mode: 'at', sendAt: null, timezone: 'UTC' })).toThrow(VersionError);
  });

  it('reading a stored snapshot validates the exact v1 shape and rejects unknown schemas', () => {
    const v = JSON.parse(JSON.stringify(buildVersionSnapshot(readyDraft(), at)));
    expect(readVersionSnapshot(v)).toEqual(v);
    expect(Object.isFrozen(readVersionSnapshot(v))).toBe(true);
    expect(() => readVersionSnapshot({ ...v, schema: 'campaign.version.v9' })).toThrow(/Unknown version schema/);
    expect(() => readVersionSnapshot({ ...v, extra: 1 })).toThrow(/unexpected fields/);
    const { abTest: _omit, ...missing } = v;
    expect(() => readVersionSnapshot(missing)).toThrow(VersionError);
    expect(() => readVersionSnapshot({ ...v, tracking: { opens: true, clicks: false } })).toThrow(/tracking/);
    expect(() => readVersionSnapshot({ ...v, topic: { topicIds: ['a', 'b'], policy: 'block_unsubscribed' } })).toThrow(/topic/);
  });
});

// ─── readiness / pre-flight ──────────────────────────────────────────────────────────────────────────────────

describe('readiness findings', () => {
  const ctx = { now: NOW, deliveryAvailable: true };

  it('a complete draft is ready, with only the Phase 6 sender warning', () => {
    const f = readinessFindings(readyDraft(), ctx);
    expect(f.map((x) => [x.code, x.severity])).toEqual([['SENDER_NOT_CONFIGURED', 'warning']]);
  });

  it('an empty draft reports every missing part with a field pointer', () => {
    const f = readinessFindings(
      readyDraft({ name: '', topicId: null, audience: { include: [], exclude: [] }, messages: [{ variantKey: 'default', content: {} }] }),
      ctx,
    );
    expect(codes(f)).toEqual(['NAME_MISSING', 'TOPIC_MISSING', 'AUDIENCE_EMPTY_DEFINITION', 'SENDER_NOT_CONFIGURED', 'SUBJECT_MISSING', 'BODY_MISSING']);
    expect(f.find((x) => x.code === 'SUBJECT_MISSING')?.field).toBe('/messages/0/content/subject');
  });

  it('audience structure, sender, lengths and schedule rules', () => {
    const list = (i: number) => ({ type: 'list' as const, listId: `l${i}` });
    expect(codes(readinessFindings(readyDraft({ audience: { include: [list(1)], exclude: [list(1)] } }), ctx))).toContain('AUDIENCE_SOURCE_CONFLICT');
    expect(codes(readinessFindings(readyDraft({ audience: { include: Array.from({ length: 26 }, (_, i) => list(i)), exclude: [] } }), ctx))).toContain('AUDIENCE_TOO_MANY_SOURCES');
    expect(codes(readinessFindings(readyDraft({ sender: { senderIdentityId: null, fromName: null, replyTo: 'not-an-email' } }), ctx))).toContain('REPLY_TO_INVALID');
    const long = readyDraft({ messages: [{ variantKey: 'default', content: { subject: 'x'.repeat(201), body: { text: 'y'.repeat(100_001) } } }] });
    expect(codes(readinessFindings(long, ctx))).toEqual(expect.arrayContaining(['SUBJECT_TOO_LONG', 'BODY_TOO_LONG']));
    const sched = (sendAt: string | null, timezone = 'UTC') => codes(readinessFindings(readyDraft({ schedule: { mode: 'at', sendAt, timezone } }), ctx));
    expect(sched('2026-10-03T11:58:00Z')).toContain('SCHEDULE_IN_PAST');
    expect(sched('2026-10-03T11:59:30Z')).not.toContain('SCHEDULE_IN_PAST'); // within the 1-minute tolerance
    expect(sched(null)).toContain('SCHEDULE_IN_PAST');
    expect(sched('2027-10-04T12:00:00Z')).toContain('SCHEDULE_TOO_FAR');
    expect(sched('2026-10-04T12:00:00Z', 'Mars/Olympus')).toContain('TIMEZONE_INVALID');
  });

  it('unconfigured channels and disabled delivery are explicit errors', () => {
    // Messaging amendment: SMS / WhatsApp are implemented, and AVAILABLE only where their provider is configured.
    expect(codes(readinessFindings(readyDraft({ channel: 'sms' }), { ...ctx, channelAvailable: false }))).toContain('CHANNEL_NOT_AVAILABLE');
    expect(codes(readinessFindings(readyDraft({ channel: 'sms' }), { ...ctx, channelAvailable: true }))).not.toContain('CHANNEL_NOT_AVAILABLE');
    expect(channelSpec('whatsapp').enabled).toBe(true);
    const off = { mode: 'disabled', smsConfigured: false, whatsappConfigured: false };
    expect(isChannelAvailable('email', off)).toBe(true);
    expect(isChannelAvailable('sms', off)).toBe(false);
    expect(isChannelAvailable('whatsapp', off)).toBe(false);
    expect(isChannelAvailable('sms', { ...off, smsConfigured: true })).toBe(true);
    expect(isChannelAvailable('whatsapp', { ...off, smsConfigured: true })).toBe(false);
    expect(isChannelAvailable('whatsapp', { ...off, mode: 'test' })).toBe(true);
    const f = readinessFindings(readyDraft(), { now: NOW, deliveryAvailable: false });
    expect(f.find((x) => x.code === 'DELIVERY_NOT_AVAILABLE')).toMatchObject({ severity: 'error', section: 'delivery' });
  });

  it('pre-flight adds source, size and eligibility checks', () => {
    const base = { topic: 'ok' as const, sources: [], audience: { size: 1000, capped: false }, eligibility: { estimate: 900, sampleSize: 1000 } };
    expect(codes(preflightFindings(readyDraft(), base, ctx))).toEqual(['SENDER_NOT_CONFIGURED']);
    const sel = { type: 'list' as const, listId: 'l1' };
    const f = preflightFindings(readyDraft(), { ...base, topic: 'unavailable', sources: [{ role: 'include', selector: sel, status: 'not_found' }, { role: 'include', selector: { type: 'tag', tagId: 'g' }, status: 'archived' }] }, ctx);
    expect(f.map((x) => [x.code, x.severity])).toEqual(expect.arrayContaining([['TOPIC_UNAVAILABLE', 'error'], ['AUDIENCE_SOURCE_NOT_FOUND', 'error'], ['AUDIENCE_SOURCE_ARCHIVED', 'warning']]));
    expect(codes(preflightFindings(readyDraft(), { ...base, audience: { size: 0, capped: false } }, ctx))).toContain('AUDIENCE_EMPTY');
    expect(codes(preflightFindings(readyDraft(), { ...base, audience: { size: 5_000_000, capped: true } }, ctx))).toContain('AUDIENCE_TOO_LARGE');
    expect(codes(preflightFindings(readyDraft(), { ...base, eligibility: { estimate: 0, sampleSize: 2000 } }, ctx))).toContain('NO_ELIGIBLE_RECIPIENTS');
    const low = preflightFindings(readyDraft(), { ...base, eligibility: { estimate: 300, sampleSize: 2000 } }, ctx).find((x) => x.code === 'LOW_ELIGIBLE_SHARE');
    expect(low?.severity).toBe('warning');
  });

  it('findings never carry personal data, only ids and counts', () => {
    const f = preflightFindings(readyDraft({ sender: { senderIdentityId: null, fromName: 'Private Person', replyTo: 'private@person.test' } }), { topic: 'ok', sources: [], audience: { size: 10, capped: false }, eligibility: { estimate: 1, sampleSize: 10 } }, ctx);
    expect(JSON.stringify(f)).not.toMatch(/Private Person|private@person/);
  });

  it('sections summarize to pass / warning / error', () => {
    const s = summarize(readinessFindings(readyDraft({ name: '' }), ctx));
    expect(s.sections).toMatchObject({ details: 'error', sender: 'warning', message: 'pass', audience: 'pass' });
  });

  it('start checks report the configuration failure to record', () => {
    expect(startFailure({ channelEnabled: true, topic: 'ok', deliveryAvailable: true })).toBeNull();
    expect(startFailure({ channelEnabled: true, topic: 'unavailable', deliveryAvailable: true })).toBe('TOPIC_UNAVAILABLE');
    expect(startFailure({ channelEnabled: true, topic: 'ok', deliveryAvailable: false })).toBe('DELIVERY_NOT_AVAILABLE');
  });
});

// ─── execution and recipient machines ────────────────────────────────────────────────────────────────────────

describe('execution state machine', () => {
  const events: ExecutionEvent[] = ['start', 'materialized', 'all_final', 'pause', 'resume', 'cancel', 'fail'];
  const exec = (status: (typeof EXECUTION_STATUSES)[number], pausedPhase: 'materializing' | 'delivering' | null = null, materializedAt: Date | null = null) => ({ status, pausedPhase, materializedAt });

  it('follows the contract path and remembers the paused phase', () => {
    expect(nextExecutionState(exec('pending'), 'start')).toMatchObject({ ok: true, status: 'materializing' });
    expect(nextExecutionState(exec('materializing'), 'pause')).toEqual({ ok: true, status: 'paused', pausedPhase: 'materializing' });
    expect(nextExecutionState(exec('paused', 'materializing'), 'resume')).toMatchObject({ status: 'materializing' });
    expect(nextExecutionState(exec('paused', 'delivering'), 'resume')).toMatchObject({ status: 'delivering' });
    expect(nextExecutionState(exec('materializing'), 'materialized')).toMatchObject({ status: 'delivering' });
    expect(nextExecutionState(exec('delivering'), 'all_final')).toMatchObject({ status: 'completed' });
    expect(nextExecutionState(exec('pending'), 'cancel')).toMatchObject({ status: 'cancelled' });
  });

  it('terminal executions accept nothing', () => {
    for (const s of ['completed', 'cancelled', 'failed'] as const) for (const e of events) expect(nextExecutionState(exec(s), e).ok).toBe(false);
  });

  it('projects onto the campaign lifecycle', () => {
    expect(EXECUTION_STATUSES.map((s) => campaignStatusFor({ status: s }))).toEqual(['scheduled', 'sending', 'sending', 'paused', 'completed', 'cancelled', 'failed']);
    expect(campaignStatusFor(null)).toBe('draft');
  });

  it('snapshot release guard: never while materialization can still read it, and permanent once true', () => {
    expect(isSnapshotReleasable(exec('materializing'))).toBe(false);
    expect(isSnapshotReleasable(exec('paused', 'materializing'))).toBe(false);
    expect(isSnapshotReleasable(exec('delivering', null, NOW))).toBe(true);
    for (const s of ['completed', 'cancelled', 'failed'] as const) expect(isSnapshotReleasable(exec(s))).toBe(true);
    // Permanence: from any releasable state, no event leads back to `materializing`.
    const releasable = [exec('delivering', null, NOW), exec('paused', 'delivering', NOW), exec('completed'), exec('cancelled'), exec('failed')];
    for (const s of releasable) {
      for (const e of events) {
        const t = nextExecutionState(s, e);
        if (t.ok) expect(t.status).not.toBe('materializing');
      }
    }
  });
});

describe('recipient state machine', () => {
  it('final states have no exits; materialization creates only pending or skipped', () => {
    for (const s of RECIPIENT_STATUSES) {
      if (!isRecipientFinal(s)) continue;
      for (const t of RECIPIENT_STATUSES) expect(canRecipientTransition(s, t)).toBe(false);
    }
    expect(canRecipientTransition('queued', 'skipped_at_send')).toBe(true); // Checkpoint B
    expect(canRecipientTransition('skipped', 'pending')).toBe(false); // a skipped contact is never re-added
  });
});

// ─── delivery capability and events ──────────────────────────────────────────────────────────────────────────

describe('delivery mode', () => {
  it('defaults to disabled, refuses test mode outside tests; live is a mode whose requirements config enforces', () => {
    expect(resolveDeliveryMode(undefined, 'production')).toBe('disabled');
    expect(resolveDeliveryMode('disabled', 'production')).toBe('disabled');
    expect(() => resolveDeliveryMode('test', 'production')).toThrow(/NODE_ENV=test/);
    expect(() => resolveDeliveryMode('test', 'development')).toThrow(/NODE_ENV=test/);
    expect(resolveDeliveryMode('test', 'test')).toBe('test');
    // Owner-authorized 2026-10-09: live is a valid MODE; boot still refuses it without the provider, webhook and DNS
    // settings (config.test.ts "live delivery requirements").
    expect(resolveDeliveryMode('live', 'production')).toBe('live');
    expect(() => resolveDeliveryMode('enabled', 'test')).toThrow(/Unknown/);
  });
});

describe('campaign event contract', () => {
  it('lists exactly the 16 v1 types from docs/events.md', () => {
    expect([...CAMPAIGN_EVENT_TYPES].sort()).toEqual(
      [
        'campaign.audience_materialized',
        'campaign.cancelled',
        'campaign.completed',
        'campaign.created',
        'campaign.deleted',
        'campaign.failed',
        'campaign.paused',
        'campaign.rescheduled',
        'campaign.restored',
        'campaign.resumed',
        'campaign.returned_to_draft',
        'campaign.scheduled',
        'campaign.started',
        'campaign.unscheduled',
        'campaign.updated',
        'campaign.version_created',
      ].sort(),
    );
  });

  it('campaign.started carries the execution id only (no asOf)', () => {
    const started: CampaignEventPayloads['campaign.started'] = { executionId: 'e1' };
    // @ts-expect-error — asOf was removed from the contract in revision 2
    const withAsOf: CampaignEventPayloads['campaign.started'] = { executionId: 'e1', asOf: 'x' };
    expect(Object.keys(started)).toEqual(['executionId']);
    expect(withAsOf).toBeDefined();
  });
});
