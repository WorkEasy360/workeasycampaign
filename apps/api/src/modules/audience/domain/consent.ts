import type { ConsentAction } from '@workeasy/shared';

/**
 * Consent state machines (docs/consent.md). Pure: given the current projection and a requested action, decide the
 * new state or refuse. The caller appends the immutable event and updates the projection in one transaction.
 */
export type ChannelState = 'none' | 'pending' | 'granted' | 'withdrawn';
export type TopicState = 'none' | 'subscribed' | 'unsubscribed';
export type ActorType = 'contact' | 'user' | 'system' | 'api_key';
/** Who last changed a projection (as stored): contact | user | system. */
export type ChangedBy = 'contact' | 'user' | 'system';

export type Transition<S> =
  | { ok: true; newState: S }
  | { ok: false; code: 'SELF_UNSUBSCRIBED' | 'INVALID_TRANSITION' | 'NO_CHANGE'; message: string };

export const changedByOf = (actor: ActorType): ChangedBy => (actor === 'api_key' ? 'user' : actor);

/**
 * Channel consent.
 *   subscribed  → granted  (single opt-in, or recorded by staff with evidence)
 *   pending     → pending  (double opt-in requested)
 *   confirmed   → granted  (double opt-in confirmed — only from pending)
 *   unsubscribed→ withdrawn (the contact withdrew)
 *   revoked     → withdrawn (withdrawn by staff/system, e.g. compliance or an expired pending request)
 *
 * Self-unsubscribe is sticky [ZOHO_PARITY rule, applied to channel consent as OUR_IMPROVEMENT]: when the contact
 * withdrew themselves, only the contact can grant again (subscribed/pending/confirmed by actor "contact").
 */
export function nextChannelState(current: ChannelState, lastChangedBy: ChangedBy | null, action: ConsentAction, actor: ActorType): Transition<ChannelState> {
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
      return current === 'pending'
        ? { ok: true, newState: 'granted' }
        : { ok: false, code: 'INVALID_TRANSITION', message: 'Only a pending (double opt-in) consent can be confirmed' };
    case 'unsubscribed':
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
