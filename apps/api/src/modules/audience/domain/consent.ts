import type { ConsentAction } from '@workeasy/shared';

/**
 * Consent state machines (docs/consent.md). Pure: given the current projection and a requested action, decide the
 * new state or refuse. The caller appends the immutable event and updates the projection in one transaction.
 */
/** Stored channel states. */
export type StoredChannelState = 'none' | 'pending' | 'granted' | 'withdrawn';
/** Effective state: a stored `pending` older than the workspace's pending-expiry period is `expired` (derived). */
export type ChannelState = StoredChannelState | 'expired';
export type TopicState = 'none' | 'subscribed' | 'unsubscribed';
export type ActorType = 'contact' | 'user' | 'system' | 'api_key';
/** Who last changed a projection (as stored): contact | user | system. */
export type ChangedBy = 'contact' | 'user' | 'system';

export type Transition<S> =
  | { ok: true; newState: S }
  | { ok: false; code: 'SELF_UNSUBSCRIBED' | 'INVALID_TRANSITION' | 'NO_CHANGE'; message: string };

export const changedByOf = (actor: ActorType): ChangedBy => (actor === 'api_key' ? 'user' : actor);

/**
 * Pending consent expires [OUR_ORIGINAL_DESIGN]: a double opt-in request not confirmed within the workspace's
 * `pending_expiry_days` (measured from the SERVER time it was recorded) is `expired`. Derived on read — no job rewrites
 * anything — so it is exact at every moment and needs no scheduler. An expired request never qualifies a contact and
 * can no longer be confirmed; a new request or a new grant starts over.
 */
export function effectiveChannelState(stored: StoredChannelState, recordedAt: Date | null, pendingExpiryDays: number, now: Date = new Date()): ChannelState {
  if (stored === 'pending' && recordedAt && now.getTime() - recordedAt.getTime() > pendingExpiryDays * 86_400_000) return 'expired';
  return stored;
}

/**
 * Channel consent.
 *   subscribed  → granted   (single opt-in, or recorded by staff with evidence)
 *   pending     → pending   (double opt-in requested)
 *   confirmed   → granted   (double opt-in confirmed — only from a pending request that has not expired)
 *   unsubscribed→ withdrawn (the contact said no — recorded even when no consent existed, as evidence of the opt-out)
 *   revoked     → withdrawn (withdrawn by staff/system, e.g. compliance; a no-op when nothing was granted or requested)
 *
 * Self-unsubscribe is sticky [Zoho's rule for the subscription type, ZOHO_PARITY; applying it to channel consent is
 * OUR_ORIGINAL_DESIGN]: when the contact withdrew themselves, only the contact can grant again.
 * Transitions are evaluated on the EFFECTIVE state (see effectiveChannelState).
 */
export function nextChannelState(current: ChannelState, lastChangedBy: ChangedBy | null, action: ConsentAction, actor: ActorType): Transition<StoredChannelState> {
  const grantsAgain = action === 'subscribed' || action === 'pending' || action === 'confirmed';
  if (current === 'withdrawn' && lastChangedBy === 'contact' && grantsAgain && actor !== 'contact') {
    return { ok: false, code: 'SELF_UNSUBSCRIBED', message: 'This person unsubscribed themselves. Only they can opt in again.' };
  }
  switch (action) {
    case 'subscribed':
      return current === 'granted' ? noChange() : { ok: true, newState: 'granted' };
    case 'pending':
      return current === 'granted' || current === 'pending' ? noChange() : { ok: true, newState: 'pending' };
    case 'confirmed':
      if (current === 'pending') return { ok: true, newState: 'granted' };
      if (current === 'expired') return { ok: false, code: 'INVALID_TRANSITION', message: 'This consent request expired. Request consent again.' };
      return { ok: false, code: 'INVALID_TRANSITION', message: 'Only a pending (double opt-in) consent can be confirmed' };
    case 'unsubscribed':
      return current === 'withdrawn' ? noChange() : { ok: true, newState: 'withdrawn' };
    case 'revoked':
      return current === 'withdrawn' || current === 'none' ? noChange() : { ok: true, newState: 'withdrawn' };
  }
}

/** Topic preference: subscribe/unsubscribe, with the same sticky self-unsubscribe rule. */
export function nextTopicState(current: TopicState, lastChangedBy: ChangedBy | null, status: 'subscribed' | 'unsubscribed', actor: ActorType): Transition<TopicState> {
  if (current === status) return noChange();
  if (status === 'subscribed' && current === 'unsubscribed' && lastChangedBy === 'contact' && actor !== 'contact') {
    return { ok: false, code: 'SELF_UNSUBSCRIBED', message: 'This person unsubscribed from this topic themselves. Only they can resubscribe.' };
  }
  return { ok: true, newState: status };
}

/** Subscription type (administrative status) [ZOHO_PARITY]: a self-unsubscribed contact stays unsubscribed. */
export function canChangeSubscription(current: string, unsubscribedBy: string | null, next: string, actor: ActorType): Transition<string> {
  if (current === next) return noChange();
  if (current === 'unsubscribed' && unsubscribedBy === 'contact' && actor !== 'contact') {
    return { ok: false, code: 'SELF_UNSUBSCRIBED', message: 'This person unsubscribed themselves. Only they can resubscribe.' };
  }
  return { ok: true, newState: next };
}

/** Staff-recorded grants must carry evidence; a bare click is not proof of consent [OUR_IMPROVEMENT]. */
export function evidenceProblems(action: ConsentAction, actor: ActorType, lawfulBasis: string | undefined, note: string | undefined, reference: string | undefined): string[] {
  if (actor === 'contact' || (action !== 'subscribed' && action !== 'confirmed')) return [];
  const problems: string[] = [];
  if (!lawfulBasis) problems.push('Choose the lawful basis');
  if (!note && !reference) problems.push('Describe how consent was collected, or give a reference');
  return problems;
}

function noChange<S>(): Transition<S> {
  return { ok: false, code: 'NO_CHANGE', message: 'Nothing to change' };
}
