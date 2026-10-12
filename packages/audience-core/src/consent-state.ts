/**
 * Effective channel-consent state (docs/consent.md). Moved unchanged from apps/api audience domain (milestone 6.2) so
 * every reader — API, campaigns, the future delivery worker — derives it identically.
 */
/** Stored channel states. */
export type StoredChannelState = 'none' | 'pending' | 'granted' | 'withdrawn';
/** Effective state: a stored `pending` older than the workspace's pending-expiry period is `expired` (derived). */
export type ChannelState = StoredChannelState | 'expired';

/** Pending-expiry period when a workspace has no explicit policy (docs/consent.md §Retention). */
export const DEFAULT_PENDING_EXPIRY_DAYS = 7;

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
